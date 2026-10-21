"""Build the pacman repo database, like repo-add, but runs anywhere Python does.

Drop packages into repo/<arch>/ (e.g. repo/x86_64/foo-1.0-1-x86_64.pkg.tar.zst),
then run:

    python3 build_repo.py           # index every arch directory
    python3 build_repo.py --sign    # also gpg-sign unsigned packages and the db

Writes repo/<arch>/alnix.db.tar.gz plus the alnix.db symlink that pacman fetches.
If a package has a .sig next to it, the signature is embedded in the db.
When a directory holds several builds of one package, the newest build wins.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

from app import REPO_DIR, REPO_NAME, open_tar

PKG_GLOB = "*.pkg.tar.*"

# .PKGINFO key -> desc field, in the order repo-add writes them
FIELDS = [
    ("pkgname", "NAME"),
    ("pkgbase", "BASE"),
    ("pkgver", "VERSION"),
    ("pkgdesc", "DESC"),
    ("group", "GROUPS"),
    ("CSIZE", "CSIZE"),
    ("size", "ISIZE"),
    ("SHA256SUM", "SHA256SUM"),
    ("PGPSIG", "PGPSIG"),
    ("url", "URL"),
    ("license", "LICENSE"),
    ("arch", "ARCH"),
    ("builddate", "BUILDDATE"),
    ("packager", "PACKAGER"),
    ("replaces", "REPLACES"),
    ("conflict", "CONFLICTS"),
    ("provides", "PROVIDES"),
    ("depend", "DEPENDS"),
    ("optdepend", "OPTDEPENDS"),
    ("makedepend", "MAKEDEPENDS"),
    ("checkdepend", "CHECKDEPENDS"),
]


def read_pkginfo(pkg: Path) -> dict[str, list[str]]:
    with open_tar(pkg) as tar:
        member = tar.extractfile(".PKGINFO")
        if member is None:
            raise ValueError(f"{pkg.name} has no .PKGINFO")
        text = member.read().decode("utf-8", "replace")
    info: dict[str, list[str]] = {}
    for line in text.splitlines():
        if line.startswith("#") or " = " not in line:
            continue
        key, value = line.split(" = ", 1)
        info.setdefault(key, []).append(value)
    return info


def gpg_sign(path: Path) -> None:
    sig = path.with_name(path.name + ".sig")
    subprocess.run(["gpg", "--batch", "--yes", "--detach-sign", "--output", str(sig), str(path)], check=True)


def desc_for(pkg: Path) -> tuple[str, str]:
    """Return (entry directory name, desc file text) for one package."""
    info = read_pkginfo(pkg)
    data = pkg.read_bytes()
    info["CSIZE"] = [str(len(data))]
    info["SHA256SUM"] = [hashlib.sha256(data).hexdigest()]
    sig = pkg.with_name(pkg.name + ".sig")
    if sig.is_file():
        info["PGPSIG"] = [base64.b64encode(sig.read_bytes()).decode()]

    parts = [f"%FILENAME%\n{pkg.name}\n"]
    for key, field in FIELDS:
        if info.get(key):
            parts.append(f"%{field}%\n" + "\n".join(info[key]) + "\n")
    return f"{info['pkgname'][0]}-{info['pkgver'][0]}", "\n".join(parts) + "\n"


def newest_builds(arch_dir: Path) -> list[Path]:
    """One file per package name, keeping the most recent build date."""
    best: dict[str, tuple[int, Path]] = {}
    for pkg in sorted(arch_dir.glob(PKG_GLOB)):
        if pkg.name.endswith(".sig"):
            continue
        info = read_pkginfo(pkg)
        name, built = info["pkgname"][0], int(info.get("builddate", ["0"])[0])
        if name not in best or built > best[name][0]:
            best[name] = (built, pkg)
    return [pkg for _, pkg in sorted(best.values(), key=lambda b: b[1].name)]


def build(arch_dir: Path, sign: bool) -> int:
    packages = newest_builds(arch_dir)
    if sign:
        for pkg in packages:
            if not pkg.with_name(pkg.name + ".sig").is_file():
                gpg_sign(pkg)

    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for pkg in packages:
            entry, desc = desc_for(pkg)
            folder = tarfile.TarInfo(entry)
            folder.type, folder.mode, folder.mtime = tarfile.DIRTYPE, 0o755, now
            tar.addfile(folder)
            body = desc.encode()
            info = tarfile.TarInfo(f"{entry}/desc")
            info.size, info.mode, info.mtime = len(body), 0o644, now
            tar.addfile(info, io.BytesIO(body))

    db = arch_dir / f"{REPO_NAME}.db.tar.gz"
    tmp = db.with_name(db.name + ".tmp")
    tmp.write_bytes(buf.getvalue())
    os.replace(tmp, db)
    link = arch_dir / f"{REPO_NAME}.db"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(db.name)
    if sign:
        gpg_sign(db)
        sig_link = arch_dir / f"{REPO_NAME}.db.sig"
        if sig_link.is_symlink() or sig_link.exists():
            sig_link.unlink()
        sig_link.symlink_to(db.name + ".sig")

    print(f"{arch_dir.name}: {len(packages)} package{'s' if len(packages) != 1 else ''} -> {db.relative_to(REPO_DIR.parent)}")
    return len(packages)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sign", action="store_true", help="gpg-sign unsigned packages and the database")
    args = parser.parse_args()

    if args.sign and not shutil.which("gpg"):
        sys.exit("--sign needs gpg (brew install gnupg)")
    arch_dirs = sorted(d for d in REPO_DIR.iterdir() if d.is_dir()) if REPO_DIR.is_dir() else []
    if not arch_dirs:
        sys.exit(f"No arch directories in {REPO_DIR}. Put packages in {REPO_DIR / 'x86_64'}/ first.")
    for arch_dir in arch_dirs:
        build(arch_dir, args.sign)
    return 0


if __name__ == "__main__":
    sys.exit(main())
