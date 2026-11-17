// Shelf — your Spotify saved albums as a browsable shelf.
// Login uses Spotify's PKCE flow, so no secret is stored anywhere in this code.

const CLIENT_ID = "38ba190453174cd1ba500ac85e9d4d3b";
const SCOPES = [
  "user-library-read",          // read your saved albums
  "streaming",                  // play music in this browser tab
  "user-read-email", "user-read-private",
  "user-read-playback-state", "user-modify-playback-state",
].join(" ");

// Spotify only accepts 127.0.0.1 (not "localhost") for local apps, so keep everyone on one address
if (location.hostname === "localhost") location.replace(location.href.replace("//localhost", "//127.0.0.1"));
const BASE = location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "");
const REDIRECT_URI = new URL("callback", BASE).href;

const $ = id => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ---------- Login (Authorization Code with PKCE) ----------
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  store.set("shelf-pkce", { verifier, state });
  const q = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256", code_challenge: challenge, scope: SCOPES, state,
  });
  location.assign("https://accounts.spotify.com/authorize?" + q);
}

async function tokenRequest(params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!r.ok) throw new Error("Spotify login failed (" + r.status + ")");
  const t = await r.json();
  const prev = store.get("shelf-token", {});
  const tok = { access: t.access_token, refresh: t.refresh_token || prev.refresh, expires: Date.now() + (t.expires_in - 60) * 1000 };
  store.set("shelf-token", tok);
  return tok;
}

async function finishLogin() {
  const p = new URLSearchParams(location.search);
  if (!p.has("code") && !p.has("error")) return;
  history.replaceState(null, "", BASE);
  const saved = store.get("shelf-pkce"); store.del("shelf-pkce");
  if (p.has("error")) throw new Error(p.get("error") === "access_denied" ? "Spotify login was cancelled." : "Spotify login failed: " + p.get("error"));
  if (!saved || saved.state !== p.get("state")) throw new Error("That login link has expired. Please connect again.");
  await tokenRequest({ grant_type: "authorization_code", code: p.get("code"), redirect_uri: REDIRECT_URI, code_verifier: saved.verifier });
}

let refreshing = null;
async function accessToken() {
  const tok = store.get("shelf-token");
  if (!tok) throw new Error("not-logged-in");
  if (Date.now() < tok.expires) return tok.access;
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh }).finally(() => refreshing = null);
  return (await refreshing).access;
}

function logout() {
  store.del("shelf-token"); store.del("shelf-library");
  try { player?.disconnect(); } catch {}
  location.replace(BASE);
}

async function api(path, opts = {}) {
  const go = async () => fetch("https://api.spotify.com/v1" + path, {
    ...opts, headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let r = await go();
  if (r.status === 401) { const t = store.get("shelf-token"); if (t) { t.expires = 0; store.set("shelf-token", t); } r = await go(); }
  if (r.status === 429) { await new Promise(res => setTimeout(res, (+r.headers.get("Retry-After") || 2) * 1000)); r = await go(); }
  return r;
}

// ---------- Library ----------
const sortKey = n => n.replace(/^the\s+/i, "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const letterOf = n => { const c = sortKey(n).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : "#"; };

function pickImage(images, want) {
  if (!images?.length) return "";
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find(i => (i.width || 0) >= want) || sorted[sorted.length - 1]).url;
}

async function fetchLibrary(onProgress) {
  const out = [];
  let url = "/me/albums?limit=50&offset=0", total = null;
  while (url) {
    const r = await api(url);
    if (!r.ok) throw new Error("Couldn't load your albums (" + r.status + ")");
    const page = await r.json();
    total = page.total;
    for (const { album: a } of page.items) {
      if (!a) continue;
      out.push({
        id: a.id, uri: a.uri, title: a.name,
        artist: a.artists?.[0]?.name || "Unknown artist",
        artistId: a.artists?.[0]?.id || a.artists?.[0]?.name,
        date: a.release_date || "", year: (a.release_date || "").slice(0, 4),
        img: pickImage(a.images, 300), thumb: pickImage(a.images, 64),
      });
    }
    onProgress?.(out.length, total);
    url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return out;
}

let albums = store.get("shelf-library", []);
let favs = new Set(store.get("shelf-favs-spotify", []));
const saveFavs = () => store.set("shelf-favs-spotify", [...favs]);

const ICON_PLAY = '<path d="M7 4v16l13-8z"/>', ICON_PAUSE = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>';

function cdEl(a, sub, header = "") {
  const d = document.createElement("div");
  d.className = "cd" + (nowAlbumUri === a.uri ? " playing" : ""); d.dataset.uri = a.uri;
  const fav = favs.has(a.id);
  d.innerHTML = `<div class="an">${esc(header)}</div><div class="art">
      <button class="cover" type="button" aria-label="Play ${esc(a.title)} by ${esc(a.artist)}"><img alt="" loading="lazy" src="${esc(a.img)}"></button>
      <button class="ov play" type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24">${ICON_PLAY}</svg></button>
      <button class="ov star" type="button" aria-pressed="${fav}" aria-label="${fav ? "Remove from" : "Add to"} favourites">${STAR}</button>
    </div>
    <div class="t" title="${esc(a.title)}">${esc(a.title)}</div><div class="y">${esc(sub)}</div>`;
  d.querySelector(".cover").onclick = () => playAlbum(a);
  d.querySelector(".ov.play").onclick = () => playAlbum(a);
  d.querySelector(".star").onclick = () => { fav ? favs.delete(a.id) : favs.add(a.id); saveFavs(); render(); };
  return d;
}

function render() {
  const main = $("main"), y = scrollY; main.innerHTML = "";
  $("topbar").hidden = false;

  // Group by artist, A–Z ("The" ignored); each artist's albums oldest first
  const byArtist = new Map();
  for (const a of albums) {
    if (!byArtist.has(a.artistId)) byArtist.set(a.artistId, { name: a.artist, albums: [] });
    byArtist.get(a.artistId).albums.push(a);
  }
  const artists = [...byArtist.values()].sort((x, y) => sortKey(x.name).localeCompare(sortKey(y.name), undefined, { sensitivity: "base" }));
  artists.forEach(ar => ar.albums.sort((p, q) => p.date.localeCompare(q.date) || p.title.localeCompare(q.title)));

  // Favourites: only shown once you've starred something
  const favList = artists.flatMap(ar => ar.albums).filter(a => favs.has(a.id));
  if (favList.length) {
    const fs = document.createElement("section"); fs.id = "favourites"; fs.className = "row";
    fs.innerHTML = `<h2>Favourites</h2>`;
    const g = document.createElement("div"); g.className = "grid"; favList.forEach(a => g.appendChild(cdEl(a, a.artist))); fs.appendChild(g);
    main.appendChild(fs);
  }

  const groups = {};
  artists.forEach(ar => (groups[letterOf(ar.name)] ??= []).push(ar));
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ#"];
  const wrapAll = document.createElement("div"); wrapAll.id = "artists"; main.appendChild(wrapAll);
  for (const L of letters.filter(l => groups[l])) {
    const s = document.createElement("section");
    for (const [i, ar] of groups[L].entries()) {
      const box = document.createElement("div"); box.className = "row";
      if (i === 0) box.id = "l-" + (L === "#" ? "num" : L);   // jump target: the letter's first artist
      box.innerHTML = `<h2>${esc(ar.name)}</h2>`;
      const g = document.createElement("div"); g.className = "grid";
      ar.albums.forEach((a, i) => g.appendChild(cdEl(a, a.year, i === 0 ? ar.name : "")));
      box.appendChild(g); s.appendChild(box);
    }
    wrapAll.appendChild(s);
  }
  $("az").innerHTML = (favList.length ? `<a href="#favourites">Favourites</a>` : "") +
    letters.map(L => groups[L] ? `<a href="#l-${L === "#" ? "num" : L}">${L}</a>` : `<span aria-hidden="true">${L}</span>`).join("");
  // Letter links: in the side-by-side grid the artist's row has no box of its own, so jump to its first album
  $("az").querySelectorAll("a").forEach(link => link.onclick = e => {
    const row = document.querySelector(link.getAttribute("href"));
    if (!row) return;
    e.preventDefault();
    const target = document.body.classList.contains("shelf") && row.classList.contains("row") ? row.querySelector(".cd") : row;
    target.scrollIntoView({ block: "start" });
    history.replaceState(null, "", link.getAttribute("href"));
  });
  $("summary").textContent = `${albums.length} albums · ${artists.length} artists`;
  scrollTo(0, y);
}

function showGate(message) {
  $("topbar").hidden = true; $("player").hidden = true;
  $("main").innerHTML = `<div class="gate"><div>
    <h1>Shelf</h1>
    <p>${esc(message || "Browse your saved Spotify albums like a CD collection. Connect your account to load them.")}</p>
    <button class="btn" id="connect" type="button">Connect Spotify</button>
  </div></div>`;
  $("connect").onclick = login;
}

async function loadLibrary() {
  if (!albums.length) $("main").innerHTML = `<div class="loading" id="loadmsg">Loading your albums…</div>`;
  const fresh = await fetchLibrary((n, total) => { const m = $("loadmsg"); if (m) m.textContent = `Loading your albums… ${n} of ${total}`; });
  albums = fresh; store.set("shelf-library", fresh); render();
}

// ---------- Playback (Spotify Web Playback SDK; needs Premium) ----------
let player = null, deviceId = null, nowAlbumUri = null;
let pState = null, pStateAt = 0;

function setStatus(title, sub, isErr = false) {
  $("npt").textContent = title; $("npa").textContent = sub; $("npa").classList.toggle("err", isErr);
}

function initPlayer() {
  $("player").hidden = false;
  window.onSpotifyWebPlaybackSDKReady = () => {
    player = new Spotify.Player({ name: "Shelf", volume: 0.8, getOAuthToken: cb => accessToken().then(cb).catch(() => {}) });
    player.addListener("ready", ({ device_id }) => { deviceId = device_id; if (!pState) setStatus("Not playing", "Choose an album to start"); });
    player.addListener("not_ready", () => { deviceId = null; setStatus("Player offline", "Reconnecting…"); });
    player.addListener("initialization_error", ({ message }) => setStatus("Can't play in this browser", message, true));
    player.addListener("authentication_error", () => setStatus("Spotify login expired", "Please log out and connect again", true));
    player.addListener("account_error", () => setStatus("Spotify Premium is needed", "Playing music here needs a Premium account", true));
    player.addListener("playback_error", ({ message }) => setStatus("Couldn't play that", message, true));
    player.addListener("player_state_changed", s => { pState = s; pStateAt = performance.now(); showState(); });
    player.connect();
  };
  const sc = document.createElement("script"); sc.src = "https://sdk.scdn.co/spotify-player.js"; document.head.appendChild(sc);
}

async function playAlbum(a) {
  player?.activateElement?.();           // lets browsers that need a click start audio
  // Clicking the album that's already loaded pauses or resumes it instead of starting it again
  if (player && pState && nowAlbumUri === a.uri) { player.togglePlay(); return; }
  setStatus(a.title, a.artist + " · starting…");
  $("thumb").src = a.thumb || a.img; $("thumb").hidden = false;
  const q = deviceId ? "?device_id=" + deviceId : "";
  const r = await api("/me/player/play" + q, { method: "PUT", body: JSON.stringify({ context_uri: a.uri }) });
  if (r.status === 403) setStatus(a.title, "Playback needs Spotify Premium", true);
  else if (r.status === 404) setStatus(a.title, "Player not ready yet — try again in a moment", true);
  else if (!r.ok && r.status !== 202) setStatus(a.title, "Couldn't start playback (" + r.status + ")", true);
}

const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function showState() {
  const s = pState;
  if (!s || !s.track_window?.current_track) return;
  const t = s.track_window.current_track;
  const pos = s.paused ? s.position : Math.min(s.duration, s.position + (performance.now() - pStateAt));
  $("npt").textContent = t.name;
  $("npa").textContent = `${t.artists.map(x => x.name).join(", ")} — ${t.album.name} · ${fmt(pos)} / ${fmt(s.duration)}`;
  $("npa").classList.remove("err");
  $("bar").style.width = (s.duration ? pos / s.duration * 100 : 0) + "%";
  $("thumb").src = pickImage(t.album.images, 64) || $("thumb").src; $("thumb").hidden = false;
  $("ctrls").hidden = false; $("prog").hidden = false;
  $("ppi").innerHTML = s.paused ? ICON_PLAY : ICON_PAUSE;
  $("pp").setAttribute("aria-label", s.paused ? "Play" : "Pause");
  $("next").disabled = !s.track_window.next_tracks?.length;
  if (nowAlbumUri !== t.album.uri) {
    nowAlbumUri = t.album.uri;
    document.querySelectorAll(".cd").forEach(el => el.classList.toggle("playing", el.dataset.uri === nowAlbumUri));
  }
  // The hover button on the playing album shows pause while it plays
  document.querySelectorAll(".cd .ov.play svg").forEach(svg => {
    const playingHere = svg.closest(".cd").dataset.uri === nowAlbumUri && !s.paused;
    const want = playingHere ? "pause" : "play";
    if ((svg.dataset.icon || "play") !== want) { svg.dataset.icon = want; svg.innerHTML = playingHere ? ICON_PAUSE : ICON_PLAY; }
  });
}
setInterval(() => { if (pState && !pState.paused) showState(); }, 500);

// Previous: restart the track if more than 3 seconds in, otherwise go back one (like a CD player)
$("prev").onclick = () => { if (!player || !pState) return; const pos = pState.position + (pState.paused ? 0 : performance.now() - pStateAt); pos > 3000 ? player.seek(0) : player.previousTrack(); };
$("next").onclick = () => player?.nextTrack();
$("pp").onclick = () => player?.togglePlay();
$("logout").onclick = logout;
$("refresh").onclick = async () => { $("refresh").textContent = "Refreshing…"; try { await loadLibrary(); } finally { $("refresh").textContent = "Refresh"; } };

// ---------- Settings panel ----------
const settings = $("settings"), gear = $("settingsBtn");
function setSettings(open) {
  settings.hidden = !open; gear.setAttribute("aria-expanded", open);
  if (open) settings.querySelector("input:checked, input")?.focus();
}
gear.onclick = () => setSettings(settings.hidden);
$("settingsClose").onclick = () => { setSettings(false); gear.focus(); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && !settings.hidden) { setSettings(false); gear.focus(); } });
document.addEventListener("click", e => { if (!settings.hidden && !settings.contains(e.target) && !gear.contains(e.target)) setSettings(false); });

// Layout: "rows" (one artist per row) or "shelf" (artists side by side)
function applyLayout(v) {
  document.body.classList.toggle("shelf", v === "shelf");
  $("layout-" + v).checked = true;
  store.set("shelf-layout", v);
}
document.querySelectorAll('input[name="layout"]').forEach(r => r.onchange = () => applyLayout(r.value));
applyLayout(store.get("shelf-layout", "shelf") === "rows" ? "rows" : "shelf");   // side by side is the default

// Keep jump targets clear of the sticky top bar, whatever its height (it can wrap to two lines)
const topbarEl = $("topbar");
new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", topbarEl.offsetHeight + "px")).observe(topbarEl);
store.del("shelf-design");               // old Design drawer settings are no longer used

// ---------- Start ----------
(async () => {
  try { await finishLogin(); }
  catch (e) { showGate(e.message); return; }
  if (!store.get("shelf-token")) { showGate(); return; }
  if (albums.length) render();          // show the cached shelf straight away
  initPlayer();
  try { await loadLibrary(); }
  catch (e) {
    if (e.message === "not-logged-in" || /login failed/i.test(e.message)) showGate("Your Spotify login has expired. Please connect again.");
    else if (!albums.length) $("main").innerHTML = `<div class="loading">${esc(e.message)}</div>`;
  }
})();
