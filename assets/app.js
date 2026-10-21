// api

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJSON(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, "Could not reach the server.");
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, body?.error || `The server returned ${res.status}.`);
  if (body === null) throw new ApiError(res.status, "The server sent an unexpected response.");
  return body;
}

const api = {
  latestRelease: (o) => getJSON("/api/releases/latest", o),
  releases: (o) => getJSON("/api/releases", o),
  packages: (o) => getJSON("/api/packages", o),
  pkg: (name, o) => getJSON(`/api/packages/${encodeURIComponent(name)}`, o),
};

// helpers

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

function parseDate(v) {
  if (v == null || v === "") return null;
  let d;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, day] = v.split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(v);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(v) {
  const d = parseDate(v);
  if (d) return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return v ? esc(v) : "—";
}

function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u, location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

function bindCopyButtons(root) {
  root.querySelectorAll("[data-copy], [data-copy-text]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copyText ?? root.querySelector(btn.dataset.copy)?.textContent ?? "";
      const ok = await copyText(text.trim());
      const label = btn.textContent;
      btn.textContent = ok ? "Copied" : "Copy failed";
      btn.classList.toggle("is-done", ok);
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("is-done");
      }, 1600);
    });
  });
}

// home

function renderHome(main, { signal }) {
  document.title = "Alnix Linux";
  main.innerHTML = `
    <section class="wrap hero">
      <h1>Easy to make, hard to break.</h1>
      <p class="lede">An easy-to-use Linux with KDE Plasma and automatic snapshots.</p>
      <div id="download" aria-live="polite"></div>
    </section>

    <section class="wrap section">
      <dl class="features">
        <div>
          <dt>KDE Plasma</dt>
          <dd>Boots straight into a working desktop.</dd>
        </div>
        <div>
          <dt>Easy installer</dt>
          <dd>Pick a disk, a language and a user. That's it.</dd>
        </div>
        <div>
          <dt>Undo updates</dt>
          <dd>A snapshot is taken before updates, so you can roll back.</dd>
        </div>
      </dl>
    </section>

    <section class="wrap section releases" id="releases" hidden aria-labelledby="releases-title">
      <h2 id="releases-title">Earlier releases</h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Version</th><th>Date</th><th>Size</th><th>SHA-256</th><th><span class="sr-only">Download</span></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  `;
  loadLatest(main.querySelector("#download"), signal);
  loadReleases(main.querySelector("#releases"), signal);
}

function loadLatest(el, signal) {
  el.innerHTML = downloadLoading();
  api.latestRelease({ signal }).then(
    (rel) => {
      el.innerHTML = downloadReady(rel);
      bindCopyButtons(el);
    },
    (err) => {
      if (err.name === "AbortError") return;
      if (err.status === 404) {
        el.innerHTML = downloadNone();
      } else {
        el.innerHTML = downloadError(err.message);
        el.querySelector("[data-retry]").addEventListener("click", () => loadLatest(el, signal));
      }
    }
  );
}

function loadReleases(el, signal) {
  api.releases({ signal }).then(
    (list) => {
      const older = Array.isArray(list) ? list.slice(1) : [];
      if (!older.length) return;
      el.querySelector("tbody").innerHTML = older.map((r) => {
        const url = safeUrl(r.url);
        return `<tr>
          <td><strong>${esc(r.version)}</strong></td>
          <td class="nowrap">${formatDate(r.date)}</td>
          <td class="nowrap">${formatSize(r.size_bytes)}</td>
          <td><code title="${esc(r.sha256)}">${esc(String(r.sha256 ?? "").slice(0, 16))}…</code></td>
          <td>${url ? `<a href="${esc(url)}">Download</a>` : ""}</td>
        </tr>`;
      }).join("");
      el.hidden = false;
    },
    () => {}
  );
}

function downloadLoading() {
  return '<span class="btn btn-big" aria-disabled="true">Finding the latest version…</span>';
}

function downloadReady(rel) {
  const url = safeUrl(rel.url);
  const sig = safeUrl(rel.sig_url);
  const file = rel.filename || "alnix.iso";
  return `
    ${url
      ? `<a class="btn btn-big" href="${esc(url)}" download="${esc(file)}">Download Alnix</a>`
      : '<p class="dl-state">The download link is missing from this release.</p>'}
    <p class="dl-note">Version ${esc(rel.version)}, ${formatSize(rel.size_bytes)}</p>
    <details class="verify">
      <summary>Check your download</summary>
      <div class="verify-body">
        <div class="hash-row"><span>SHA-256 checksum</span><button type="button" class="btn-copy" data-copy="#sha256">Copy</button></div>
        <code class="hash" id="sha256">${esc(rel.sha256)}</code>
        <div class="hash-row"><span>Or check it in a terminal</span><button type="button" class="btn-copy" data-copy="#verify-cmd">Copy</button></div>
        <code class="hash" id="verify-cmd">echo "${esc(rel.sha256)}  ${esc(file)}" | sha256sum -c</code>
        ${sig ? `<p><a href="${esc(sig)}">PGP signature</a></p>` : ""}
      </div>
    </details>`;
}

function downloadNone() {
  return `
    <p class="dl-state">There's no release yet. We're still working on the first ISO, and it'll be here once it's ready.</p>`;
}

function downloadError(msg) {
  return `
    <p class="dl-state">Couldn't load the latest release. ${esc(msg)}</p>
    <p><button type="button" class="btn" data-retry>Try again</button></p>`;
}

// packages

const MAX_ROWS = 300;

function renderPackages(main, { signal, navigate }) {
  document.title = "Packages — Alnix";
  const initial = new URLSearchParams(location.search).get("q") ?? "";
  main.innerHTML = `
    <section class="page-head wrap">
      <h1>Packages</h1>
      <p class="lede">Everything in the Alnix repository. Packages from the official Arch repos aren't listed here.</p>
    </section>
    <section class="wrap">
      <div class="search-bar">
        <label for="pkg-search" class="sr-only">Search packages</label>
        <input id="pkg-search" type="search" placeholder="Search by name or description" autocomplete="off" spellcheck="false" value="${esc(initial)}" disabled>
        <span class="search-count" id="pkg-count" aria-live="polite"></span>
      </div>
      <div id="pkg-results"></div>
    </section>
  `;
  const input = main.querySelector("#pkg-search");
  const results = main.querySelector("#pkg-results");
  const count = main.querySelector("#pkg-count");
  let update = null;

  input.addEventListener("input", () => update?.());
  results.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) {
      input.value = "";
      update?.();
      input.focus();
      return;
    }
    const row = e.target.closest("tr[data-href]");
    if (row && !e.target.closest("a") && !window.getSelection()?.toString()) navigate(row.dataset.href);
  });

  const load = () => {
    results.innerHTML = '<p class="muted">Loading packages…</p>';
    count.textContent = "";
    api.packages({ signal }).then(
      (data) => {
        const all = (Array.isArray(data) ? data : []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!all.length) {
          results.innerHTML = packagesEmpty();
          return;
        }
        input.disabled = false;
        const haystack = all.map((p) => `${p.name} ${p.description ?? ""}`.toLowerCase());
        update = () => {
          const q = input.value.trim();
          const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
          const hits = all.filter((_, i) => terms.every((t) => haystack[i].includes(t)));
          count.textContent = q ? `${hits.length} of ${all.length}` : `${all.length} package${all.length === 1 ? "" : "s"}`;
          results.innerHTML = hits.length ? packagesTable(hits) : packagesNoMatch(q);
          const next = q ? `/packages?q=${encodeURIComponent(q)}` : "/packages";
          if (next !== location.pathname + location.search) history.replaceState(null, "", next);
        };
        update();
      },
      (err) => {
        if (err.name === "AbortError") return;
        results.innerHTML = `
          <div class="state">
            <h2>Couldn't load the package list</h2>
            <p>${esc(err.message)} Please try again in a moment.</p>
            <button type="button" class="btn" data-retry>Try again</button>
          </div>`;
        results.querySelector("[data-retry]").addEventListener("click", load);
      }
    );
  };
  load();
}

function packagesTable(list) {
  return `
    <div class="table-scroll">
      <table class="data-table pkg-table">
        <thead><tr><th>Name</th><th>Version</th><th class="col-desc">Description</th><th class="col-arch">Arch</th><th class="num col-size">Size</th><th class="col-date">Built</th></tr></thead>
        <tbody>
          ${list.slice(0, MAX_ROWS).map((p) => {
            const href = `/packages/${encodeURIComponent(p.name)}`;
            return `<tr data-href="${esc(href)}">
              <td><a href="${esc(href)}" data-link class="pkg-name">${esc(p.name)}</a></td>
              <td><code>${esc(p.version)}</code></td>
              <td class="col-desc">${esc(p.description)}</td>
              <td class="col-arch">${esc(p.arch)}</td>
              <td class="num col-size nowrap">${formatSize(p.size_bytes)}</td>
              <td class="col-date nowrap">${formatDate(p.build_date)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${list.length > MAX_ROWS ? `<p class="muted table-note">Showing the first ${MAX_ROWS} of ${list.length}. Narrow your search to see more.</p>` : ""}`;
}

function packagesEmpty() {
  return `
    <div class="state">
      <h2>No packages yet</h2>
      <p>We're still setting up the Alnix repo and haven't published anything to it.
        Packages will be listed here once we do.</p>
      <p>You can <a href="/pacman" data-link>add the repo to pacman</a> already, so you'll get them when they arrive.</p>
    </div>`;
}

function packagesNoMatch(q) {
  return `
    <div class="state compact">
      <h2>No packages match “${esc(q)}”</h2>
      <p>Try a shorter search. Most software comes from the official Arch repos: <code>pacman -Ss ${esc(q)}</code></p>
      <button type="button" class="btn" data-clear>Clear search</button>
    </div>`;
}

// package detail

function renderPackage(main, { params: [name], signal }) {
  document.title = `${name} — Alnix packages`;
  main.innerHTML = `
    <section class="page-head wrap">
      <a href="/packages" data-link class="back">← All packages</a>
      <h1 class="pkg-title">${esc(name)}</h1>
      <div id="pkg-body"><p class="muted">Loading…</p></div>
    </section>`;
  const body = main.querySelector("#pkg-body");
  const load = () => {
    api.pkg(name, { signal }).then(
      (p) => {
        body.innerHTML = packageDetail(p);
        bindCopyButtons(body);
      },
      (err) => {
        if (err.name === "AbortError") return;
        if (err.status === 404) {
          body.innerHTML = `
            <div class="state compact">
              <h2>Not in the Alnix repo</h2>
              <p>There's no package called <code>${esc(name)}</code> here. If it's a regular Arch package,
                <code>pacman -Si ${esc(name)}</code> will find it in the official repos.</p>
              <a class="btn" href="/packages" data-link>Browse packages</a>
            </div>`;
          return;
        }
        body.innerHTML = `
          <div class="state compact">
            <h2>Couldn't load this package</h2>
            <p>${esc(err.message)} Please try again in a moment.</p>
            <button type="button" class="btn" data-retry>Try again</button>
          </div>`;
        body.querySelector("[data-retry]").addEventListener("click", load);
      }
    );
  };
  load();
}

function packageDetail(p) {
  const upstream = safeUrl(p.url);
  const dl = safeUrl(p.download_url);
  const deps = toList(p.depends);
  const rows = [
    ["Version", `<code>${esc(p.version)}</code>`],
    ["Architecture", esc(p.arch)],
    ["Upstream", upstream ? `<a href="${esc(upstream)}" rel="noopener">${esc(p.url)}</a>` : "—"],
    ["Packager", esc(p.packager || "—")],
    ["Built", formatDate(p.build_date)],
    ["Download size", formatSize(p.size_bytes)],
    ["Installed size", formatSize(p.installed_size_bytes)],
    ["File", p.filename ? `<code>${esc(p.filename)}</code>` : "—"],
  ];
  return `
    <p class="lede">${esc(p.description || "No description provided.")}</p>
    <div class="pkg-actions">
      <div class="install-line">
        <code id="install-cmd">sudo pacman -S ${esc(p.name)}</code>
        <button type="button" class="btn-copy" data-copy="#install-cmd">Copy</button>
      </div>
      ${dl ? `<a class="btn" href="${esc(dl)}">Download package</a>` : ""}
    </div>
    <div class="pkg-grid">
      <dl class="meta-list">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      </dl>
      <div class="pkg-side">
        <h2>Depends on</h2>
        ${deps.length
          ? `<ul class="chips">${deps.map((d) => `<li><code>${esc(d)}</code></li>`).join("")}</ul>`
          : '<p class="muted">No dependencies.</p>'}
        ${p.sha256 ? `
        <div class="checksum">
          <div class="checksum-head"><span>SHA-256</span><button type="button" class="btn-copy" data-copy="#pkg-sha">Copy</button></div>
          <code id="pkg-sha" class="hash">${esc(p.sha256)}</code>
        </div>` : ""}
      </div>
    </div>`;
}

function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

// add the repo

// signs every package and the repo database
const SIGNING_KEY = "26AE1C61B5681DBA3E040762252E4D04C0EA3DB4";

function renderPacman(main) {
  document.title = "Add the repo — Alnix";
  const conf = `[alnix]\nServer = https://${location.hostname}/repo/$arch`;
  main.innerHTML = `
    <section class="page-head wrap narrow">
      <h1>Add the Alnix repo to pacman</h1>
      <p class="lede">Already running Arch? You can pull Alnix packages into your existing install
        by adding one short section to <code>pacman.conf</code>.</p>
    </section>

    <section class="wrap narrow">
      <ol class="steps">
        <li>
          <h2>Trust the Alnix signing key</h2>
          <p>Our packages are signed, and pacman won't install them until it knows our key.</p>
          <div class="code-block">
            <pre><code id="cmd-key">sudo pacman-key --recv-keys ${SIGNING_KEY}
sudo pacman-key --lsign-key ${SIGNING_KEY}</code></pre>
            <button type="button" class="btn-copy" data-copy="#cmd-key">Copy</button>
          </div>
        </li>
        <li>
          <h2>Open pacman's config as root</h2>
          <div class="code-block">
            <pre><code id="cmd-edit">sudoedit /etc/pacman.conf</code></pre>
            <button type="button" class="btn-copy" data-copy="#cmd-edit">Copy</button>
          </div>
        </li>
        <li>
          <h2>Add the <code>[alnix]</code> section</h2>
          <p>Put it at the end of the file, after the official repos. pacman checks repos in order,
            so this way packages from Arch always take priority over ours if a name exists in both.</p>
          <div class="code-block">
            <div class="code-title">/etc/pacman.conf</div>
            <pre><code id="cmd-conf">${esc(conf)}</code></pre>
            <button type="button" class="btn-copy" data-copy="#cmd-conf">Copy</button>
          </div>
          <p class="muted">Leave <code>$arch</code> as it is. pacman fills in your architecture, for example <code>x86_64</code>.</p>
        </li>
        <li>
          <h2>Sync and update</h2>
          <div class="code-block">
            <pre><code id="cmd-sync">sudo pacman -Syu</code></pre>
            <button type="button" class="btn-copy" data-copy="#cmd-sync">Copy</button>
          </div>
          <p>Use <code>-Syu</code> rather than just <code>-Sy</code>. Refreshing the database without upgrading
            leads to partial upgrades, which Arch doesn't support.</p>
        </li>
        <li>
          <h2>See what's there</h2>
          <div class="code-block">
            <pre><code id="cmd-list">pacman -Sl alnix</code></pre>
            <button type="button" class="btn-copy" data-copy="#cmd-list">Copy</button>
          </div>
          <p>Or <a href="/packages" data-link>browse the package list</a> here. If it's empty, <a href="/devs" data-link>let the Server Manager know</a>.</p>
        </li>
      </ol>

      <aside class="callout">
        <h2>Removing it again</h2>
        <p>Delete the <code>[alnix]</code> section and run <code>sudo pacman -Syu</code>. To stop trusting our key too,
          run <code>sudo pacman-key --delete ${SIGNING_KEY}</code>. Packages you already
          installed from it stay installed; <code>pacman -Qm</code> lists anything no longer in a configured repo.</p>
      </aside>
    </section>`;
  bindCopyButtons(main);
}

// devs

// email is optional
const DEVS = [
  { name: "Alex", role: "Project Maintainer and Lead Dev", email: "alex@alnix.org" },
  { name: "bitetheapple", role: "Website Leader/Dev and Server Manager", email: "appl@alnix.org" },
  { name: "someone1234", role: "Official App Dev and App Leader", email: "someone1234@alnix.org" },
  { name: "LagTech", role: "Graphic Designer", email: "lagtech@alnix.org" },
  { name: "literally nobody", role: "does nothing", email: "nobody@alnix.org" },
];

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

// gravatar uses a sha-256 of the email
async function gravatarUrl(email, size) {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `https://gravatar.com/avatar/${hex}?s=${size}&d=404`;
}

// show gravatar if there is one
function loadAvatars(root) {
  if (!crypto.subtle) return;
  root.querySelectorAll(".dev-avatar[data-email]").forEach(async (el) => {
    const img = new Image();
    img.alt = "";
    img.src = await gravatarUrl(el.dataset.email, 104);
    img.addEventListener("load", () => el.replaceChildren(img));
  });
}

function renderDevs(main) {
  document.title = "Devs — Alnix";
  main.innerHTML = `
    <section class="page-head wrap">
      <h1>The people behind Alnix</h1>
      <p class="lede">Alnix is made by a group of friends in their spare time.</p>
    </section>
    <section class="wrap">
      <ul class="devs">
        ${DEVS.map((d) => `
          <li class="dev">
            <span class="dev-avatar" aria-hidden="true"${d.email ? ` data-email="${esc(d.email)}"` : ""}>${esc(initials(d.name))}</span>
            <div>
              <p class="dev-name">${esc(d.name)}</p>
              <p class="dev-role">${esc(d.role)}</p>
              ${d.email ? `<a class="dev-link" href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : ""}
            </div>
          </li>`).join("")}
      </ul>
    </section>`;
  loadAvatars(main);
}

// contact

const CONTACTS = [
  { name: "GitHub", text: "See the code and report bugs", url: "https://github.com/Alnix-Linux/Alnix", icon: "github" },
  { name: "Discord", text: "Chat with us and other users", url: "https://discord.gg/JZC58TYQmT", icon: "discord" },
];

function renderContact(main) {
  document.title = "Contact — Alnix";
  main.innerHTML = `
    <section class="page-head wrap narrow">
      <h1>Contact</h1>
      <p class="lede">Questions, bugs or ideas? Come say hi.</p>
      <ul class="contacts">
        ${CONTACTS.map((c) => `
          <li>
            <a class="contact" href="${esc(c.url)}" rel="noopener">
              <span class="contact-icon icon-${esc(c.icon)}" aria-hidden="true"></span>
              <span>
                <span class="contact-name">${esc(c.name)}</span>
                <span class="contact-text">${esc(c.text)}</span>
              </span>
            </a>
          </li>`).join("")}
      </ul>
    </section>`;
}

// 404

function renderNotFound(main) {
  document.title = "Page not found — Alnix";
  main.innerHTML = `
    <section class="wrap narrow">
      <div class="page-head">
        <h1>Page not found</h1>
        <p>There's nothing at this address. <a href="/" data-link>Go to the homepage</a>.</p>
      </div>
    </section>`;
}

// router

const routes = [
  { path: /^\/$/, nav: "home", render: renderHome },
  { path: /^\/packages\/?$/, nav: "packages", render: renderPackages },
  { path: /^\/packages\/([^/]+)\/?$/, nav: "packages", render: renderPackage },
  { path: /^\/pacman\/?$/, nav: "pacman", render: renderPacman },
  { path: /^\/devs\/?$/, nav: "devs", render: renderDevs },
  { path: /^\/contact\/?$/, nav: "contact", render: renderContact },
];

const main = document.getElementById("main");
let controller = null;

function route() {
  controller?.abort();
  controller = new AbortController();
  const { pathname } = location;
  let match = null;
  const r = routes.find((r) => (match = pathname.match(r.path))) ?? { nav: null, render: renderNotFound };
  const params = match ? match.slice(1).map(decodeURIComponent) : [];
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === r.nav) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  main.replaceChildren();
  r.render(main, { params, signal: controller.signal, navigate });
}

function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  route();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) navigate(url.pathname + url.search + url.hash);
});

window.addEventListener("popstate", route);
route();

