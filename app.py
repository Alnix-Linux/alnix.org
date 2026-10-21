"""Alnix website server.

Serves the single-page site, the JSON API it reads from and the pacman repo.

Packages come from the repo on disk (directory configurable through env vars):

    repo/<arch>/alnix.db            repo-add database (gz, xz, bz2 or zst)
    repo/<arch>/*.pkg.tar.*         packages

The ISO lives on Cloudflare R2. isolink.txt in the GitHub repo lists its URL,
plus its .sha256 and .asc, one "linkN: <url>" per line.

Run locally:   python3 app.py
Production:    gunicorn app:app  (ideally behind nginx serving /repo)
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
from email.message import Message
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory
from werkzeug.exceptions import HTTPException

ROOT = Path(__file__).resolve().parent
REPO_DIR = Path(os.environ.get("ALNIX_REPO_DIR", ROOT / "repo")).resolve()
REPO_NAME = os.environ.get("ALNIX_REPO_NAME", "alnix")
ISO_LINKS_URL = os.environ.get(
    "ALNIX_ISO_LINKS_URL", "https://raw.githubusercontent.com/Alnix-Linux/Alnix/main/isolink.txt"
)
RELEASE_TTL = 300  # seconds before isolink.txt is checked again

SPA_ROUTES = ("/", "/packages", "/packages/<name>", "/pacman", "/devs", "/contact")
ISO_VERSION = re.compile(rf"^{re.escape(REPO_NAME)}-(?P<version>.+?)(?:-(?:x86_64|aarch64))?\.iso$")
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

Package = dict[str, Any]
Release = dict[str, Any]

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()


# pacman repo


# fields from a repo-add "desc" file that hold lists rather than one value
_LIST_FIELDS = {"DEPENDS", "LICENSE", "GROUPS", "PROVIDES", "CONFLICTS", "REPLACES", "OPTDEPENDS", "MAKEDEPENDS"}


def _parse_desc(text: str) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    key: str | None = None
    for line in text.splitlines():
        if line.startswith("%") and line.endswith("%"):
            key = line.strip("%")
            fields[key] = []
        elif line and key:
            fields[key].append(line)
        else:
            key = None
    return fields


def open_tar(path: Path) -> tarfile.TarFile:
    data = path.read_bytes()
    if data.startswith(ZSTD_MAGIC):
        # tarfile can't read zstd before Python 3.14, so use the zstd CLI
        if not shutil.which("zstd"):
            raise RuntimeError(f"{path.name} is zstd-compressed but the zstd command isn't installed")
        data = subprocess.run(["zstd", "-dcq"], input=data, capture_output=True, check=True).stdout
    return tarfile.open(fileobj=io.BytesIO(data), mode="r:*")


def _to_int(v: str | None) -> int | None:
    return int(v) if v and v.isdigit() else None


def _package_from_desc(fields: dict[str, list[str]], arch_dir: str) -> Package:
    one = lambda k: fields.get(k, [None])[0]  # noqa: E731
    filename = one("FILENAME")
    return {
        "name": one("NAME"),
        "version": one("VERSION"),
        "description": one("DESC"),
        "arch": one("ARCH"),
        "url": one("URL"),
        "packager": one("PACKAGER"),
        "build_date": _to_int(one("BUILDDATE")),
        "size_bytes": _to_int(one("CSIZE")),
        "installed_size_bytes": _to_int(one("ISIZE")),
        "filename": filename,
        "sha256": one("SHA256SUM"),
        "depends": fields.get("DEPENDS", []),
        "download_url": f"/repo/{arch_dir}/{filename}" if filename else None,
    }


_pkg_cache: tuple[tuple[tuple[str, float], ...], list[Package]] | None = None


def load_packages() -> list[Package]:
    """Read every <arch>/<repo>.db, re-parsing only when one changes."""
    global _pkg_cache
    dbs = sorted(p for p in REPO_DIR.glob(f"*/{REPO_NAME}.db") if p.is_file())
    stamp = tuple((str(p), p.stat().st_mtime) for p in dbs)
    with _lock:
        if _pkg_cache and _pkg_cache[0] == stamp:
            return _pkg_cache[1]
        packages: list[Package] = []
        for db in dbs:
            with open_tar(db) as tar:
                for member in tar:
                    if member.isfile() and member.name.endswith("/desc"):
                        text = tar.extractfile(member).read().decode("utf-8", "replace")
                        packages.append(_package_from_desc(_parse_desc(text), db.parent.name))
        _pkg_cache = (stamp, packages)
        return packages


# releases


_release_lock = threading.Lock()
_release_cache: tuple[float, list[Release]] | None = None


def _fetch(url: str, method: str = "GET") -> tuple[bytes, Message]:
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "alnix.org"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.read(), res.headers


def _fetch_releases() -> list[Release]:
    text = _fetch(ISO_LINKS_URL)[0].decode()
    # "link1: https://..." lines; tell the files apart by extension, not by label
    links = [line.split(":", 1)[1].strip() for line in text.splitlines() if ":" in line]
    by_ext = {ext: next((u for u in links if u.endswith(ext)), None) for ext in (".iso", ".sha256", ".asc")}
    iso_url = by_ext[".iso"]
    if not iso_url:
        return []

    _, headers = _fetch(iso_url, "HEAD")
    filename = iso_url.rsplit("/", 1)[-1]
    match = ISO_VERSION.match(filename)
    modified = headers.get("Last-Modified")
    sha256 = _fetch(by_ext[".sha256"])[0].decode().split()[0] if by_ext[".sha256"] else None
    return [{
        "version": match["version"] if match else filename.removesuffix(".iso"),
        "date": parsedate_to_datetime(modified).date().isoformat() if modified else None,
        "size_bytes": int(headers.get("Content-Length", 0)) or None,
        "sha256": sha256,
        "filename": filename,
        "url": iso_url,
        "sig_url": by_ext[".asc"],
    }]


def load_releases() -> list[Release]:
    """The release listed in isolink.txt, cached for RELEASE_TTL seconds."""
    global _release_cache
    with _release_lock:
        if _release_cache and time.monotonic() - _release_cache[0] < RELEASE_TTL:
            return _release_cache[1]
        try:
            releases = _fetch_releases()
        except (OSError, ValueError) as err:
            if _release_cache:
                # GitHub or R2 hiccup: keep serving the last good answer
                app.logger.warning("Couldn't refresh releases, serving cached: %s", err)
                return _release_cache[1]
            app.logger.error("Couldn't fetch releases: %s", err)
            abort(502, "Couldn't look up the latest release.")
        _release_cache = (time.monotonic(), releases)
        return releases


# api


@app.get("/api/releases")
def api_releases() -> Response:
    return jsonify(load_releases())


@app.get("/api/releases/latest")
def api_latest_release() -> Response:
    releases = load_releases()
    if not releases:
        abort(404, "There is no release yet.")
    return jsonify(releases[0])


@app.get("/api/packages")
def api_packages() -> Response:
    return jsonify(load_packages())


@app.get("/api/packages/<name>")
def api_package(name: str) -> Response:
    matches = [p for p in load_packages() if p["name"] == name]
    if not matches:
        abort(404, f"No package called {name}.")
    # same package built for several arches: prefer x86_64
    matches.sort(key=lambda p: p["arch"] != "x86_64")
    return jsonify(matches[0])


# files


@app.get("/repo/<path:path>")
def repo_file(path: str) -> Response:
    return send_from_directory(REPO_DIR, path)


@app.get("/assets/<path:path>")
def asset(path: str) -> Response:
    return send_from_directory(ROOT / "assets", path)


@app.get("/favicon.svg")
@app.get("/robots.txt")
def root_file() -> Response:
    return send_from_directory(ROOT, request.path.lstrip("/"))


# site


def spa(**_route_args: str) -> Response:
    return send_from_directory(ROOT, "index.html")


for rule in SPA_ROUTES:
    app.add_url_rule(rule, view_func=spa, endpoint=f"spa:{rule}", strict_slashes=False)


@app.get("/<page>.html")
def legacy_page(page: str) -> Response:
    """Old links like /contact.html go to /contact."""
    if f"/{page}" in SPA_ROUTES:
        return redirect(f"/{page}", 301)
    if page == "index":
        return redirect("/", 301)
    abort(404)


@app.errorhandler(HTTPException)
def handle_http_error(err: HTTPException) -> Response | tuple[Response, int]:
    if request.path.startswith("/api/"):
        return jsonify(error=err.description), err.code
    if err.code == 404 and request.method == "GET" and "." not in request.path.rsplit("/", 1)[-1]:
        # let the client router show its own "Page not found"
        return spa(), 404
    return err


@app.errorhandler(Exception)
def handle_error(err: Exception) -> Response | tuple[Response, int]:
    app.logger.exception("Unhandled error on %s", request.path)
    if request.path.startswith("/api/"):
        return jsonify(error="Something went wrong on the server."), 500
    return Response("Internal server error", 500)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8000)), debug=True)
