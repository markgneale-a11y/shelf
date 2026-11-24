// Shelf — your Spotify saved albums as a browsable shelf.
// Login uses Spotify's PKCE flow, so no secret is stored anywhere in this code.

const CLIENT_ID = "38ba190453174cd1ba500ac85e9d4d3b";
const SCOPES = [
  "user-library-read",          // read your saved albums
  "user-library-modify",        // save and remove albums
  "streaming",                  // play music in this browser tab
  "user-read-email", "user-read-private",
  "user-read-playback-state", "user-modify-playback-state",
  "user-follow-read", "user-follow-modify",   // see and follow artists, so saving an album follows its artist
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

// fetch that gives up after a while, so a dead connection (e.g. just after waking the Mac) can't hang the app
function timedFetch(url, opts = {}, ms = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}
async function tokenRequest(params) {
  const r = await timedFetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!r.ok) throw new Error("Spotify login failed (" + r.status + ")");
  const t = await r.json();
  const prev = store.get("shelf-token", {});
  const tok = { access: t.access_token, refresh: t.refresh_token || prev.refresh, scope: t.scope || prev.scope || "", expires: Date.now() + (t.expires_in - 60) * 1000 };
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
  const go = async () => timedFetch(path.startsWith("http") ? path : "https://api.spotify.com/v1" + path, {
    ...opts, headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let r = await go();
  if (r.status === 401) { const t = store.get("shelf-token"); if (t) { t.expires = 0; store.set("shelf-token", t); } r = await go(); }
  // Rate limited: wait as Spotify asks (or 2, 4, 8 seconds) and try again; give up if the wait would be long
  for (let tries = 0; r.status === 429 && tries < 3; tries++) {
    const wait = (+r.headers.get("Retry-After") || 2 ** (tries + 1)) * 1000;
    if (wait > 15000) break;
    await new Promise(res => setTimeout(res, wait));
    r = await go();
  }
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

function albumFromApi(a) {
  return {
    id: a.id, uri: a.uri, title: a.name,
    artist: a.artists?.[0]?.name || "Unknown artist",
    artistId: a.artists?.[0]?.id || a.artists?.[0]?.name,
    date: a.release_date || "", year: (a.release_date || "").slice(0, 4),
    img: pickImage(a.images, 300), thumb: pickImage(a.images, 64),
  };
}

async function fetchLibrary(onProgress) {
  const out = [];
  let url = "/me/albums?limit=50&offset=0", total = null;
  while (url) {
    const r = await api(url);
    if (!r.ok) throw new Error("Couldn't load your albums (" + r.status + ")");
    const page = await r.json();
    total = page.total;
    for (const { album: a } of page.items) if (a) out.push(albumFromApi(a));
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

const REMOVE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const LIST = '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="18" r="1.4"/></svg>';
const ADD = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// The artist's name with a quiet "More" link that appears on hover
function artistHead(ar) {
  const open = expanded.has(ar.id), busy = loadingMore.has(ar.id);
  return `<span class="an-name">${esc(ar.name)}</span><span class="an-acts">` +
    `<button class="act${open ? " on" : ""}" type="button" data-act="more" data-artist="${esc(ar.id)}" aria-expanded="${open}">${busy ? "Loading…" : open ? "Less" : "More"}</button></span>`;
}

function cdEl(a, sub, ar = null, ghost = false) {
  const d = document.createElement("div");
  d.className = "cd" + (ghost ? " ghost" : "") + (nowAlbumUri === a.uri ? " playing" : ""); d.dataset.uri = a.uri;
  const fav = favs.has(a.id);
  d.innerHTML = `<div class="an">${ar ? artistHead(ar) : ""}</div><div class="art">
      <button class="cover" type="button" aria-label="Play ${esc(a.title)} by ${esc(a.artist)}"><img alt="" loading="lazy" src="${esc(a.img)}"></button>
      <button class="ov play" type="button" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24">${ICON_PLAY}</svg></button>
      <button class="ov peekbtn" type="button" aria-label="Show tracks on ${esc(a.title)}" title="Tracks">${LIST}</button>
      ${ghost
        ? `<button class="ov add" type="button" aria-label="Save ${esc(a.title)} to your library">${ADD}</button>`
        : `<button class="ov star" type="button" aria-pressed="${fav}" aria-label="${fav ? "Remove from" : "Add to"} favourites">${STAR}</button>
           <button class="ov rm" type="button" aria-label="Remove ${esc(a.title)} from your library">${REMOVE}</button>`}
    </div>
    <div class="t" title="${esc(a.title)}">${esc(a.title)}</div><div class="y">${esc(sub)}</div>`;
  d.querySelector(".cover").onclick = () => playAlbum(a);
  d.querySelector(".ov.play").onclick = () => playAlbum(a);
  d.querySelector(".peekbtn").onclick = e => { e.stopPropagation(); peekTracks(a, d, ghost); };
  if (ghost) d.querySelector(".add").onclick = () => saveAlbum(a);
  else {
    d.querySelector(".star").onclick = () => { fav ? favs.delete(a.id) : favs.add(a.id); saveFavs(); render(); };
    d.querySelector(".rm").onclick = () => removeAlbums([a], `“${a.title}”`);
  }
  return d;
}

function render() {
  const main = $("main"), y = scrollY; main.innerHTML = "";
  $("topbar").hidden = false;

  // Group by artist, A–Z ("The" ignored); each artist's albums oldest first
  const byArtist = new Map();
  for (const a of albums) {
    if (!byArtist.has(a.artistId)) byArtist.set(a.artistId, { id: a.artistId, name: a.artist, albums: [] });
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
      box.innerHTML = `<h2>${artistHead(ar)}</h2>`;
      const g = document.createElement("div"); g.className = "grid";
      ar.albums.forEach((a, i) => g.appendChild(cdEl(a, a.year, i === 0 ? ar : null)));
      for (const a of expanded.has(ar.id) ? otherAlbums(ar) : []) g.appendChild(cdEl(a, a.year, null, true));
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
  if (typeof searchArtist !== "undefined" && searchArtist) showSearchAlbums();
  if (typeof newState !== "undefined") { updateNewChip(); if (!$("search").hidden && $("sres").querySelector(".ahd h3")?.textContent === "New releases") showNew(); }
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
  albums = fresh; store.set("shelf-library", fresh); store.set("shelf-library-at", Date.now()); render();
}

// ---------- More by this artist, saving and removing ----------
const expanded = new Set(), loadingMore = new Set();
// Other albums per artist, kept for a week so "More" doesn't ask Spotify again
const MORE_TTL = 7 * 24 * 3600 * 1000;
const moreCache = Object.fromEntries(Object.entries(store.get("shelf-more", {})).filter(([, v]) => Date.now() - v.at < MORE_TTL).map(([k, v]) => [k, v.list]));
const saveMoreCache = () => store.set("shelf-more", Object.fromEntries(Object.entries(moreCache).map(([k, list]) => [k, { at: Date.now(), list }])));
const artistById = id => { const a = albums.find(x => x.artistId === id); return a && { id, name: a.artist }; };
// "Album (Remastered)", "Album [Deluxe]" and "Album - 2011 Remaster" count as the same album
const normTitle = t => t.toLowerCase().replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/\s+-\s+.*$/, "").replace(/[^a-z0-9]+/g, " ").trim();

function otherAlbums(ar) {
  const mine = albums.filter(a => a.artistId === ar.id);
  const ids = new Set(mine.map(a => a.id)), titles = new Set(mine.map(a => normTitle(a.title)));
  return (moreCache[ar.id] || []).filter(a => !ids.has(a.id) && !titles.has(normTitle(a.title)));
}

// An artist's albums from Spotify (oldest first, one per title), kept for a week
async function fetchArtistAlbums(ar) {
  if (moreCache[ar.id]) return moreCache[ar.id];
  const list = [];
  // Spotify allows at most 10 per page here, so follow the "next" links
  let url = `/artists/${encodeURIComponent(ar.id)}/albums?include_groups=album&limit=10&market=from_token`;
  while (url && list.length < 50) {          // up to 5 pages: plenty for nearly every artist
    const r = await api(url);
    if (r.status === 429) throw new Error("Spotify is busy right now. Try again in a minute.");
    if (!r.ok) throw new Error("Couldn't load albums (" + r.status + ")");
    const page = await r.json();
    page.items.forEach(a => list.push({ ...albumFromApi(a), artist: ar.name, artistId: ar.id }));
    url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  const seen = new Map();
  list.sort((p, q) => p.date.localeCompare(q.date)).forEach(a => { const k = normTitle(a.title); if (!seen.has(k)) seen.set(k, a); });
  moreCache[ar.id] = [...seen.values()]; saveMoreCache();
  return moreCache[ar.id];
}

async function toggleMore(ar) {
  if (expanded.has(ar.id)) { expanded.delete(ar.id); render(); return; }
  if (!moreCache[ar.id]) {
    loadingMore.add(ar.id); render();
    try { await fetchArtistAlbums(ar); }
    catch (e) { toast(e.message); loadingMore.delete(ar.id); render(); return; }
    loadingMore.delete(ar.id);
  }
  if (!otherAlbums(ar).length) { toast(`You already have every ${ar.name} album`); render(); return; }
  expanded.add(ar.id); render();
}

const canModify = () => (store.get("shelf-token")?.scope || "").includes("user-library-modify");
function needPermission() {
  toast("Shelf needs your OK to change your Spotify library.", "Reconnect", login, 10000);
}

// Saves (PUT) or removes (DELETE) albums in your Spotify library.
// Uses Spotify's general /me/library endpoint: the older /me/albums write endpoint now returns 403 for apps like this.
async function libraryCall(method, ids) {
  for (let i = 0; i < ids.length; i += 20) {
    const uris = ids.slice(i, i + 20).map(id => "spotify:album:" + id).join(",");
    const r = await api("/me/library?uris=" + encodeURIComponent(uris), { method });
    if (r.status === 401) { needPermission(); return false; }
    if (r.status === 403) { toast(canModify() ? "Spotify refused that change (403)." : "Shelf needs your OK to change your Spotify library.", canModify() ? null : "Reconnect", login, 10000); return false; }
    if (!r.ok) { toast("Spotify didn't accept that (" + r.status + "). Try again."); return false; }
  }
  return true;
}

async function saveAlbum(a) {
  if (!canModify()) return needPermission();
  if (!await libraryCall("PUT", [a.id])) return;
  albums.push({ ...a }); store.set("shelf-library", albums); render();
  // Saving an album also follows its artist, so the two stay in sync
  if (!canFollow()) return toast(`Saved “${a.title}”. Reconnect so Shelf can follow artists too.`, "Reconnect", login, 10000);
  if (!isFollowed(a.artistId)) await followArtists([{ id: a.artistId, name: a.artist, img: a.thumb }]);
  toast(`Saved “${a.title}” to your library`, "Undo", () => removeAlbums([a], `“${a.title}”`, false));
}

// ---------- Followed artists ----------
const canFollow = () => { const sc = store.get("shelf-token")?.scope || ""; return sc.includes("user-follow-read") && sc.includes("user-follow-modify"); };
let followed = store.get("shelf-followed", null);          // {at, list: [{id, name, img}]}
const isFollowed = id => !!followed?.list.some(f => f.id === id);
async function loadFollowed(force = false) {
  if (!canFollow()) return null;
  if (!force && followed && Date.now() - followed.at < 15 * 60 * 1000) return followed.list;
  const list = [];
  let url = "/me/following?type=artist&limit=50";
  while (url) {
    const r = await api(url);
    if (r.status === 429) throw new Error("Spotify is busy right now. Try again in a minute.");
    if (!r.ok) throw new Error("Couldn't load the artists you follow (" + r.status + ")");
    const page = (await r.json()).artists;
    page.items.forEach(ar => list.push({ id: ar.id, name: ar.name, img: pickImage(ar.images, 64) }));
    url = page.next ? page.next.replace("https://api.spotify.com/v1", "") : null;
  }
  followed = { at: Date.now(), list }; store.set("shelf-followed", followed);
  return list;
}
// Follows artists (Spotify's general /me/library endpoint, falling back to the older /me/following)
async function followArtists(list) {
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    let r = await api("/me/library?uris=" + encodeURIComponent(chunk.map(ar => "spotify:artist:" + ar.id).join(",")), { method: "PUT" });
    if (!r.ok) r = await api("/me/following?type=artist&ids=" + chunk.map(ar => ar.id).join(","), { method: "PUT" });
    if (!r.ok) { toast("Couldn't follow " + (chunk.length > 1 ? "those artists" : chunk[0].name) + " (" + r.status + ")"); return false; }
    if (followed) { followed.list.push(...chunk.filter(ar => !isFollowed(ar.id))); store.set("shelf-followed", followed); }
  }
  return true;
}
// Artists on the shelf you don't follow yet
function unfollowedShelfArtists() {
  const seen = new Map();
  for (const a of albums) if (a.artistId && !isFollowed(a.artistId) && !seen.has(a.artistId)) seen.set(a.artistId, { id: a.artistId, name: a.artist, img: a.thumb });
  return [...seen.values()];
}

async function removeAlbums(list, label, offerUndo = true) {
  if (!canModify()) return needPermission();
  if (!await libraryCall("DELETE", list.map(a => a.id))) return;
  const gone = new Set(list.map(a => a.id));
  albums = albums.filter(a => !gone.has(a.id)); store.set("shelf-library", albums); render();
  if (offerUndo) toast(`Removed ${label} from your library`, "Undo", async () => {
    if (!await libraryCall("PUT", list.map(a => a.id))) return;
    albums.push(...list); store.set("shelf-library", albums); render(); toast("Put back");
  });
  else toast(`Removed ${label}`);
}

// The artist-name "More" link works the same in both layouts
$("main").addEventListener("click", e => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const ar = artistById(btn.dataset.artist); if (!ar) return;
  if (btn.dataset.act === "more") toggleMore(ar);
});

// Small message at the bottom with an optional action (e.g. Undo)
let toastTimer;
function toast(msg, actionLabel, action, ms = 6000) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : "");
  if (actionLabel) t.querySelector("button").onclick = () => { t.hidden = true; action(); };
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}

// ---------- Playback (Spotify Web Playback SDK; needs Premium) ----------
let player = null, deviceId = null, nowAlbumUri = null;
let pState = null, pStateAt = 0;

function setStatus(title, sub, isErr = false) {
  $("npt").textContent = title; $("npa").textContent = sub; $("npa").classList.toggle("err", isErr);
}

function makePlayer() {
  player = new Spotify.Player({ name: "Shelf", volume: 0.8,
    // always answer the SDK, even if the token refresh fails, so it never waits forever
    getOAuthToken: cb => accessToken().then(cb).catch(() => cb(store.get("shelf-token")?.access || "")) });
  player.addListener("ready", ({ device_id }) => { deviceId = device_id; if (!pState) setStatus("Not playing", "Choose an album to start"); });
  player.addListener("not_ready", () => { deviceId = null; });
  player.addListener("initialization_error", ({ message }) => setStatus("Can't play in this browser", message, true));
  player.addListener("authentication_error", () => setStatus("Spotify login expired", "Please log out and connect again", true));
  player.addListener("account_error", () => setStatus("Spotify Premium is needed", "Playing music here needs a Premium account", true));
  player.addListener("playback_error", ({ message }) => setStatus("Couldn't play that", message, true));
  player.addListener("player_state_changed", s => { pState = s; pStateAt = performance.now(); showState(); });
  player.connect();
}
function initPlayer() {
  $("player").hidden = false;
  window.onSpotifyWebPlaybackSDKReady = makePlayer;
  const sc = document.createElement("script"); sc.src = "https://sdk.scdn.co/spotify-player.js"; document.head.appendChild(sc);
}
// Throw the old player away and start a fresh one (used after sleep, or when Spotify has lost it)
let rebuilding = null;
function rebuildPlayer() {
  if (!window.Spotify) return Promise.resolve();
  return rebuilding ??= (async () => {
    deviceId = null;
    try { player?.disconnect(); } catch {}
    makePlayer();
    await waitForDevice(10000);
  })().finally(() => rebuilding = null);
}
// After the Mac sleeps the player's connection is usually dead: notice the gap and rebuild it
let lastTick = Date.now();
setInterval(() => { const gap = Date.now() - lastTick; lastTick = Date.now(); if (gap > 5 * 60 * 1000) rebuildPlayer(); }, 20000);
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 30 * 60 * 1000) rebuildPlayer();
});

// Spotify sometimes forgets this browser's player (after sleep or a long idle): a 404 here.
// Reconnect the player, wait for a fresh device, and try once more.
function waitForDevice(ms = 8000) {
  return new Promise(res => {
    const t0 = Date.now(), tick = () => deviceId ? res(deviceId) : Date.now() - t0 > ms ? res(null) : setTimeout(tick, 200);
    tick();
  });
}
async function startPlayback(body) {
  const send = () => api("/me/player/play" + (deviceId ? "?device_id=" + deviceId : ""), { method: "PUT", body: JSON.stringify(body) });
  let rebuilt = false;
  if (!deviceId) await (rebuilding || waitForDevice(3000));
  if (!deviceId) { await rebuildPlayer(); rebuilt = true; }
  if (!deviceId && window.Spotify) return { ok: false, status: 404 };   // the player won't start: say so now
  let r;
  try { r = await send(); } catch { r = { ok: false, status: 0 }; }
  if (r.status === 404 && window.Spotify && !rebuilt) {
    await rebuildPlayer();
    if (deviceId) { try { r = await send(); } catch { r = { ok: false, status: 0 }; } }
  }
  return r;
}

async function playAlbum(a) {
  player?.activateElement?.();           // lets browsers that need a click start audio
  // Clicking the album that's already loaded pauses or resumes it instead of starting it again
  if (player && deviceId && pState && nowAlbumUri === a.uri) { player.togglePlay(); return; }
  setStatus(a.title, a.artist + " · starting…");
  $("thumb").src = a.thumb || a.img; $("thumb").hidden = false;
  const r = await startPlayback({ context_uri: a.uri });
  if (r.status === 403) setStatus(a.title, "Playback needs Spotify Premium", true);
  else if (r.status === 404) setStatus(a.title, "Couldn't reach the player — try again in a moment", true);
  else if (r.status === 0) setStatus(a.title, "No connection to Spotify — check your internet and try again", true);
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
  if ($("player").classList.contains("open")) { if (nowAlbumUri !== t.album.uri) queueMicrotask(fillDrawer); else markNowTrack(); }
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

// ---------- Track drawer: click the bar to see the playing album's tracks ----------
const trackCache = new Map();             // album id -> {title, artist, year, tracks}; one request per album
let drawerAlbumId = null;
function nowAlbumId() { return nowAlbumUri?.split(":").pop() || null; }
function currentTrackUris() {
  const t = pState?.track_window?.current_track;
  return t ? [t.uri, t.linked_from?.uri].filter(Boolean) : [];
}
async function albumTracks(id) {
  if (trackCache.has(id)) return trackCache.get(id);
  const r = await api(`/albums/${id}?market=from_token`);
  if (!r.ok) throw new Error(r.status === 429 ? "Spotify is busy right now. Try again in a minute." : "Couldn't load the tracks (" + r.status + ")");
  const a = await r.json();
  let items = a.tracks.items, next = a.tracks.next;
  while (next) { const r2 = await api(next.replace("https://api.spotify.com/v1", "")); if (!r2.ok) break; const j = await r2.json(); items = items.concat(j.items); next = j.next; }
  const info = { uri: a.uri, title: a.name, artist: a.artists.map(x => x.name).join(", "), year: (a.release_date || "").slice(0, 4),
    tracks: items.map(t => ({ uri: t.uri, name: t.name, ms: t.duration_ms, n: t.track_number, disc: t.disc_number,
      artists: t.artists.map(x => x.name).join(", ") })) };
  trackCache.set(id, info);
  return info;
}
function markNowTrack() {
  const uris = currentTrackUris();
  document.querySelectorAll("#tracks .trk").forEach(li => li.classList.toggle("now", uris.includes(li.dataset.uri)));
}
async function fillDrawer() {
  const id = nowAlbumId();
  if (!id || id === drawerAlbumId) { markNowTrack(); return; }
  drawerAlbumId = id;
  const list = $("tracks");
  $("drt").textContent = pState?.track_window?.current_track?.album?.name || ""; $("drs").textContent = "";
  list.innerHTML = '<li class="msg">Loading tracks…</li>';
  try {
    const a = await albumTracks(id);
    if (drawerAlbumId !== id) return;
    $("drt").textContent = a.title; $("drs").textContent = [a.artist, a.year, a.tracks.length + " tracks"].filter(Boolean).join(" · ");
    const discs = new Set(a.tracks.map(t => t.disc)).size > 1;
    list.innerHTML = "";
    let disc = 0;
    for (const t of a.tracks) {
      if (discs && t.disc !== disc) { disc = t.disc; const h = document.createElement("li"); h.className = "disc"; h.textContent = "Disc " + disc; list.appendChild(h); }
      const li = document.createElement("li"); li.className = "trk"; li.dataset.uri = t.uri;
      const extra = t.artists && t.artists !== a.artist ? ` <span class="ar">— ${esc(t.artists)}</span>` : "";
      li.innerHTML = `<span class="n">${t.n}</span><span class="nm">${esc(t.name)}${extra}</span><span class="d">${fmt(t.ms)}</span>`;
      li.onclick = e => { e.stopPropagation(); playTrack(a, t); };
      list.appendChild(li);
    }
    markNowTrack();
  } catch (err) { drawerAlbumId = null; list.innerHTML = `<li class="msg">${esc(err.message)}</li>`; }
}
async function playTrack(a, t) {
  player?.activateElement?.();
  if (player && currentTrackUris().includes(t.uri)) { player.togglePlay(); return; }
  const r = await startPlayback({ context_uri: a.uri, offset: { uri: t.uri } });
  if (!r.ok && r.status !== 202) toast("Couldn't play that track (" + r.status + ")");
}
function setDrawer(open) {
  if (open && !nowAlbumUri) return;
  $("player").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("barIn").title = open ? "Hide tracks" : "Show tracks";
  if (open) fillDrawer();
}
$("barIn").onclick = e => { if (e.target.closest(".ctrls")) return; setDrawer(!$("player").classList.contains("open")); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("player").classList.contains("open")) setDrawer(false); });
// Clicking anywhere outside the player closes the drawer
document.addEventListener("click", e => { if ($("player").classList.contains("open") && !e.target.closest("#player")) setDrawer(false); });
$("pp").onclick = () => player?.togglePlay();
$("logout").onclick = logout;
$("refresh").onclick = async () => { $("refresh").textContent = "Refreshing…"; try { await loadLibrary(); loadFollowed(true).catch(() => {}); } finally { $("refresh").textContent = "Refresh"; } };

// ---------- Track peek: see an album's tracks before adding it ----------
const peek = document.createElement("div"); peek.className = "peek"; peek.id = "peek"; peek.hidden = true; peek.setAttribute("role", "dialog");
document.body.appendChild(peek);
let peekFor = null;
function closePeek() { peek.hidden = true; peekFor = null; }
function placePeek(card) {
  const r = card.querySelector(".art").getBoundingClientRect(), w = Math.min(320, innerWidth - 32), gap = 10;
  let left = r.right + gap; if (left + w > innerWidth - 16) left = r.left - gap - w; if (left < 16) left = Math.max(16, Math.min(r.left, innerWidth - 16 - w));
  peek.style.width = w + "px"; peek.style.left = left + "px";
  const maxH = Math.min(innerHeight * 0.6, 520); peek.style.maxHeight = maxH + "px";
  peek.style.top = Math.max(16, Math.min(r.top, innerHeight - 100 - Math.min(maxH, peek.offsetHeight || maxH))) + "px";
}
async function peekTracks(a, card, ghost) {
  if (peekFor === a.id && !peek.hidden) return closePeek();
  peekFor = a.id;
  peek.innerHTML = `<div class="pk-h"><div><div class="pk-t">${esc(a.title)}</div><div class="pk-s">${esc(a.artist)}${a.year ? " · " + esc(a.year) : ""}</div></div>` +
    (ghost ? `<button class="pk-add" type="button">${ADD}<span>Add</span></button>` : "") + `</div><ol class="tracks"><li class="msg">Loading tracks…</li></ol>`;
  peek.hidden = false; placePeek(card);
  if (ghost) peek.querySelector(".pk-add").onclick = () => { closePeek(); saveAlbum(a); };
  try {
    const info = await albumTracks(a.id);
    if (peekFor !== a.id) return;
    peek.querySelector(".pk-s").textContent = [a.artist, a.year, info.tracks.length + " tracks", fmt(info.tracks.reduce((n, t) => n + t.ms, 0))].filter(Boolean).join(" · ");
    const list = peek.querySelector(".tracks"); list.innerHTML = "";
    const discs = new Set(info.tracks.map(t => t.disc)).size > 1; let disc = 0;
    for (const t of info.tracks) {
      if (discs && t.disc !== disc) { disc = t.disc; list.insertAdjacentHTML("beforeend", `<li class="disc">Disc ${disc}</li>`); }
      const li = document.createElement("li"); li.className = "trk"; li.dataset.uri = t.uri; li.title = "Play";
      const extra = t.artists && t.artists !== info.artist ? ` <span class="ar">— ${esc(t.artists)}</span>` : "";
      li.innerHTML = `<span class="n">${t.n}</span><span class="nm">${esc(t.name)}${extra}</span><span class="d">${fmt(t.ms)}</span>`;
      li.onclick = () => playTrack(info, t);
      list.appendChild(li);
    }
    const uris = currentTrackUris(); list.querySelectorAll(".trk").forEach(li => li.classList.toggle("now", uris.includes(li.dataset.uri)));
    placePeek(card);
  } catch (e) { if (peekFor === a.id) peek.querySelector(".tracks").innerHTML = `<li class="msg">${esc(e.message)}</li>`; }
}
document.addEventListener("click", e => { if (!peek.hidden && !peek.contains(e.target) && !e.target.closest(".peekbtn")) closePeek(); }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !peek.hidden) { e.stopImmediatePropagation(); closePeek(); } }, true);
addEventListener("scroll", () => { if (!peek.hidden) closePeek(); }, { passive: true });
$("sres").addEventListener("scroll", () => { if (!peek.hidden) closePeek(); }, { passive: true });
addEventListener("resize", closePeek);

// ---------- Search: find an artist by name, then add their albums ----------
const search = $("search"), q = $("q"), sres = $("sres");
var searchArtist = null; let searchTimer = null, searchSeq = 0;   // var: render() may run before this line
function setSearch(open) {
  search.hidden = !open; $("searchBtn").setAttribute("aria-expanded", open);
  if (open) { setSettings(false); setDrawer(false); q.focus(); q.select(); if (!searchArtist && q.value.trim().length < 2) showFollowed(); }
}
function inLibrary(a) {
  return albums.some(x => x.id === a.id || (x.artistId === a.artistId && normTitle(x.title) === normTitle(a.title)));
}
// With the search box empty, the panel lists the artists you follow so you can go through them
async function showFollowed() {
  const seq = searchSeq;
  if (!canFollow()) {
    sres.innerHTML = '<div class="ahd"><span class="sub" style="flex:1">Reconnect so Shelf can list the artists you follow and follow artists when you save albums.</span><button class="back" type="button">Reconnect</button></div>';
    sres.querySelector(".back").onclick = login; return;
  }
  if (!followed) sres.innerHTML = '<div class="msg">Loading the artists you follow…</div>';
  let list;
  try { list = await loadFollowed(); } catch (e) { if (seq === searchSeq) sres.innerHTML = `<div class="msg">${esc(e.message)}</div>`; return; }
  if (seq !== searchSeq || searchArtist || q.value.trim().length >= 2) return;
  const count = id => albums.filter(a => a.artistId === id).length;
  const sorted = [...list].sort((x, y) => sortKey(x.name).localeCompare(sortKey(y.name), undefined, { sensitivity: "base" }));
  const missing = unfollowedShelfArtists();
  sres.innerHTML = `<div class="ahd"><h3>Artists you follow</h3><span class="sub">${list.length}</span></div>` +
    (missing.length ? `<div class="ahd"><span class="sub" style="flex:1">${missing.length} artist${missing.length > 1 ? "s" : ""} on your shelf ${missing.length > 1 ? "aren't" : "isn't"} followed yet.</span><button class="back" type="button" id="followAll">Follow ${missing.length > 1 ? "them" : "it"}</button></div>` : "");
  if (missing.length) $("followAll").onclick = async e => { e.target.textContent = "Following…"; if (await followArtists(missing)) toast(`Now following ${missing.length} more artist${missing.length > 1 ? "s" : ""}`); showFollowed(); };
  if (!sorted.length) sres.insertAdjacentHTML("beforeend", '<div class="msg">You don\'t follow any artists yet</div>');
  showArtistResults(sorted.map(ar => ({ id: ar.id, name: ar.name, images: ar.img ? [{ url: ar.img, width: 64 }] : [], have: count(ar.id) })), true);
}

function showArtistResults(list, append = false) {
  if (!append) sres.innerHTML = "";
  if (!list.length && !append) { sres.innerHTML = '<div class="msg">No artists found</div>'; return; }
  for (const ar of list) {
    const have = albums.filter(a => a.artistId === ar.id).length;
    const b = document.createElement("button"); b.type = "button"; b.className = "ares";
    const img = pickImage(ar.images, 64);
    b.innerHTML = (img ? `<img alt="" src="${esc(img)}">` : '<span class="ph"></span>') +
      `<span><b>${esc(ar.name)}</b><small>${have ? `${have} album${have > 1 ? "s" : ""} in your library` : append ? "None in your library" : esc((ar.genres || []).slice(0, 2).join(", "))}</small></span>`;
    b.onclick = () => openArtist({ id: ar.id, name: ar.name });
    sres.appendChild(b);
  }
}
async function runSearch() {
  const text = q.value.trim(); const seq = ++searchSeq;
  searchArtist = null;
  if (text.length < 2) { showFollowed(); return; }
  const r = await api(`/search?type=artist&limit=8&q=${encodeURIComponent(text)}`);
  if (seq !== searchSeq) return;
  if (!r.ok) { sres.innerHTML = `<div class="msg">${r.status === 429 ? "Spotify is busy right now. Try again in a minute." : "Search didn't work (" + r.status + ")"}</div>`; return; }
  showArtistResults((await r.json()).artists?.items || []);
}
q.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
q.addEventListener("keydown", e => {
  if (e.key === "Enter") { clearTimeout(searchTimer); const first = sres.querySelector(".ares"); first ? first.click() : runSearch(); }
  if (e.key === "ArrowDown") { e.preventDefault(); sres.querySelector(".ares")?.focus(); }
});
sres.addEventListener("keydown", e => {
  if (!e.target.classList.contains("ares")) return;
  const all = [...sres.querySelectorAll(".ares")], i = all.indexOf(e.target);
  if (e.key === "ArrowDown") { e.preventDefault(); all[i + 1]?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); (all[i - 1] || q).focus(); }
});
async function openArtist(ar) {
  searchArtist = ar;
  sres.innerHTML = `<div class="msg">Loading ${esc(ar.name)}…</div>`;
  try { await fetchArtistAlbums(ar); }
  catch (e) { sres.innerHTML = `<div class="msg">${esc(e.message)}</div>`; return; }
  if (searchArtist === ar) showSearchAlbums();
}
function showSearchAlbums() {
  const ar = searchArtist; if (!ar || search.hidden) return;
  const list = moreCache[ar.id] || [];
  const have = list.filter(inLibrary).length;
  sres.innerHTML = `<div class="ahd"><button class="back" type="button">← Back</button><h3>${esc(ar.name)}</h3>` +
    `<span class="sub">${have} of ${list.length} in your library</span></div><div class="sgrid"></div>`;
  sres.querySelector(".back").onclick = () => { searchArtist = null; runSearch(); q.focus(); };
  const grid = sres.querySelector(".sgrid");
  if (!list.length) grid.outerHTML = '<div class="msg">No albums found</div>';
  for (const a of list) {
    const own = inLibrary(a), mine = own && (albums.find(x => x.id === a.id) || albums.find(x => x.artistId === a.artistId && normTitle(x.title) === normTitle(a.title)));
    grid.appendChild(cdEl(own ? mine : a, (a.year || "") + (own ? " · In library" : ""), null, !own));
  }
}
$("searchBtn").onclick = () => setSearch(search.hidden);
$("searchClose").onclick = () => setSearch(false);
search.addEventListener("click", e => { if (e.target === search) setSearch(false); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !search.hidden) { setSearch(false); $("searchBtn").focus(); }
  if (e.key === "/" && search.hidden && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName) && !$("topbar").hidden) { e.preventDefault(); setSearch(true); }
});

// ---------- New releases: once a week (Mondays), check the artists on your shelf ----------
// Spotify has no "new from artists I like" request, so this asks about one artist every few seconds
// in the background, remembers where it got to, and then stays quiet until next Monday.
const NEW_WINDOW_DAYS = 56;               // a release counts as new for 8 weeks
function thisMonday() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
var newState = store.get("shelf-new", null);    // {week, done: [artistIds], found: [albums], seen}
const saveNew = () => store.set("shelf-new", newState);
function newReleases() {
  return (newState?.found || []).filter(a => !inLibrary(a)).sort((x, y) => y.date.localeCompare(x.date));
}
function updateNewChip() {
  const n = newReleases().length, b = $("newBtn");
  b.hidden = !n; b.textContent = n ? `New ${n}` : "New";
  b.classList.toggle("unseen", !!n && !newState.seen);
}
let newTimer = null;
// Only one Shelf window checks at a time: the one holding a lock it refreshes every few seconds
const TAB_ID = Math.random().toString(36).slice(2);
function holdCheckLock() {
  const lock = store.get("shelf-new-lock", null);
  if (lock && lock.tab !== TAB_ID && Date.now() - lock.at < 20000) return false;
  store.set("shelf-new-lock", { tab: TAB_ID, at: Date.now() });
  return true;
}
async function checkNewReleases() {
  clearTimeout(newTimer);
  if (!store.get("shelf-token") || !albums.length) return;
  newState = store.get("shelf-new", newState);   // pick up progress another window made
  if (new Date().getDay() !== 1) return;    // only on Mondays; whatever was found stays until next Monday
  if (!holdCheckLock()) { newTimer = setTimeout(checkNewReleases, 30000); return; }
  const week = thisMonday();
  if (newState?.week !== week) { newState = { week, done: [], found: newState?.found || [], seen: newState?.seen ?? true, fresh: [] }; saveNew(); }
  const artists = [...new Map(albums.filter(a => a.artistId).map(a => [a.artistId, { id: a.artistId, name: a.artist }])).values()];
  const ar = artists.find(x => !newState.done.includes(x.id));
  if (!ar) {                                // finished this week: swap in this week's results
    if (newState.fresh) { newState.found = newState.fresh; newState.fresh = null; saveNew(); updateNewChip(); }
    return;
  }
  newState.fresh ||= [...newState.found];   // an artist added to the shelf mid-week
  const since = new Date(Date.now() - NEW_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  try {
    const r = await api(`/artists/${encodeURIComponent(ar.id)}/albums?include_groups=album,single&limit=10&market=from_token`);
    if (r.status === 429) { newTimer = setTimeout(checkNewReleases, 60000); return; }   // busy: try again in a minute
    if (r.ok) {
      const page = await r.json();
      for (const a of page.items) {
        if (a.release_date_precision !== "day" || a.release_date < since) continue;
        const al = { ...albumFromApi(a), artist: ar.name, artistId: ar.id, kind: a.album_type };
        if (!inLibrary(al) && !newState.fresh.some(x => x.id === al.id || (x.artistId === al.artistId && normTitle(x.title) === normTitle(al.title)))) {
          newState.fresh.push(al);
          if (!newState.found.some(x => x.id === al.id)) { newState.found.push(al); newState.seen = false; }
        }
      }
    }
    newState.done.push(ar.id); saveNew(); updateNewChip();
  } catch {}
  newTimer = setTimeout(checkNewReleases, 6000);
}
function showNew() {
  searchArtist = null; searchSeq++;
  const list = newReleases();
  const checking = newState?.fresh && new Date().getDay() === 1 ? ` · still checking (${newState.done.length} of ${new Set(albums.map(a => a.artistId)).size})` : "";
  sres.innerHTML = `<div class="ahd"><button class="back" type="button">← Back</button><h3>New releases</h3>` +
    `<span class="sub">From artists on your shelf, last 8 weeks${checking}</span></div><div class="sgrid"></div>`;
  sres.querySelector(".back").onclick = () => { q.value = ""; runSearch(); q.focus(); };
  const grid = sres.querySelector(".sgrid");
  if (!list.length) grid.outerHTML = '<div class="msg">Nothing new right now</div>';
  for (const a of list) grid.appendChild(cdEl(a, `${a.artist} · ${a.kind === "single" ? "Single/EP · " : ""}${new Date(a.date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, null, true));
  if (newState) { newState.seen = true; saveNew(); updateNewChip(); }
}
$("newBtn").onclick = () => { if (search.hidden) setSearch(true); showNew(); };

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
  // Re-check Spotify on opening only if the saved copy is over 15 minutes old (Refresh in Settings forces it)
  const fresh = albums.length && Date.now() - store.get("shelf-library-at", 0) < 15 * 60 * 1000;
  try { if (!fresh) await loadLibrary(); setTimeout(checkNewReleases, 5000); setInterval(checkNewReleases, 3600e3); }
  catch (e) {
    if (e.message === "not-logged-in" || /login failed/i.test(e.message)) showGate("Your Spotify login has expired. Please connect again.");
    else if (!albums.length) $("main").innerHTML = `<div class="loading">${esc(e.message)}</div>`;
  }
})();
