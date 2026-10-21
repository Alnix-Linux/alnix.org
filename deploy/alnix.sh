#!/usr/bin/env bash
# Set up and deploy alnix.org on a Debian/Ubuntu VPS.
#
#   sudo bash alnix.sh setup      # one-time: packages, firewall, Samba, systemd, nginx, TLS
#   sudo bash alnix.sh deploy     # install /srv/alnix/upload/alnix.org.zip and restart
#   sudo bash alnix.sh lock-ssh   # close public SSH (run while connected over Tailscale)
#
# Run as root, or with sudo from your normal account. With sudo, your account
# owns the code and is the Samba user; as root, a no-login "alnix-deploy"
# account is used instead. Safe to re-run; each step skips what's already done.

set -euo pipefail

DOMAIN="${DOMAIN:-alnix.org}"
BASE=/srv/alnix
APP=$BASE/app
UPLOAD=$BASE/upload
VENV=$BASE/venv
CERTS=/etc/ssl/alnix
SSH_LOCKED=$BASE/.ssh-locked
LOGIN_USER="${SUDO_USER:-root}"  # the account you're logged in as
OWNER="${SUDO_USER:-alnix-deploy}"
[[ $OWNER == root ]] && OWNER=alnix-deploy

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need_root() {
  [[ $EUID -eq 0 ]] || die "run with sudo: sudo bash $0 $*"
  if ! id "$OWNER" >/dev/null 2>&1; then
    [[ $OWNER == alnix-deploy ]] || die "user $OWNER doesn't exist"
    useradd --system --create-home --home-dir /var/lib/alnix-deploy --shell /usr/sbin/nologin alnix-deploy
  fi
}

has_keys() { [[ -s $(getent passwd "$1" | cut -d: -f6)/.ssh/authorized_keys ]]; }

as_owner() { sudo -u "$OWNER" -- "$@"; }

# Reads a pasted PEM block from the terminal until its -----END line.
read_pem() {
  local line out=""
  while IFS= read -r line </dev/tty; do
    out+="$line"$'\n'
    [[ $line == -----END* ]] && break
  done
  printf '%s' "$out"
}

# setup steps

install_packages() {
  say "Installing packages"
  command -v apt-get >/dev/null || die "this script supports Debian/Ubuntu only"
  # finish any install that was interrupted earlier, or apt refuses to run
  DEBIAN_FRONTEND=noninteractive dpkg --configure -a
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -yq \
    nginx python3-venv samba unzip rsync ufw unattended-upgrades curl
  echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
  dpkg-reconfigure -f noninteractive unattended-upgrades
  tailscale ip -4 >/dev/null 2>&1 || die "Tailscale isn't running here. Install it and run 'tailscale up' first."
}

create_app() {
  say "Creating the alnix user, folders and Python environment"
  id alnix >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin alnix
  install -d -m 755 "$BASE"
  install -d -m 755 -o "$OWNER" -g "$OWNER" "$APP" "$UPLOAD"
  [[ -x $VENV/bin/gunicorn ]] || {
    install -d -o "$OWNER" -g "$OWNER" "$VENV"
    as_owner python3 -m venv "$VENV"
    as_owner "$VENV/bin/pip" install -q flask gunicorn
  }
}

setup_samba() {
  say "Configuring the Samba upload share (Tailscale only)"
  [[ -f /etc/samba/smb.conf.orig ]] || cp /etc/samba/smb.conf /etc/samba/smb.conf.orig
  cat >/etc/samba/smb.conf <<EOF
# Managed by alnix.sh. The original is in smb.conf.orig.
[global]
   # Samba won't bind to tailscale0 (a point-to-point tun device), so it listens
   # everywhere and only accepts Tailscale addresses; ufw also drops 445 publicly
   hosts allow = 127.0.0.1 ::1 100.64.0.0/10 fd7a:115c:a1e0::/48
   hosts deny = ALL
   server min protocol = SMB3
   # macOS asks for a DFS referral first, which Samba 4.19 fails on for an IP
   # address, and Finder then reports the share as missing
   host msdfs = no
   map to guest = never
   load printers = no

[upload]
   path = $UPLOAD
   valid users = $OWNER
   read only = no
EOF
  if ! pdbedit -L 2>/dev/null | grep -q "^$OWNER:"; then
    echo "Choose a Samba password for $OWNER (used when connecting from Finder):"
    smbpasswd -a "$OWNER" </dev/tty
  fi
  systemctl restart smbd
  ss -tln | grep -q ':445 ' || die "Samba isn't listening on port 445. Check: systemctl status smbd"
}

setup_service() {
  say "Installing the alnix systemd service"
  cat >/etc/systemd/system/alnix.service <<EOF
[Unit]
Description=Alnix website
After=network-online.target
Wants=network-online.target

[Service]
User=alnix
Group=alnix
WorkingDirectory=$APP
ExecStart=$VENV/bin/gunicorn --workers 2 --bind 127.0.0.1:8000 app:app
Restart=on-failure

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=true
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable alnix
  [[ -f $APP/app.py ]] && systemctl restart alnix || echo "No site yet, so the service will start on the first deploy."
}

setup_certs() {
  say "TLS certificate"
  install -d -m 700 "$CERTS"
  if [[ -s $CERTS/cert.pem && -s $CERTS/key.pem ]]; then
    echo "Already installed in $CERTS."
    return
  fi
  echo "In Cloudflare: SSL/TLS -> Origin Server -> Create Certificate, and set SSL/TLS mode to Full (strict)."
  echo "Paste the Origin Certificate (the -----BEGIN CERTIFICATE----- block):"
  read_pem >"$CERTS/cert.pem"
  echo "Paste the Private Key (the -----BEGIN PRIVATE KEY----- block):"
  read_pem >"$CERTS/key.pem"
  chmod 600 "$CERTS/key.pem"
  grep -q 'END CERTIFICATE' "$CERTS/cert.pem" && grep -q 'END PRIVATE KEY' "$CERTS/key.pem" \
    || { rm -f "$CERTS"/*.pem; die "that didn't look like a certificate and key; run setup again"; }
}

setup_nginx() {
  say "Configuring nginx"
  cat >/etc/nginx/sites-available/alnix <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    # "listen ... http2" rather than "http2 on" so it works on nginx < 1.25 (Ubuntu 24.04)
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     $CERTS/cert.pem;
    ssl_certificate_key $CERTS/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    server_tokens off;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https://gravatar.com https://*.gravatar.com; frame-ancestors 'none'; base-uri 'none'" always;

    if (\$request_method !~ ^(GET|HEAD)\$) { return 405; }

    # only these paths are served from disk, so app.py etc. are never exposed
    location /assets/ { alias $APP/assets/; expires 1h; }
    location /repo/   { alias $APP/repo/; autoindex on; }
    location = /favicon.svg { root $APP; }
    location = /robots.txt  { root $APP; }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/alnix /etc/nginx/sites-enabled/alnix
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl reload nginx
}

setup_firewall() {
  say "Configuring the firewall (web from Cloudflare only, everything else over Tailscale)"
  local v4 v6 ip
  v4=$(curl -fsS https://www.cloudflare.com/ips-v4) || die "couldn't download Cloudflare's IP list"
  v6=$(curl -fsS https://www.cloudflare.com/ips-v6) || die "couldn't download Cloudflare's IP list"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow in on tailscale0 >/dev/null
  [[ -f $SSH_LOCKED ]] || ufw allow OpenSSH >/dev/null
  ufw delete allow 'Nginx Full' >/dev/null 2>&1 || true
  for ip in $v4 $v6; do
    ufw allow proto tcp from "$ip" to any port 80,443 comment cloudflare >/dev/null
  done
  ufw --force enable
}

harden_ssh() {
  say "Hardening SSH"
  local conf=/etc/ssh/sshd_config.d/10-alnix.conf
  # never lock out the account running this: root keeps key login unless
  # you're on a sudo account, and passwords stay on until you have a key
  {
    if [[ $LOGIN_USER != root ]] && has_keys "$LOGIN_USER"; then
      echo "PermitRootLogin no"
    else
      echo "PermitRootLogin prohibit-password"
    fi
    if has_keys "$LOGIN_USER"; then
      echo "PasswordAuthentication no"
      echo "KbdInteractiveAuthentication no"
    fi
  } >"$conf"
  has_keys "$LOGIN_USER" \
    || warn "$LOGIN_USER has no SSH key, so password login is left on. Add one to ~/.ssh/authorized_keys and re-run setup to turn it off."
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
}

# commands

cmd_setup() {
  need_root setup
  install_packages
  create_app
  setup_samba
  setup_service
  setup_certs
  setup_nginx
  setup_firewall
  harden_ssh
  say "Setup done"
  echo "Next:"
  echo "  1. On your Mac, connect to smb://$(tailscale ip -4)/upload and copy alnix.org.zip into it."
  echo "  2. Here, run: sudo bash $0 deploy"
  [[ -f $SSH_LOCKED ]] || echo "  3. Once you've confirmed SSH over Tailscale works, run: sudo bash $0 lock-ssh"
}

cmd_deploy() {
  need_root deploy
  local zip=$UPLOAD/alnix.org.zip staging=$BASE/staging
  [[ -f $zip ]] || die "no $zip yet. Copy it to the upload share first."
  say "Unpacking $(basename "$zip")"
  rm -rf "$staging"
  install -d -o "$OWNER" -g "$OWNER" "$staging"
  as_owner unzip -q "$zip" -d "$staging"
  [[ -f $staging/alnix.org/app.py ]] || die "the zip doesn't contain alnix.org/app.py. Make it from ~/Documents with: zip -rqX alnix.org.zip alnix.org"
  say "Installing to $APP"
  as_owner rsync -a --delete "$staging/alnix.org/" "$APP/"
  rm -rf "$staging"
  systemctl restart alnix
  say "Checking the site"
  local i
  for i in {1..15}; do
    curl -fsS -o /dev/null localhost:8000/api/packages 2>/dev/null && break
    sleep 1
  done
  curl -fsS localhost:8000/api/packages >/dev/null || { journalctl -u alnix -n 30 --no-pager; die "the app didn't start"; }
  echo "Packages: $(curl -fsS localhost:8000/api/packages | grep -o '"name"' | wc -l)"
  echo "Release:  $(curl -sS localhost:8000/api/releases/latest | grep -o '"version":"[^"]*"' || echo 'not available')"
  echo "Deployed."
}

cmd_lock_ssh() {
  need_root lock-ssh
  # sudo drops SSH_CONNECTION, so fall back to the login record for this terminal
  local client=${SSH_CONNECTION:-} second
  client=${client%% *}
  [[ -n $client ]] || client=$(who -m | sed -n 's/.*(\([^)]*\)).*/\1/p')
  second=$(cut -d. -f2 <<<"$client")
  # Tailscale addresses are 100.64.0.0/10
  [[ $client == 100.* && $second -ge 64 && $second -le 127 ]] \
    || die "you're connected from ${client:-a local console}, not Tailscale. Reconnect with ssh $LOGIN_USER@$(tailscale ip -4) and try again."
  ufw delete allow OpenSSH >/dev/null 2>&1 || true
  touch "$SSH_LOCKED"
  echo "Public SSH closed. SSH now only works over Tailscale ($(tailscale ip -4))."
}

case "${1:-}" in
  setup) cmd_setup ;;
  deploy) cmd_deploy ;;
  lock-ssh) cmd_lock_ssh ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
