# alnix.org

The website for [Alnix](https://alnix.org), an Arch-based Linux distribution.

It is a single-page site backed by a small Flask API that serves the package
list from the pacman repository and the latest release information.

## Layout

| Path | What it is |
|------|------------|
| `index.html` | The single page. All routes render into it client-side. |
| `assets/app.js` | The client router, views and API calls. |
| `assets/style.css` | Styles. |
| `app.py` | Flask server: serves the page, the JSON API and the pacman repo. |
| `build_repo.py` | Builds the pacman repo database from packages (a portable `repo-add`). |
| `repo/<arch>/` | The pacman repository. Packages live here on the server, not in git. |
| `deploy/alnix.sh` | One-command setup and deploy for a Debian/Ubuntu VPS. |

## Running locally

```sh
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

The site is then at <http://127.0.0.1:8000>.

### API

| Endpoint | Returns |
|----------|---------|
| `GET /api/packages` | Every package in the repo. |
| `GET /api/packages/<name>` | One package, or 404. |
| `GET /api/releases` | All releases, newest first. |
| `GET /api/releases/latest` | The latest release, or 404. |

Package data is read from `repo/<arch>/alnix.db`. Release data comes from
`isolink.txt` in the [Alnix repo](https://github.com/Alnix-Linux/Alnix), which
points at the ISO on Cloudflare R2. Both are configurable with environment
variables; see the top of [`app.py`](app.py).

## Building the repository

Put packages in `repo/<arch>/`, then:

```sh
python3 build_repo.py          # index the packages
python3 build_repo.py --sign   # also gpg-sign them and the database
```

## Deploying

See [`deploy/alnix.sh`](deploy/alnix.sh). On a fresh Debian/Ubuntu VPS:

```sh
sudo bash alnix.sh setup     # packages, firewall, Samba, systemd, nginx, TLS
sudo bash alnix.sh deploy    # install the uploaded site and restart
```

Production runs behind nginx (TLS, static files) with the app under gunicorn.
