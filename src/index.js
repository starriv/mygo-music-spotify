// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 starriv and contributors.
//
// MyGo Music plugin for Spotify.
//
// Spotify gives third-party apps no audio, so this plugin uses MyGo Music's
// remote playback: the listener's own Spotify app (desktop, phone, speaker)
// makes the sound through Spotify Connect, and the plugin tells it what to
// play. The catalog and library come from the Spotify Web API, as it is for
// Development Mode apps after the February 2026 changes: one Client ID per
// listener, /me/library for saving, /playlists/{id}/items, and at most ten
// search results a page.
//
// MyGo Music supplies host and fetch; this module has no dependencies.

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";
const REDIRECT_PORT = 43821;
const REDIRECT_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPES = [
  "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
  "user-read-recently-played", "user-top-read", "user-read-playback-position",
  "user-library-read", "user-library-modify", "user-follow-read", "user-follow-modify",
  "playlist-read-private", "playlist-read-collaborative",
  "playlist-modify-private", "playlist-modify-public",
].join(" ");
const SEARCH_LIMIT = 10; // the Development Mode maximum
const PAGE = 50;
const PLAYLIST_LIMIT = 1000;
const LIBRARY_BATCH = 40; // /me/library takes at most 40 URIs
const EDIT_BATCH = 100; // playlist edits take at most 100 items
// How much of the app's queue goes to Spotify at once. When Spotify reaches
// the end, the app notices and sends the next part.
const QUEUE_WINDOW = 50;
const REQUEST_TIMEOUT = 15000;
const REFRESH_MARGIN = 60000;
// The shortest a request within a play's deadline may be given: enough to
// answer, and to say why it didn't before the app gives the command up.
const MIN_REQUEST = 1000;

// The host loads a module while holding its storage lock: read storage inside
// an exported action, never while the module initializes.
let session; // undefined until read; null when signed out
let epoch = 0;
let refreshing = null;
let me = null;
let searchCursors; // undefined until read: shown counts to Spotify's offsets

const t = (text) => host.t(text);

// A Development Mode app's quota is small, and Spotify keeps one per endpoint:
// when it is spent, one kind of read is refused for hours while the rest still
// answer. So a page names it only when one of its own reads met it, with the
// wait Spotify gave in Retry-After, rather than the passing refusal any request
// here can get.
const isQuota = (error) => error?.code === "quota";
function quotaBack(error) {
  const seconds = Number(error?.retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return t("It comes back on its own.");
  if (seconds >= 3600) return t("It comes back in about {hours} h.").replace("{hours}", String(Math.ceil(seconds / 3600)));
  return t("It comes back in about {minutes} min.").replace("{minutes}", String(Math.max(1, Math.ceil(seconds / 60))));
}
const quotaHead = () => t("Spotify's quota for your app is spent.");
// What a page that loaded without some of its parts says about them.
const quotaText = (error) => `${quotaHead()} ${t("Part of this page is missing.")} ${quotaBack(error)} ${t("Each app in the Spotify Developer Dashboard has a quota of its own.")}`;
// What a page that couldn't load at all says.
const quotaError = (error) => `${quotaHead()} ${quotaBack(error)} ${t("Each app in the Spotify Developer Dashboard has a quota of its own.")}`;
// A page with no description of its own says it in a grey row at the top of
// its songs, one the app can't play.
const QUOTA_ROW = "missing:quota";
const quotaRow = (error) => ({
  id: QUOTA_ROW, name: quotaHead(),
  artists: [{ id: "", name: `${t("Part of this page is missing.")} ${quotaBack(error)}` }],
  album: { id: "", name: "" }, duration: 0, unavailable: true,
});
const firstQuota = (results) => results.map((result) => result?.error ?? result).find(isQuota) || null;

function fail(code, message) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

const changed = () => fail("", t("Your Spotify account changed. Try again."));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clientId() {
  return String(host.setting("clientId") || "").trim();
}

function requireClientId() {
  const id = clientId();
  if (!id) throw fail("setup", t("Fill in the Client ID of your Spotify app."));
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    throw fail("setup", t("This doesn't look like a Spotify Client ID. Copy it from your app in the Spotify Developer Dashboard."));
  }
  return id;
}

function currentSession() {
  if (session === undefined) session = host.storage.get("session") || null;
  // Tokens belong to the app that issued them.
  if (session && session.clientId !== clientId()) clearSession();
  return session;
}

function persistSession() {
  if (session) host.storage.set("session", session);
  else host.storage.remove("session");
}

function clearSession() {
  epoch++;
  session = null;
  refreshing = null;
  me = null;
  pendingSignIn = null;
  forgetSearchCursors();
  stopLocal();
  host.storage.remove("session");
}

function requireSession() {
  requireClientId();
  const active = currentSession();
  if (!active) throw fail("signIn", t("Sign in to Spotify first."));
  return active;
}

// --- PKCE ---------------------------------------------------------------

// moejs has no crypto.subtle, so SHA-256 is computed here. The verifier only
// has to be unguessable for the minutes the sign-in takes.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256(bytes) {
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const length = bytes.length;
  const size = Math.ceil((length + 9) / 64) * 64;
  const block = new Uint8Array(size);
  block.set(bytes);
  block[length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(size - 8, Math.floor((length * 8) / 0x100000000));
  view.setUint32(size - 4, (length * 8) >>> 0);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0; hash[7] = (hash[7] + h) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  hash.forEach((value, i) => outView.setUint32(i * 4, value >>> 0));
  return out;
}

function base64url(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += alphabet[n & 63];
  }
  return out;
}

// utf8Bytes is the UTF-8 of text, for hashing: moejs needn't have TextEncoder.
function utf8Bytes(text) {
  const out = [];
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

// randomBytes answers bytes no one else can guess. MyGo Music's runtime has
// no Web Crypto (0.1.22), so when getRandomValues is missing, mix what the
// runtime does have: time, the runtime's own randomness, and platform. The
// verifier only has to stay unguessable for the minutes a sign-in takes.
function randomBytes(length) {
  const values = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return values;
  }
  let seed = `${Date.now()}|${globalThis.performance?.now?.() ?? ""}|${host.platform}|${host.arch}`;
  for (let i = 0; i < 16; i++) seed += `|${Math.random()}`;
  let state = sha256(utf8Bytes(seed));
  for (let offset = 0; offset < values.length; offset += 32) {
    const input = new Uint8Array(34);
    input.set(state);
    input[32] = offset & 0xff;
    input[33] = (offset >> 8) & 0xff;
    state = sha256(input);
    values.set(state.subarray(0, Math.min(32, values.length - offset)), offset);
  }
  return values;
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(randomBytes(length), (v) => chars[v % chars.length]).join("");
}

function codeChallenge(verifier) {
  return base64url(sha256(utf8Bytes(verifier)));
}

// --- Requests -----------------------------------------------------------

// timeoutFor answers how long a request may take: its usual limit, or less,
// as a play that must answer before the app gives it up has left.
const timeoutFor = (deadline) => (Number.isFinite(deadline)
  ? Math.max(MIN_REQUEST, Math.min(REQUEST_TIMEOUT, deadline - Date.now()))
  : REQUEST_TIMEOUT);

async function timedFetch(url, init, deadline) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(deadline));
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
  } catch {
    if (controller.signal.aborted) throw fail("", t("Spotify took too long to answer. Try again."));
    throw fail("", t("Can't reach Spotify. Check your connection and try again."));
  } finally {
    clearTimeout(timer);
  }
}

async function readJSON(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function tokenRequest(form) {
  const response = await timedFetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJSON(response);
  if (response.ok && body?.access_token) return body;
  // Never put tokens, codes or the verifier in an error.
  const code = body?.error;
  if (code === "invalid_grant") throw fail("signIn", t("Your Spotify sign-in has expired. Sign in again."));
  if (code === "invalid_client" || code === "unauthorized_client") {
    throw fail("setup", t("Spotify doesn't accept this Client ID. Check it in the plugin's settings."));
  }
  throw fail("", `${t("Spotify sign-in failed.")} (${code || `HTTP ${response.status}`})`);
}

function acceptTokens(target, body) {
  target.accessToken = body.access_token;
  target.expiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
  // Spotify may rotate the refresh token; keep the old one when it doesn't.
  if (body.refresh_token) target.refreshToken = body.refresh_token;
  if (body.scope) target.scope = body.scope;
}

function refresh(active) {
  if (refreshing?.session === active) return refreshing.promise;
  const generation = epoch;
  const promise = (async () => {
    try {
      const body = await tokenRequest({
        grant_type: "refresh_token", refresh_token: active.refreshToken, client_id: active.clientId,
      });
      if (generation !== epoch || session !== active) throw changed();
      acceptTokens(active, body);
      persistSession();
      return active.accessToken;
    } catch (error) {
      if (error.code === "signIn" && generation === epoch && session === active) clearSession();
      throw error;
    }
  })();
  const entry = { session: active, promise };
  refreshing = entry;
  promise.then(() => {}, () => {}).then(() => { if (refreshing === entry) refreshing = null; });
  return promise;
}

function accessToken(active) {
  if (active.accessToken && Date.now() < active.expiresAt - REFRESH_MARGIN) return active.accessToken;
  return refresh(active);
}

function apiError(status, body, retryAfter) {
  const detail = body?.error || {};
  const reason = detail.reason || "";
  const message = typeof detail.message === "string" ? detail.message : "";
  let error;
  if (status === 403 && reason === "PREMIUM_REQUIRED") {
    error = fail("unavailable", t("Controlling playback needs Spotify Premium."));
  } else if (status === 403 && /not registered|not been registered|user may not be registered/i.test(message)) {
    error = fail("setup", t("This Spotify account isn't allowed to use your app. Add it under User Management in the Spotify Developer Dashboard."));
  } else if (status === 429 && /QUOTA_EXCEEDED/i.test(reason)) {
    error = fail("quota", "");
    error.retryAfter = retryAfter;
    error.message = quotaError(error);
  } else if (status === 429) {
    error = fail("", t("Spotify is limiting requests. Wait a moment and try again."));
  } else if (status === 404) {
    error = fail("unavailable", t("Spotify can't find this. It may have been removed."));
  } else if (status >= 500) {
    error = fail("", `${t("Spotify is having trouble. Try again shortly.")} (HTTP ${status})`);
  } else {
    error = fail("", `${t("Spotify refused the request.")} (${status}${message ? `: ${message}` : ""})`);
  }
  error.status = status;
  error.reason = reason;
  return error;
}

// api calls the Web API as the signed-in listener. path is relative to /v1,
// or a `next` link Spotify gave.
async function api(method, path, { query, body, attempt = 0, deadline } = {}) {
  const active = requireSession();
  const generation = epoch;
  let url = path.startsWith("https://") ? path : API + path;
  if (!url.startsWith(`${API}/`)) throw fail("", t("Spotify gave an unexpected address."));
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const text = params.toString();
    if (text) url += (url.includes("?") ? "&" : "?") + text;
  }
  const token = await accessToken(active);
  if (generation !== epoch) throw changed();
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await timedFetch(url, init, deadline);
  if (generation !== epoch) throw changed();
  const data = await readJSON(response);
  if (response.ok) return data;
  if (response.status === 401 && attempt === 0) {
    // The token can be revoked before it expires: refresh once.
    active.expiresAt = 0;
    return api(method, path, { query, body, attempt: 1, deadline });
  }
  if (response.status === 401) {
    if (session === active) clearSession();
    throw fail("signIn", t("Your Spotify sign-in has expired. Sign in again."));
  }
  // A read that met a passing server error is worth one more try.
  if (method === "GET" && [502, 503, 504].includes(response.status) && attempt === 0) {
    await sleep(1000);
    if (generation !== epoch) throw changed();
    return api(method, path, { query, body, attempt: 1, deadline });
  }
  // A spent quota is hours away, whatever Retry-After says: no use waiting.
  if (response.status === 429 && attempt === 0 && !/QUOTA_EXCEEDED/i.test(data?.error?.reason || "")) {
    const wait = Number(response.headers.get("retry-after"));
    if (Number.isFinite(wait) && wait >= 0 && wait <= 5) {
      await sleep(Math.max(wait, 1) * 1000);
      if (generation !== epoch) throw changed();
      return api(method, path, { query, body, attempt: 1, deadline });
    }
  }
  throw apiError(response.status, data, Number(response.headers.get("retry-after")));
}

// more follows the `next` links of a page Spotify gave, adding their items
// to items, up to max. A page that adds nothing ends it, so a `next` that
// goes nowhere can't loop.
async function more(items, page, max) {
  let next = page?.next;
  while (next && items.length < max) {
    const following = await api("GET", next);
    const added = following?.items || [];
    if (!added.length) break;
    items.push(...added);
    next = following.next;
  }
  return items.slice(0, max);
}

// collect reads a list Spotify pages, up to max items.
async function collect(path, query, max) {
  const first = await api("GET", path, { query });
  return { items: await more([...(first?.items || [])], first, max) };
}

// --- Data ---------------------------------------------------------------

function idOf(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw fail("", t("This isn't a Spotify ID."));
  return id;
}

function offsetOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// Spotify lists an image's sizes widest first. Rows want small pictures and
// Now Playing about 600 pixels: take the widest up to 800.
function image(images) {
  if (!Array.isArray(images)) return "";
  const usable = images
    .filter((item) => item?.url && Number.isFinite(item.width))
    .sort((a, b) => b.width - a.width);
  // An image without a width can't be sized; only fall back to one if none has.
  if (!usable.length) return images.find((item) => item?.url)?.url || "";
  const pick = usable.find((item) => item.width <= 800) || usable[usable.length - 1];
  return pick.url;
}

// A character reference, or itself when it names no character.
function codePoint(code, text) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : text;
}

const ENTITIES = { quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&" };

function plainText(html) {
  // One pass, so "&#38;lt;" decodes to "&lt;" and not to "<".
  return String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});|&(quot|apos|lt|gt|nbsp|amp);/gi, (text, hex, dec, name) => {
      if (hex) return codePoint(parseInt(hex, 16), text);
      if (dec) return codePoint(Number(dec), text);
      return ENTITIES[name.toLowerCase()] ?? text;
    })
    .trim();
}

// plainOrHtml is for a description Spotify sends both as text and as HTML.
function plainOrHtml(text, html) {
  return html ? plainText(html) : String(text || "").trim();
}

function toArtist(artist = {}) {
  return { id: artist.id || "", name: artist.name || "", imageUrl: image(artist.images) };
}

function toAlbum(album = {}) {
  return {
    id: album.id || "", name: album.name || "", imageUrl: image(album.images),
    artists: (album.artists || []).map(toArtist), released: album.release_date || "",
  };
}

function missing(kind, index) {
  return {
    id: `missing:${index}`, name: kind === "episode" ? t("Unavailable episode") : t("Unavailable song"),
    album: { id: "", name: "" }, duration: 0, unavailable: true,
  };
}

function toEpisode(episode, show = episode.show) {
  return {
    id: `episode:${episode.id}`, name: episode.name || "", showId: show?.id || "",
    artists: show?.name ? [{ id: "", name: show.name }] : [],
    album: { id: "", name: show?.name || "", imageUrl: image(episode.images) || image(show?.images) },
    duration: episode.duration_ms || 0,
    description: plainOrHtml(episode.description, episode.html_description),
    published: episode.release_date || "",
    url: episode.external_urls?.spotify || `https://open.spotify.com/episode/${episode.id}`,
    unavailable: episode.is_playable === false,
  };
}

function toTrack(track, album, index = 0) {
  if (!track) return missing("track", index);
  if (track.type === "episode") return toEpisode(track);
  const result = {
    id: track.id, name: track.name || "",
    artists: (track.artists || []).map(toArtist),
    album: toAlbum(track.album || album || {}),
    duration: track.duration_ms || 0,
    url: track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : ""),
    unavailable: track.is_playable === false || !!track.restrictions,
  };
  if (track.is_local || !track.id) {
    // Local files can't be played through the Web API, but can still be taken
    // out of a playlist by their URI.
    result.id = `local:${encodeURIComponent(track.uri || `${track.name}:${index}`)}`;
    result.url = "";
    result.unavailable = true;
  }
  return result;
}

function toPlaylist(playlist, profile) {
  const mine = !!profile && playlist.owner?.id === profile.id;
  return {
    id: playlist.id, name: playlist.name || "", imageUrl: image(playlist.images),
    description: plainText(playlist.description),
    owner: playlist.owner?.display_name || playlist.owner?.id || "",
    trackCount: (playlist.items ?? playlist.tracks)?.total || 0,
    mine, saved: !mine,
  };
}

function toShow(show) {
  return {
    id: show.id, name: show.name || "", imageUrl: image(show.images),
    description: plainOrHtml(show.description, show.html_description),
    episodeCount: show.total_episodes || 0,
  };
}

// uriOf turns the app's track ID back into Spotify's URI, or null for one
// that Spotify can't play.
function uriOf(id) {
  const value = String(id);
  if (value.startsWith("episode:")) return `spotify:episode:${idOf(value.slice(8))}`;
  if (value.startsWith("local:") || value.startsWith("missing:")) return null;
  return `spotify:track:${idOf(value)}`;
}

function chunks(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
  return result;
}

// /me/library takes the URIs as a comma-separated query parameter.
function libraryPath(path, uris) {
  return `${path}?uris=${uris.map(encodeURIComponent).join(",")}`;
}

async function contains(uris) {
  const result = [];
  for (const batch of chunks(uris, LIBRARY_BATCH)) {
    const answer = await api("GET", libraryPath("/me/library/contains", batch));
    result.push(...batch.map((_, i) => Array.isArray(answer) && answer[i] === true));
  }
  return result;
}

// savedFlag says whether one thing is in the listener's library, for a page
// that shows it. The page is worth more than the flag: if Spotify can't say,
// it shows as not saved, unless the listener has to sign in.
async function savedFlag(uri) {
  try {
    return (await contains([uri]))[0];
  } catch (error) {
    if (error.code === "signIn" || error.code === "setup") throw error;
    return false;
  }
}

async function setSaved(uris, on) {
  for (const batch of chunks(uris, LIBRARY_BATCH)) {
    await api(on ? "PUT" : "DELETE", libraryPath("/me/library", batch));
  }
}

// --- Account ------------------------------------------------------------

async function profile() {
  const active = requireSession();
  if (me && me.session === active && Date.now() - me.at < 300000) return me.profile;
  const generation = epoch;
  const data = await api("GET", "/me");
  if (generation !== epoch || session !== active) throw changed();
  const result = {
    id: data?.id || "", name: data?.display_name || data?.id || "Spotify",
    imageUrl: image(data?.images), page: "me",
  };
  me = { session: active, profile: result, at: Date.now() };
  return result;
}

export async function account() {
  if (!clientId() || !currentSession()) return null;
  try {
    return await profile();
  } catch (error) {
    if (error.code === "signIn") return null;
    throw error;
  }
}

// A sign-in still waiting for the browser holds the redirect port. Signing in
// again meanwhile, as after closing the sign-in window, opens the same page
// and waits for the same redirect, rather than failing on the busy port.
let pendingSignIn = null;

export async function signIn() {
  const id = requireClientId();
  if (pendingSignIn?.clientId === id) {
    host.signInPrompt({ text: t("Finish signing in to Spotify in your browser…") });
    host.openURL(pendingSignIn.url);
    return pendingSignIn.promise;
  }
  const verifier = randomString(64);
  const state = randomString(24);
  const url = `${ACCOUNTS}/authorize?${new URLSearchParams({
    client_id: id, response_type: "code", redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256", code_challenge: codeChallenge(verifier),
    state, scope: SCOPES,
  })}`;
  const entry = { clientId: id, url };
  entry.promise = completeSignIn(id, url, verifier, state);
  pendingSignIn = entry;
  const done = () => { if (pendingSignIn === entry) pendingSignIn = null; };
  entry.promise.then(done, done);
  return entry.promise;
}

async function completeSignIn(id, url, verifier, state) {
  const generation = ++epoch;
  // Listen before the browser opens, so the redirect can't arrive first.
  const redirect = host.waitForRedirect({
    port: REDIRECT_PORT, path: REDIRECT_PATH, timeout: 270000,
    page: t("Signed in to Spotify. You can close this page and go back to MyGo Music."),
  });
  host.signInPrompt({ text: t("Finish signing in to Spotify in your browser…") });
  host.openURL(url);
  let query;
  try {
    query = await redirect;
  } catch (error) {
    if (/in use|bind/i.test(String(error?.message))) {
      throw fail("", t("Another program is using port 43821. Close it and sign in again."));
    }
    throw fail("", t("Sign-in timed out. Sign in again."));
  }
  if (generation !== epoch) throw changed();
  if (query?.state !== state) throw fail("", t("The sign-in didn't come back from this request. Sign in again."));
  if (query.error) {
    throw fail("", query.error === "access_denied" ? t("Spotify sign-in was cancelled.") : `${t("Spotify sign-in failed.")} (${query.error})`);
  }
  if (!query.code) throw fail("", t("Spotify sign-in failed."));
  const body = await tokenRequest({
    grant_type: "authorization_code", code: query.code, redirect_uri: REDIRECT_URI,
    client_id: id, code_verifier: verifier,
  });
  if (generation !== epoch) throw changed();
  if (!body.refresh_token) throw fail("", t("Spotify didn't return a lasting sign-in. Sign in again."));
  const pending = { clientId: id };
  acceptTokens(pending, body);
  clearSession();
  session = pending;
  persistSession();
  try {
    const result = await profile();
    host.signInPrompt({ text: t("Signed in") });
    return result;
  } catch (error) {
    // A Development Mode app refuses accounts not on its user list. A passing
    // failure of the profile read doesn't make the sign-in worth discarding.
    if (session === pending && (error.code === "setup" || error.code === "signIn")) clearSession();
    throw error;
  }
}

export function signOut() {
  // Spotify has no token revocation; forgetting the tokens signs out here.
  // The listener can remove the app's access at spotify.com/account/apps.
  clearSession();
  forgetLocal();
  forgetPlayer();
  // A built-in player chosen for this account isn't chosen for the next one.
  host.storage.remove("device");
}

export function setSetting({ key, value }) {
  if (key === "soloistKey") {
    // Start Soloist with the new key right away, in the background, so it can
    // be paired from a Spotify app now, before the first play asks for it.
    stopLocal();
    const next = String(value || "").trim();
    if (next && clientId() && currentSession()) startLocal().catch(() => {});
    if (!next && host.storage.get("device") === LOCAL) host.storage.remove("device");
  }
  if (key === "clientId") {
    clearSession();
    forgetLocal();
    host.storage.remove("device");
  }
}

// --- Pages --------------------------------------------------------------

async function recentTracks() {
  const data = await api("GET", "/me/player/recently-played", { query: { limit: PAGE } });
  const seen = new Set();
  const tracks = [];
  for (const entry of data?.items || []) {
    const track = toTrack(entry?.track);
    if (track.id.startsWith("missing:") || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
  }
  return tracks;
}

async function topTracks(range, limit) {
  const data = await api("GET", "/me/top/tracks", { query: { time_range: range, limit } });
  return (data?.items || []).filter(Boolean).map((track) => toTrack(track));
}

async function topArtists(range, limit) {
  const data = await api("GET", "/me/top/artists", { query: { time_range: range, limit } });
  return (data?.items || []).filter(Boolean).map(toArtist);
}

// The artists the listener follows. Spotify pages them by cursor, under
// `artists`, so they are read here rather than by collect.
async function followedArtists(max = 1000) {
  const items = [];
  let next = null;
  let data = await api("GET", "/me/following", { query: { type: "artist", limit: PAGE } });
  while (data) {
    const page = data.artists || {};
    const added = (page.items || []).filter(Boolean);
    items.push(...added);
    next = page.next;
    if (!next || !added.length || items.length >= max) break;
    data = await api("GET", next);
  }
  return items.slice(0, max).map((artist) => ({ ...toArtist(artist), following: true }));
}

// settled runs optional sections side by side. One that fails says so in its
// section, unless the listener has to sign in or set the plugin up.
async function settled(tasks) {
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected" && ["signIn", "setup"].includes(result.reason?.code)) throw result.reason;
  }
  return results.map((result) => (result.status === "fulfilled" ? { value: result.value } : { error: result.reason }));
}

const emptyOr = (result, empty) => (result.error ? `${t("Couldn't load this.")} ${result.error.message}` : empty);

export async function home() {
  requireSession();
  const [recentResult, tracksResult, artistsResult, listsResult] = await settled([
    recentTracks(), topTracks("short_term", 20), topArtists("medium_term", 20), playlists(20),
  ]);
  return {
    title: "Spotify",
    sections: [
      {
        title: t("Recently played"), pageTitle: t("Recently played"),
        subtitle: t("From your Spotify listening history"),
        tracks: recentResult.value || [], morePage: "recent",
        empty: emptyOr(recentResult, t("Play something in Spotify and it shows here.")),
      },
      {
        title: t("Your top tracks"), tracks: tracksResult.value || [], morePage: "top",
        empty: emptyOr(tracksResult, t("Spotify needs more listening to pick your top tracks.")),
      },
      {
        title: t("Your top artists"), artists: artistsResult.value || [],
        empty: emptyOr(artistsResult, t("Spotify needs more listening to pick your top artists.")),
      },
      {
        title: t("Your playlists"), playlists: (listsResult.value || []).slice(0, 20), morePage: "playlists",
        empty: emptyOr(listsResult, t("You have no playlists yet.")),
      },
    ],
  };
}

// The pages this plugin makes up show their description under the title, so
// that is where a spent quota is said, when one of the page's own reads met
// it. Home has no such line of its own (the app heads it instead): there a
// section the quota emptied says so in its empty text.
const quotaLine = (results) => {
  const error = firstQuota(results);
  return error ? { description: quotaText(error) } : {};
};

export async function browse({ page }) {
  if (page === "recent") {
    const [recentResult] = await settled([recentTracks()]);
    return {
      title: t("Recently played"), ...quotaLine([recentResult]),
      sections: [{
        tracks: recentResult.value || [],
        empty: emptyOr(recentResult, t("Play something in Spotify and it shows here.")),
      }],
    };
  }
  if (page === "top") {
    const [month, halfYear, artists] = await settled([
      topTracks("short_term", 50), topTracks("medium_term", 50), topArtists("medium_term", 50),
    ]);
    return {
      title: t("Top tracks"), ...quotaLine([month, halfYear, artists]),
      sections: [
        { title: t("Last 4 weeks"), tracks: month.value || [], empty: emptyOr(month, t("Not enough listening yet.")) },
        { title: t("Last 6 months"), tracks: halfYear.value || [], empty: emptyOr(halfYear, t("Not enough listening yet.")) },
        { title: t("Top artists"), artists: artists.value || [], empty: emptyOr(artists, t("Not enough listening yet.")) },
      ],
    };
  }
  if (page === "me") {
    const [profileResult, listsResult] = await settled([profile(), playlists()]);
    const lists = listsResult.value || [];
    return {
      title: profileResult.value?.name || "", imageUrl: profileResult.value?.imageUrl, ...quotaLine([profileResult, listsResult]),
      sections: [{
        title: t("Your playlists"), playlists: lists.filter((item) => item.mine),
        empty: emptyOr(listsResult, t("You have no playlists yet.")),
      }],
    };
  }
  if (page === "playlists") {
    const [listsResult] = await settled([playlists()]);
    const lists = listsResult.value || [];
    const theirs = lists.filter((item) => !item.mine);
    return {
      title: t("Playlists"), ...quotaLine([listsResult]),
      sections: [
        {
          title: t("Created by you"), playlists: lists.filter((item) => item.mine),
          empty: emptyOr(listsResult, t("You have no playlists yet.")),
        },
        // Only worth a heading when there are some, or when it failed.
        ...(theirs.length || listsResult.error
          ? [{ title: t("Saved playlists"), playlists: theirs, empty: emptyOr(listsResult, "") }]
          : []),
      ],
    };
  }
  if (page === "following") {
    const [artistsResult] = await settled([followedArtists()]);
    return {
      title: t("Following"), ...quotaLine([artistsResult]),
      sections: [{
        artists: artistsResult.value || [],
        empty: emptyOr(artistsResult, t("Artists you follow in Spotify show here.")),
      }],
    };
  }
  throw fail("unsupported", t("There's no such page."));
}

export async function recent() {
  return recentTracks();
}

// The app asks for the next page at the number of results it already shows.
// Spotify can answer null for an item it no longer has, so remember where in
// Spotify can answer null for an item it no longer has, so the app's count of
// results shown isn't Spotify's offset. Each page's mapping is kept in the
// plugin's storage too, so a restarted plugin still asks for the right page.
const SEARCH_CURSORS = "searchCursors";
const SEARCH_CURSOR_KEYS = 20; // queries remembered
const SEARCH_CURSOR_OFFSETS = 400; // pages remembered for one

function searchCursorState() {
  if (searchCursors) return searchCursors;
  let saved;
  try { saved = host.storage.get(SEARCH_CURSORS); } catch { saved = null; }
  searchCursors = new Map();
  if (saved && typeof saved === "object") {
    for (const [key, pairs] of Object.entries(saved)) {
      if (!Array.isArray(pairs)) continue;
      const cursor = new Map();
      for (const pair of pairs) {
        if (Array.isArray(pair) && pair.length === 2
          && Number.isSafeInteger(pair[0]) && Number.isSafeInteger(pair[1])) {
          cursor.set(pair[0], pair[1]);
        }
      }
      if (cursor.size) searchCursors.set(key, cursor);
    }
  }
  return searchCursors;
}

function persistSearchCursors() {
  const saved = {};
  for (const [key, cursor] of searchCursors || new Map()) {
    saved[key] = [...cursor.entries()].slice(-SEARCH_CURSOR_OFFSETS);
  }
  // Keeping the place is a convenience: a search still answers without it.
  try { host.storage.set(SEARCH_CURSORS, saved); } catch {}
}

function forgetSearchCursors() {
  searchCursors = undefined;
  try { host.storage.remove(SEARCH_CURSORS); } catch {}
}

// searchKey keeps the listener's query out of the plugin's storage.
function searchKey(kind, text) {
  return base64url(sha256(utf8Bytes(`${kind}\n${text}`)));
}

function searchCursor(key, offset) {
  const all = searchCursorState();
  let cursor = all.get(key);
  if (!cursor || offset === 0) {
    cursor = new Map([[0, 0]]);
    all.delete(key);
    all.set(key, cursor);
    while (all.size > SEARCH_CURSOR_KEYS) all.delete(all.keys().next().value);
  }
  return cursor;
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const types = {
    tracks: ["track", (item) => toTrack(item)], albums: ["album", toAlbum], artists: ["artist", toArtist],
    playlists: ["playlist", null], shows: ["show", toShow],
  };
  const type = types[kind];
  if (!type) throw fail("unsupported", t("Spotify searches songs, albums, artists, playlists and podcasts."));
  const text = String(query || "").trim();
  if (!text) return { [kind]: [], more: false };
  requireSession();
  offset = offsetOf(offset);
  const cursor = searchCursor(searchKey(kind, text), offset);
  const raw = cursor.get(offset) ?? offset;
  const data = await api("GET", "/search", { query: { q: text, type: type[0], limit: SEARCH_LIMIT, offset: raw } });
  const page = data?.[kind] || {};
  const items = page.items || [];
  const map = type[1] || (await profile().then((profileResult) => (item) => toPlaylist(item, profileResult)));
  const results = items.filter(Boolean).map(map);
  cursor.set(offset + results.length, raw + items.length);
  persistSearchCursors();
  return { [kind]: results, more: !!page.next && items.length > 0 };
}

// --- Playlist songs as Spotify's own player reads them -------------------
//
// The Web API answers a Development Mode app with a playlist's cover, name
// and length when the listener doesn't own it, and leaves the songs out. The
// identity Spotify's own clients sign in with reads them anyway, so such a
// playlist is read from spclient instead: its rows from /playlist/v2, and the
// songs in those rows from /extended-metadata, five hundred at a time. That
// identity is a second browser approval, so it is asked for when a playlist
// first needs it, never at sign-in.

const PLAYER = "player";
const PLAYER_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
const PLAYER_PORT = 8898; // the port Spotify's own player answers on
const PLAYER_PATH = "/login";
const PLAYER_REDIRECT = `http://127.0.0.1:${PLAYER_PORT}${PLAYER_PATH}`;
const PLAYER_SCOPE = "streaming";
const SPCLIENT = "https://spclient.wg.spotify.com";
const ROWS_PAGE = 200; // spclient truncates a longer range of rows
const METADATA_BATCH = 500; // songs per /extended-metadata request
// The kinds Spotify's own clients ask /extended-metadata for.
const ARTIST_V4 = 8;
const ALBUM_V4 = 9;
const TRACK_V4 = 10;
const SPCLIENT_PARALLEL = 4; // requests in flight at once
const TRACK_TTL = 30 * 60 * 1000;
const TRACK_CACHE_MAX = 4000;
const ROWS_TTL = 5 * 60 * 1000;

let player; // undefined until read; null when never approved
let playerTokenRefresh = null;
let playerPending = null;
let playerRefused = false; // this run only: never open a second browser window
const trackCache = new Map(); // track URI to { track, at }
const rowsCache = new Map(); // playlist ID to { uris, total, at }

function currentPlayer() {
  if (player === undefined) player = host.storage.get(PLAYER) || null;
  return player;
}

function persistPlayer() {
  if (player) host.storage.set(PLAYER, player);
  else host.storage.remove(PLAYER);
}

function forgetPlayer() {
  player = null;
  playerTokenRefresh = null;
  playerPending = null;
  rowsCache.clear();
  trackCache.clear();
  persistPlayer();
}

// One more browser approval, for the identity Spotify's own clients use. A
// listener who closes the page keeps a plugin that works as it did before.
// prompt says what the approval is for.
async function playerSignIn(prompt) {
  if (playerPending) {
    host.signInPrompt({ text: t("Finish signing in to Spotify in your browser…") });
    host.openURL(playerPending.url);
    return playerPending.promise;
  }
  const verifier = randomString(64);
  const state = randomString(24);
  const url = `${ACCOUNTS}/authorize?${new URLSearchParams({
    client_id: PLAYER_CLIENT_ID, response_type: "code", redirect_uri: PLAYER_REDIRECT,
    code_challenge_method: "S256", code_challenge: codeChallenge(verifier),
    state, scope: PLAYER_SCOPE,
  })}`;
  const entry = { url };
  entry.promise = (async () => {
    // Listen before the browser opens, so the redirect can't arrive first.
    const redirect = host.waitForRedirect({
      port: PLAYER_PORT, path: PLAYER_PATH, timeout: 180000,
      page: t("Signed in to Spotify. You can close this page and go back to MyGo Music."),
    });
    host.signInPrompt({ text: prompt || t("Reading this playlist's songs needs one more Spotify approval. Close the page to skip.") });
    host.openURL(url);
    const query = await redirect;
    if (query?.error || !query?.code || query.state !== state) {
      throw fail("", t("That approval didn't come back from this request."));
    }
    const body = await tokenRequest({
      grant_type: "authorization_code", code: query.code, redirect_uri: PLAYER_REDIRECT,
      client_id: PLAYER_CLIENT_ID, code_verifier: verifier,
    });
    if (!body.refresh_token) throw fail("", t("Spotify didn't return a lasting approval."));
    player = { accessToken: body.access_token, refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
    // The approval has to be for the account the app is signed in as: another
    // one would answer with that account's playlists. Only its own account can
    // read its rootlist, which is the one question this token can answer.
    try {
      const account = await profile();
      await spclient("GET", `/playlist/v2/user/${account.id}/rootlist?from=0&length=0`);
    } catch (error) {
      player = null;
      persistPlayer();
      if (error?.status === 403) throw fail("", t("That approval was for a different Spotify account. Approve the one you're signed in as."));
      throw error;
    }
    persistPlayer();
    return player;
  })();
  playerPending = entry;
  const done = () => { if (playerPending === entry) playerPending = null; };
  entry.promise.then(done, done);
  return entry.promise;
}

function playerToken(prompt) {
  const active = currentPlayer();
  if (!active) return playerSignIn(prompt).then((value) => value.accessToken);
  if (active.accessToken && Date.now() < active.expiresAt - REFRESH_MARGIN) return Promise.resolve(active.accessToken);
  if (playerTokenRefresh) return playerTokenRefresh;
  const promise = (async () => {
    try {
      const body = await tokenRequest({
        grant_type: "refresh_token", refresh_token: active.refreshToken, client_id: PLAYER_CLIENT_ID,
      });
      acceptTokens(active, body);
      persistPlayer();
      return active.accessToken;
    } catch (error) {
      // Spotify revoked the approval. Keeping it would fail the same way on
      // every page and never ask again: forget it, so the next page that
      // needs it asks for a new one.
      // It isn't the app's own sign-in that ended, so it mustn't read as one.
      if (error?.code === "signIn") {
        if (player === active) forgetPlayer();
        throw fail("playerRevoked", t("Spotify withdrew the extra approval. The next page that needs it asks again."));
      }
      throw error;
    }
  })();
  const release = () => { if (playerTokenRefresh === promise) playerTokenRefresh = null; };
  playerTokenRefresh = promise;
  promise.then(release, release);
  return promise;
}

// --- Protobuf, as much of it as these answers need ----------------------

function pbVarint(value) {
  const bytes = [];
  let left = value;
  while (left > 0x7f) {
    bytes.push((left & 0x7f) | 0x80);
    left = Math.floor(left / 128);
  }
  bytes.push(left);
  return Uint8Array.from(bytes);
}

function pbJoin(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

const pbTag = (number, wire) => pbVarint(number * 8 + wire);
const pbBytes = (number, value) => pbJoin([pbTag(number, 2), pbVarint(value.length), value]);
const pbString = (number, value) => pbBytes(number, utf8Bytes(value));
const pbInt = (number, value) => pbJoin([pbTag(number, 0), pbVarint(value)]);

// pbRead answers the fields of one message: a number for a varint, the bytes
// for anything longer. A length that runs past the answer is a refusal, not a
// reason to read whatever follows.
function pbRead(bytes) {
  const fields = [];
  let at = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= bytes.length) throw fail("", t("Spotify sent something this plugin can't read."));
      const byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (at < bytes.length) {
    const key = readVarint();
    const number = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) fields.push({ n: number, value: readVarint() });
    else if (wire === 2) {
      const length = readVarint();
      fields.push({ n: number, value: bytes.subarray(at, at + length) });
      at += length;
    } else if (wire === 5) at += 4;
    else if (wire === 1) at += 8;
    else throw fail("", t("Spotify sent something this plugin can't read."));
  }
  return fields;
}

const pbFirst = (fields, number) => fields.find((field) => field.n === number)?.value;
const pbAll = (fields, number) => fields.filter((field) => field.n === number).map((field) => field.value);
const decoder = new TextDecoder();
const pbText = (value) => (value === undefined ? "" : decoder.decode(value));
const pbSint = (value) => (value === undefined ? 0 : value % 2 ? -(value + 1) / 2 : value / 2);

// Spotify writes an ID as 22 base62 digits of its 16 bytes, and hands a gid
// back as those bytes.
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function base62(bytes) {
  if (!bytes || !bytes.length) return "";
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 62;
      carry = Math.floor(carry / 62);
    }
    while (carry) {
      digits.push(carry % 62);
      carry = Math.floor(carry / 62);
    }
  }
  return digits.reverse().map((digit) => BASE62[digit]).join("").padStart(22, "0");
}

const hexOf = (bytes) => Array.from(bytes || [], (byte) => byte.toString(16).padStart(2, "0")).join("");

// The country whose charts to read. Spotify's own clients take it from the
// account, which the Web API no longer tells, so a listener who wants another
// country's charts names it in the settings, and the session's own answer
// stands when they don't.
function market() {
  const value = String(host.setting("market") || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : "";
}

// The 16 bytes behind an ID's 22 base62 digits: the request that asks for
// metadata by gid spells them in hex.
function gidOf(id) {
  let digits = [...String(id)].map((character) => BASE62.indexOf(character));
  if (!digits.length || digits.some((digit) => digit < 0)) return "";
  const bytes = [];
  while (digits.length) {
    let rest = 0;
    const next = [];
    for (const digit of digits) {
      rest = rest * 62 + digit;
      const value = Math.floor(rest / 256);
      rest %= 256;
      if (next.length || value) next.push(value);
    }
    bytes.push(rest);
    digits = next;
  }
  while (bytes.length < 16) bytes.push(0);
  return bytes.reverse().map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- spclient requests ---------------------------------------------------

// Spotify paces spclient as it paces the Web API. A few reads run at once, so
// a long playlist doesn't open a hundred connections, and a refused one waits
// as long as Spotify asks before giving the page a reason.
let spclientFree = SPCLIENT_PARALLEL;
const spclientWaiting = [];

async function spclientSlot(task) {
  if (spclientFree) spclientFree--;
  else await new Promise((resolve) => spclientWaiting.push(resolve));
  try {
    return await task();
  } finally {
    const next = spclientWaiting.shift();
    if (next) next();
    else spclientFree++;
  }
}

// prompt says what an approval asked for here is for.
async function spclient(method, path, body, prompt) {
  return spclientSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      const token = await playerToken(prompt);
      const headers = { Authorization: `Bearer ${token}` };
      const init = { method, headers };
      if (body) {
        headers["Content-Type"] = "application/x-protobuf";
        init.body = body;
      }
      const response = await timedFetch(`${SPCLIENT}${path}`, init);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (response.status === 401 && attempt === 0) {
        // The token can be revoked before it expires: refresh once.
        const active = currentPlayer();
        if (active) active.expiresAt = 0;
        continue;
      }
      if (method === "GET" && [502, 503, 504].includes(response.status) && attempt === 0) {
        await sleep(1000);
        continue;
      }
      if (response.status === 429 && attempt === 0) {
        const wait = Number(response.headers.get("retry-after"));
        if (Number.isFinite(wait) && wait >= 0 && wait <= 5) {
          await sleep(Math.max(wait, 1) * 1000);
          continue;
        }
      }
      const refused = fail("unavailable", `${t("Spotify refused the request.")} (${response.status})`);
      refused.status = response.status;
      throw refused;
    }
  });
}

const rowsPath = (id, from) =>
  `/playlist/v2/playlist/${id}?decorate=revision,length,attributes,owner&from=${from}&length=${ROWS_PAGE}`;

// The songs of a playlist in order, however long it is. A page of rows is 200
// at most, so a longer playlist is read a page at a time.
async function readRows(id) {
  const cached = rowsCache.get(id);
  if (cached && Date.now() - cached.at < ROWS_TTL) return cached;
  const page = async (from) => {
    const fields = pbRead(await spclient("GET", rowsPath(id, from)));
    const contents = pbFirst(fields, 5);
    const rows = contents ? pbRead(contents) : [];
    const all = pbAll(rows, 3).map((item) => pbText(pbFirst(pbRead(item), 1)));
    return {
      total: pbFirst(fields, 2) || 0,
      truncated: pbFirst(rows, 2) === 1,
      seen: all.length,
      // Local files and episodes sit in playlists beside songs, and count in
      // its length: every row is kept, so the page matches Spotify's count.
      uris: all.filter(Boolean),
    };
  };
  const head = await page(0);
  const uris = [...head.uris];
  let seen = head.seen;
  let truncated = head.truncated;
  while (truncated && seen < PLAYLIST_LIMIT) {
    const next = await page(seen);
    if (!next.seen) break;
    uris.push(...next.uris);
    seen += next.seen;
    truncated = next.truncated;
  }
  const value = { uris, total: Math.max(head.total, seen), at: Date.now() };
  rowsCache.set(id, value);
  return value;
}

// --- Songs, five hundred to a request ------------------------------------

// /extended-metadata takes a list of songs and answers their details in one
// answer, so a thousand-song playlist costs two requests, not a thousand.
function trackFrom(uri, fields) {
  const id = uri.slice("spotify:track:".length);
  const albumField = pbFirst(fields, 3);
  const album = albumField ? pbRead(albumField) : [];
  const artists = pbAll(fields, 4).map((artist) => {
    const message = pbRead(artist);
    return { id: base62(pbFirst(message, 1)), name: pbText(pbFirst(message, 2)), imageUrl: "" };
  });
  const name = pbText(pbFirst(fields, 2));
  return {
    id, name,
    artists,
    album: {
      id: base62(pbFirst(album, 1)), name: pbText(pbFirst(album, 2)),
      imageUrl: coverOf(album), artists: [], released: "",
    },
    duration: Math.max(0, pbSint(pbFirst(fields, 7))),
    url: `https://open.spotify.com/track/${id}`,
    unavailable: !name,
  };
}

// A song's album picture, from the size Spotify labels large: a row shows it
// a few dozen points wide, and the largest is a few times the bytes for it.
function coverOf(album) {
  const group = pbFirst(album, 17);
  const images = group
    ? pbAll(pbRead(group), 1).map((image) => pbRead(image))
    : pbAll(album, 9).map((image) => pbRead(image));
  const usable = images.filter((image) => pbFirst(image, 1)?.length);
  if (!usable.length) return "";
  const size = (image) => pbFirst(image, 2);
  const pick = usable.find((image) => size(image) === 2) || usable.find((image) => size(image) === 3) || usable[0];
  return `https://i.scdn.co/image/${hexOf(pbFirst(pick, 1))}`;
}

// A local file has no metadata to ask for: its row spells out what it is.
function localTrack(uri, index) {
  const [artist = "", album = "", title = "", seconds = ""] = uri.split(":").slice(2);
  const text = (value) => {
    try { return decodeURIComponent(value).replace(/\+/g, " "); } catch { return value; }
  };
  return {
    id: `local:${encodeURIComponent(uri)}`, name: text(title),
    artists: artist ? [{ id: "", name: text(artist), imageUrl: "" }] : [],
    album: { id: "", name: text(album), imageUrl: "", artists: [], released: "" },
    duration: Math.max(0, Number(seconds) || 0) * 1000,
    url: "", unavailable: true,
  };
}

// Albums, in one request the way songs are read: an artist's album groups
// name nothing, only their gids.
function albumFrom(uri, fields) {
  const id = uri.slice("spotify:album:".length);
  return {
    id, name: pbText(pbFirst(fields, 2)), imageUrl: coverOf(fields),
    artists: pbAll(fields, 3).map((artist) => {
      const message = pbRead(artist);
      return { id: base62(pbFirst(message, 1)), name: pbText(pbFirst(message, 2)), imageUrl: "" };
    }),
    released: "",
  };
}

// The messages behind a batch of uris, read the way Spotify's own clients read
// them: one POST carries up to METADATA_BATCH uris and an extension kind, and
// the country heads the request so the charts inside an artist answer for the
// market in the settings. Each answer wraps the entity's own message in bytes.
async function extendedMetadata(kind, uris, country, prompt) {
  const request = pbJoin([
    ...(country ? [pbBytes(1, pbString(1, country))] : []),
    ...uris.map((uri) => pbBytes(2, pbJoin([pbString(1, uri), pbBytes(2, pbInt(1, kind))]))),
  ]);
  const fields = pbRead(await spclient("POST", "/extended-metadata/v0/extended-metadata", request, prompt));
  const messages = new Map();
  for (const array of pbAll(fields, 2)) {
    for (const entity of pbAll(pbRead(array), 3)) {
      const data = pbRead(entity);
      const uri = pbText(pbFirst(data, 2));
      const any = pbFirst(data, 3);
      const message = any ? pbFirst(pbRead(any), 2) : undefined;
      if (uri && message) messages.set(uri, pbRead(message));
    }
  }
  return messages;
}

async function readAlbums(uris) {
  const albums = [];
  for (const batch of chunks(uris, METADATA_BATCH)) {
    for (const [uri, fields] of await extendedMetadata(ALBUM_V4, batch)) albums.push(albumFrom(uri, fields));
  }
  return albums.filter((album) => album.name);
}

// The session's own search, over the context Spotify's clients read an artist
// with. A Development Mode app's Web API search is a narrow index, where an
// artist's name can miss every song of theirs; this one names them by uri
// alone, so their details come from the batches above.
async function sessionSearch(query) {
  const path = `/context-resolve/v1/spotify:search:${encodeURIComponent(query).replace(/%20/g, "+")}`;
  const body = JSON.parse(decoder.decode(await spclient("GET", path)));
  const pages = Array.isArray(body?.pages) ? body.pages : [];
  return pages.flatMap((page) => (page?.tracks || []).map((track) => track?.uri)).filter(Boolean);
}

// An artist's own context, as Spotify's clients read it: their most popular
// songs and then their latest album's, named by uri alone. The rest of its
// pages are the albums, a request each, and those are the albums section's.
async function artistContextSongs(id) {
  const body = JSON.parse(decoder.decode(await spclient("GET", `/context-resolve/v1/spotify:artist:${id}`)));
  const artistUri = `spotify:artist:${id}`;
  return (Array.isArray(body?.pages) ? body.pages : [])
    .flatMap((page) => page?.tracks || [])
    .filter((track) => !track?.metadata?.artist_uri || track.metadata.artist_uri === artistUri)
    .map((track) => track?.uri)
    .filter(Boolean);
}

// The popular songs of one country, as the artist's metadata lists them: a
// market Spotify lists no songs for falls back to the worldwide ranking and
// then to the longest list, the way Spotify's own table does. They are named
// by gid, so their details come from the batch every song of the page is read
// in.
function chartUris(fields, country) {
  const lists = pbAll(fields, 4).map((top) => pbRead(top)).filter((top) => pbAll(top, 2).length);
  const countryOf = (top) => pbText(pbFirst(top, 1));
  const longest = (a, b) => (pbAll(b, 2).length > pbAll(a, 2).length ? b : a);
  const chosen = (country && lists.find((top) => countryOf(top) === country))
    || lists.find((top) => countryOf(top) === "ZZ")
    || lists.reduce(longest, lists[0]);
  if (!chosen) return [];
  return pbAll(chosen, 2)
    .map((track) => `spotify:track:${base62(pbFirst(pbRead(track), 1))}`)
    .filter((uri) => uri !== "spotify:track:");
}

async function readTracks(uris) {
  const wanted = uris.filter((uri) => uri.startsWith("spotify:track:"));
  const stale = new Set(wanted.filter((uri) => {
    const cached = trackCache.get(uri);
    return !cached || Date.now() - cached.at >= TRACK_TTL;
  }));
  const batches = [];
  const batch = wanted.filter((uri) => stale.has(uri));
  for (let i = 0; i < batch.length; i += METADATA_BATCH) batches.push(batch.slice(i, i + METADATA_BATCH));
  await Promise.all(batches.map(async (batch) => {
    for (const [uri, fields] of await extendedMetadata(TRACK_V4, batch)) {
      trackCache.set(uri, { track: trackFrom(uri, fields), at: Date.now() });
    }
  }));
  while (trackCache.size > TRACK_CACHE_MAX) trackCache.delete(trackCache.keys().next().value);
  // A song Spotify keeps no details for still has its row, as the Web API's
  // own page would show it: an empty row, not a silently shorter playlist.
  let known = 0;
  const tracks = uris.map((uri, index) => {
    if (uri.startsWith("spotify:local:")) {
      known++;
      return localTrack(uri, index);
    }
    const track = trackCache.get(uri)?.track;
    if (track) {
      known++;
      return track;
    }
    return missing("track", index);
  });
  return { tracks, known };
}

// The songs of a playlist the Web API withholds, or null when this listener
// hasn't approved the player identity and won't be asked again this run.
async function playerTracks(id, retried = false) {
  if (playerRefused && !currentPlayer()) return null;
  try {
    const rows = await readRows(id);
    if (!rows.uris.length) return null;
    const { tracks, known } = await readTracks(rows.uris);
    if (!known) return null;
    // Only a playlist longer than the app shows is worth saying so about.
    return { tracks, total: rows.total, truncated: rows.total > rows.uris.length };
  } catch (error) {
    // Spotify withdrew an approval it had given: ask once for a new one.
    if (error?.code === "playerRevoked" && !retried) return playerTracks(id, true);
    // The approval declined, timed out, or was refused: the page shows the
    // note it showed before, and the browser stays closed from now on.
    if (error?.code === "signIn") throw error;
    playerRefused = true;
    return null;
  }
}

// A portrait, from the group of sizes Spotify keeps of it.
function portraitOf(fields) {
  const group = pbFirst(fields, 17);
  const images = group ? pbAll(pbRead(group), 1).map((image) => pbRead(image)) : pbAll(fields, 11);
  const usable = images.filter((image) => pbFirst(image, 1)?.length);
  if (!usable.length) return "";
  const pick = usable.find((image) => pbFirst(image, 2) === 3) || usable[0];
  return `https://i.scdn.co/image/${hexOf(pbFirst(pick, 1))}`;
}

// The chart the settings name, from the one route that takes a country: the
// extension Spotify's clients ask for answers for the account's own country
// whatever it is told, and this route is what names another. Null when it
// names no chart at all, so the artist's own answer stands in.
async function playerChart(id, country) {
  const fields = pbRead(await spclient("GET", `/metadata/4/artist/${gidOf(id)}?country=${country}`));
  return pbAll(fields, 4).length ? fields : null;
}

// A whole artist page from Spotify's own metadata, which answers without the
// Web API's quota: who they are, their portrait, their albums and singles, and
// their songs. The chart leads, then the songs it leaves out: their own
// context adds the latest album's, and the session's search finds the rest of
// their most played. Requests that don't wait on each other go out together,
// so the page arrives in as few round trips as its answers allow. Null when
// the listener has turned the approval down this run; a page without the
// approval asks for it once, and again when Spotify withdraws one it gave.
async function playerArtist(id, needAlbums = true, retried = false) {
  const country = market();
  if (playerRefused && !currentPlayer()) return null;
  const uri = `spotify:artist:${id}`;
  let fields;
  try {
    fields = (await extendedMetadata(ARTIST_V4, [uri], country,
      t("The popular songs on an artist's page need one more Spotify approval. Close the page to skip."))).get(uri);
  } catch (error) {
    if (error?.code === "playerRevoked" && !retried) return playerArtist(id, needAlbums, true);
    // The approval declined or timed out: no browser window again this run.
    if (!currentPlayer()) playerRefused = true;
    throw error;
  }
  if (!fields) return null;
  const name = pbText(pbFirst(fields, 2));
  if (!name) return null;
  // A country in the settings is asked for on its own: the answer above is
  // the account's own charts. A page that can't get it keeps that one.
  const charts = country ? (await playerChart(id, country).catch(() => null)) || fields : fields;
  const chart = chartUris(charts, country);
  const albumIds = [...pbAll(fields, 5), ...pbAll(fields, 6)]
    .flatMap((group) => pbAll(pbRead(group), 1))
    .map((album) => base62(pbFirst(pbRead(album), 1)))
    .filter(Boolean);
  // The chart's own details name the song the search leans on, so they, the
  // context and the name go out at once.
  const [chartRead, contextUris, namedUris] = await Promise.all([
    chart.length ? readTracks(chart) : { tracks: [] },
    artistContextSongs(id).catch(() => []),
    sessionSearch(name).catch(() => []),
  ]);
  const songName = chartRead.tracks.find((track) => !track.unavailable)?.name;
  const songUris = songName ? await sessionSearch(songName).catch(() => []) : [];
  const beyond = [...new Set([...contextUris, ...namedUris, ...songUris])].filter((uri) => !chart.includes(uri));
  const [beyondRead, albums] = await Promise.all([
    beyond.length ? readTracks(beyond) : { tracks: [] },
    // The Web API's albums come first; these only stand in when it had none.
    needAlbums && albumIds.length ? readAlbums(albumIds.map((album) => `spotify:album:${album}`)) : [],
  ]);
  // The chart keeps its order; the rest are only songs the artist is credited
  // on, and no title is listed twice.
  const titles = new Set();
  const tracks = [];
  const rows = [
    ...chartRead.tracks.map((track) => ({ track, own: false })),
    ...beyondRead.tracks.map((track) => ({ track, own: true })),
  ];
  for (const { track, own } of rows) {
    if (track.unavailable) continue;
    if (own && !track.artists?.some((artist) => artist.id === id)) continue;
    const title = String(track.name || "").toLowerCase();
    if (!title || titles.has(title)) continue;
    titles.add(title);
    tracks.push(track);
  }
  return { artist: { id, name, imageUrl: portraitOf(fields) }, tracks, albums };
}

// --- Library ------------------------------------------------------------

export async function playlists(max = 2000) {
  const profileResult = await profile();
  const { items } = await collect("/me/playlists", { limit: PAGE }, max);
  return items.filter(Boolean).map((item) => toPlaylist(item, profileResult));
}

export async function playlist({ id }) {
  id = idOf(id);
  const [data, profileResult] = await Promise.all([api("GET", `/playlists/${id}`), profile()]);
  if (!data) throw fail("unavailable", t("This playlist isn't available."));
  const result = toPlaylist(data, profileResult);
  const first = data.items ?? data.tracks;
  if (!first || !Array.isArray(first.items)) {
    // Spotify withholds the songs of a playlist the listener doesn't own.
    // The player identity reads them, so ask it before explaining the gap.
    const read = await playerTracks(id);
    if (read) {
      result.tracks = read.tracks;
      result.trackCount = Math.max(result.trackCount, read.total);
      if (read.truncated) {
        result.description += `${result.description ? "\n" : ""}${t("Showing the first 1000 songs.")}`;
      }
      return result;
    }
    result.tracks = [];
    const note = t("Spotify lets this plugin list the songs of only your own and collaborative playlists. Open this one in the Spotify app to play it.");
    result.description = result.description ? `${result.description}\n${note}` : note;
    return result;
  }
  // A page Spotify can't finish is still worth what it has, with the reason
  // in its description rather than an empty page and a Retry.
  let entries = [...first.items];
  let spent = null;
  try {
    entries = await more(entries, first, PLAYLIST_LIMIT);
  } catch (error) {
    if (!isQuota(error)) throw error;
    spent = error;
  }
  if (spent) result.description += `${result.description ? "\n" : ""}${quotaText(spent)}`;
  result.tracks = entries.map((entry, index) => toTrack(entry?.item ?? entry?.track, undefined, index));
  if (result.trackCount > PLAYLIST_LIMIT) {
    result.description += `${result.description ? "\n" : ""}${t("Showing the first 1000 songs.")}`;
  }
  return result;
}

export async function createPlaylist({ name }) {
  const title = String(name || "").trim();
  if (!title) throw fail("", t("Give the playlist a name."));
  const [data, profileResult] = await Promise.all([
    api("POST", "/me/playlists", { body: { name: title, public: false } }), profile(),
  ]);
  return { ...toPlaylist(data, profileResult), mine: true, saved: false };
}

export async function renamePlaylist({ id, name }) {
  const title = String(name || "").trim();
  if (!title) throw fail("", t("Give the playlist a name."));
  await api("PUT", `/playlists/${idOf(id)}`, { body: { name: title } });
}

// Spotify never deletes a playlist: its owner unfollows it, which takes it out
// of their library.
export async function deletePlaylist({ id }) {
  await setSaved([`spotify:playlist:${idOf(id)}`], false);
}

export async function savePlaylist({ id, on }) {
  await setSaved([`spotify:playlist:${idOf(id)}`], !!on);
}

function editableURIs(trackIds) {
  if (!Array.isArray(trackIds)) throw fail("", t("This isn't a list of songs."));
  return [...new Set(trackIds.map((value) => {
    const text = String(value);
    if (text.startsWith("local:")) {
      try { return decodeURIComponent(text.slice(6)); } catch { throw fail("", t("This isn't a list of songs.")); }
    }
    const uri = uriOf(text);
    if (!uri) throw fail("unsupported", t("This song can't be changed in a playlist."));
    return uri;
  }))];
}

export async function addToPlaylist({ id, trackIds }) {
  id = idOf(id);
  const uris = editableURIs(trackIds);
  // Local files can be taken out of a playlist by URI, but not added or moved.
  if (uris.some((uri) => uri.startsWith("spotify:local:"))) {
    throw fail("unsupported", t("Spotify can't add local files to a playlist through the Web API."));
  }
  for (const batch of chunks(uris, EDIT_BATCH)) {
    await api("POST", `/playlists/${id}/items`, { body: { uris: batch } });
  }
}

export async function removeFromPlaylist({ id, trackIds }) {
  id = idOf(id);
  for (const batch of chunks(editableURIs(trackIds), EDIT_BATCH)) {
    await api("DELETE", `/playlists/${id}/items`, { body: { items: batch.map((uri) => ({ uri })) } });
  }
}

// The app moves the song at `from` so that it ends up at `to`. Spotify inserts
// before a position counted before the move.
export async function movePlaylistTrack({ id, from, to }) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0) {
    throw fail("", t("This isn't a place in the playlist."));
  }
  if (from === to) return;
  await api("PUT", `/playlists/${idOf(id)}/items`, {
    body: { range_start: from, insert_before: to > from ? to + 1 : to, range_length: 1 },
  });
}

export async function liked({ offset = 0 }) {
  offset = offsetOf(offset);
  const data = await api("GET", "/me/tracks", { query: { limit: PAGE, offset } });
  return {
    tracks: (data?.items || []).map((entry, index) => toTrack(entry?.track, undefined, offset + index)),
    more: !!data?.next,
  };
}

export async function isLiked({ ids }) {
  const list = Array.isArray(ids) ? ids : [];
  const result = Object.fromEntries(list.map((id) => [id, false]));
  if (!clientId() || !currentSession()) return result;
  const askable = list.map((id) => {
    try { return { id, uri: uriOf(id) }; } catch { return { id, uri: null }; }
  }).filter((item) => item.uri);
  const answers = await contains(askable.map((item) => item.uri));
  askable.forEach((item, i) => { result[item.id] = answers[i]; });
  return result;
}

export async function like({ id, on }) {
  const uri = uriOf(id);
  if (!uri) throw fail("unsupported", t("This song can't be saved to Spotify."));
  await setSaved([uri], !!on);
}

export async function likeEpisode({ id, on }) {
  const uri = uriOf(id);
  if (!uri?.startsWith("spotify:episode:")) throw fail("unsupported", t("This isn't a podcast episode."));
  await setSaved([uri], !!on);
}

export async function album({ id }) {
  id = idOf(id);
  const [data, saved] = await Promise.all([api("GET", `/albums/${id}`), savedFlag(`spotify:album:${id}`)]);
  if (!data) throw fail("unavailable", t("This album isn't available."));
  const items = await more([...(data.tracks?.items || [])], data.tracks, 1000);
  return {
    album: { ...toAlbum(data), saved },
    tracks: items.map((track, index) => toTrack(track, data, index)),
  };
}

export async function saveAlbum({ id, on }) {
  await setSaved([`spotify:album:${idOf(id)}`], !!on);
}

export async function savedAlbums({ offset = 0 }) {
  offset = offsetOf(offset);
  const data = await api("GET", "/me/albums", { query: { limit: PAGE, offset } });
  return {
    albums: (data?.items || []).filter((entry) => entry?.album).map((entry) => ({ ...toAlbum(entry.album), saved: true })),
    more: !!data?.next,
  };
}

async function artistAlbums(id) {
  const query = { include_groups: "album,single", limit: PAGE };
  try {
    return (await collect(`/artists/${id}/albums`, query, 200)).items;
  } catch (error) {
    // A smaller page for an app whose page size limit is lower.
    if (error.status !== 400) throw error;
    return (await collect(`/artists/${id}/albums`, { ...query, limit: 10 }, 200)).items;
  }
}

// An artist page reads the artist and their albums over the Web API, and
// searches it for their songs when the session can't name them. A Development
// Mode app's quota is small, and Spotify turning one of these down for a
// moment shouldn't cost the listener the whole page, so a section it limits
// stays empty and the page shows the rest. A spent quota is handed to noted,
// so the page can say why the section is empty.
async function unlessLimited(task, fallback, noted) {
  try {
    return await task();
  } catch (error) {
    if (error.status !== 429) throw error;
    if (isQuota(error)) noted?.(error);
    return fallback;
  }
}

// Development Mode apps can't read an artist's top tracks, so the page lists
// the artist's songs that search finds first, by Spotify's relevance.
async function artistTracks(artistResult) {
  const tracks = new Map();
  for (const offset of [0, SEARCH_LIMIT]) {
    const data = await api("GET", "/search", {
      query: { q: `artist:"${artistResult.name.replace(/"/g, "")}"`, type: "track", limit: SEARCH_LIMIT, offset },
    });
    for (const item of data?.tracks?.items || []) {
      if (item?.id && item.artists?.some((a) => a.id === artistResult.id)) tracks.set(item.id, toTrack(item));
    }
    if (!data?.tracks?.next) break;
  }
  return [...tracks.values()];
}

export async function artist({ id }) {
  id = idOf(id);
  let limited = null;
  let albumsSpent = null;
  let tracksSpent = null;
  const [data, albums, following] = await Promise.all([
    api("GET", `/artists/${id}`).catch((error) => {
      // A Development Mode app's quota runs out as a 429, and the session can
      // still answer the page, so it is kept for the fallback below.
      if (error?.status !== 429) throw error;
      limited = error;
      return null;
    }),
    unlessLimited(() => artistAlbums(id), [], (error) => { albumsSpent = error; }),
    savedFlag(`spotify:artist:${id}`),
  ]);
  // The session's charts are what the page is for, and its albums stand in
  // for any the Web API had no quota left to answer. It is the whole page when
  // the Web API answered nothing at all. Without the approval it needs,
  // playerArtist asks for it once; turned down, the page falls back to search.
  const played = await playerArtist(id, !albums.length).catch(() => null);
  if (!data && !played) throw limited || fail("unavailable", t("This artist isn't available."));
  const result = data ? { ...toArtist(data), following } : { ...played.artist, following: false };
  // The session's own page carries the artist's songs, their charts first. A
  // page without the approval it needs falls back to the Web API's search.
  const tracks = played?.tracks?.length
    ? played.tracks
    : await unlessLimited(() => artistTracks(result), [], (error) => { tracksSpent = error; });
  const albumList = albums.length ? albums.filter(Boolean).map(toAlbum) : played?.albums || [];
  // A section the quota left empty, with nothing standing in for it.
  const spent = (!tracks.length && tracksSpent) || (!albumList.length && albumsSpent) || null;
  // The page has no line of text of its own, so the reason heads its songs:
  // a page with nothing else on it says why, instead of claiming the artist
  // has nothing.
  return { artist: result, tracks: spent ? [quotaRow(spent), ...tracks] : tracks, albums: albumList };
}

export async function followArtist({ id, on }) {
  await setSaved([`spotify:artist:${idOf(id)}`], !!on);
}

export async function shows() {
  const { items } = await collect("/me/shows", { limit: PAGE }, 1000);
  return items.filter((entry) => entry?.show).map((entry) => ({ ...toShow(entry.show), subscribed: true }));
}

export async function show({ id, offset = 0 }) {
  id = idOf(id);
  offset = offsetOf(offset);
  const [data, episodes, subscribed] = await Promise.all([
    api("GET", `/shows/${id}`),
    api("GET", `/shows/${id}/episodes`, { query: { limit: PAGE, offset } }),
    savedFlag(`spotify:show:${id}`),
  ]);
  if (!data) throw fail("unavailable", t("This podcast isn't available."));
  return {
    show: { ...toShow(data), subscribed },
    // Keep a slot for an episode Spotify no longer has: the app's next offset
    // counts what this page returned.
    episodes: (episodes?.items || []).map((episode, index) => (episode ? toEpisode(episode, data) : missing("episode", offset + index))),
    more: !!episodes?.next,
  };
}

export async function subscribeShow({ id, on }) {
  await setSaved([`spotify:show:${idOf(id)}`], !!on);
}

// --- Lyrics -------------------------------------------------------------
//
// The Web API has no lyrics: Spotify's own come from Musixmatch, for its apps
// alone. The plugin matches the track by its name, artists and length in two
// open sources instead: LRCLIB (lrclib.net), whose entries mostly follow
// Spotify's own titles, and NetEase Cloud Music, best for Chinese songs and
// with translations of songs in other languages.

const LRCLIB = "https://lrclib.net/api";
const NETEASE = "https://music.163.com";
const LYRICS_HEADERS = { "User-Agent": "mygo-music-spotify (MyGo Music plugin)" };
// How far another source's length may be from Spotify's for the same song.
const LYRICS_DURATION_SLACK = 3000;
const lyricsCache = new Map();

const timed = (lrc) => /\[\d+:\d+(?:[.:]\d+)?\]/.test(lrc || "");

// The title without what versions add to it, for searching.
function searchTitle(name) {
  return String(name || "").replace(/\s+-\s+.*$/, "").replace(/\s*[([（【].*?[)\]）】]\s*/g, " ").trim() || String(name || "");
}

async function lyricsJSON(url, headers = {}) {
  const response = await timedFetch(url, { headers: { ...LYRICS_HEADERS, ...headers } });
  if (response.status === 404) return null;
  if (!response.ok) throw fail("", `HTTP ${response.status}`);
  return readJSON(response);
}

async function fromLrclib(meta) {
  const seconds = Math.round(meta.duration / 1000);
  let entry = await lyricsJSON(`${LRCLIB}/get?${new URLSearchParams({
    track_name: meta.name, artist_name: meta.artists[0] || "", album_name: meta.album, duration: String(seconds),
  })}`);
  if (!entry) {
    const found = await lyricsJSON(`${LRCLIB}/search?${new URLSearchParams({
      track_name: searchTitle(meta.name), artist_name: meta.artists[0] || "",
    })}`);
    entry = (Array.isArray(found) ? found : []).find((item) => item && Math.abs(Number(item.duration) * 1000 - meta.duration) <= LYRICS_DURATION_SLACK
      && (item.syncedLyrics || item.instrumental));
  }
  if (!entry) return null;
  return { lrc: timed(entry.syncedLyrics) ? entry.syncedLyrics : "", translation: "", instrumental: !!entry.instrumental };
}

async function fromNetease(meta) {
  const headers = { Referer: `${NETEASE}/` };
  const found = await lyricsJSON(`${NETEASE}/api/cloudsearch/pc?${new URLSearchParams({
    s: `${searchTitle(meta.name)} ${meta.artists[0] || ""}`.trim(), type: "1", limit: "10",
  })}`, headers);
  // Titles can differ in script (驚鴻一面, 惊鸿一面), so the length decides.
  const song = (found?.result?.songs || []).find((item) => item?.id && Math.abs(Number(item.dt) - meta.duration) <= LYRICS_DURATION_SLACK);
  if (!song) return null;
  const data = await lyricsJSON(`${NETEASE}/api/song/lyric?${new URLSearchParams({ id: String(song.id), lv: "1", tv: "-1" })}`, headers);
  if (!data || Number(data.code) !== 200) return null;
  const lrc = data.lrc?.lyric || "";
  const translation = data.tlyric?.lyric || "";
  return { lrc: timed(lrc) ? lrc : "", translation: timed(translation) ? translation : "", instrumental: !!data.pureMusic };
}

function chooseLyrics(lrclib, netease) {
  if (netease?.lrc && netease.translation) return netease;
  if (lrclib?.lrc) return lrclib;
  if (netease?.lrc) return netease;
  return null;
}

export async function lyrics({ id }) {
  const text = String(id);
  const none = { lrc: "", translation: "" };
  if (/^(episode|local|missing):/.test(text)) return none;
  id = idOf(text);
  if (lyricsCache.has(id)) return lyricsCache.get(id);
  const track = await api("GET", `/tracks/${id}`);
  if (!track) return none;
  const meta = {
    name: track.name || "", artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
    album: track.album?.name || "", duration: track.duration_ms || 0,
  };
  const [lrclib, netease] = await Promise.allSettled([fromLrclib(meta), fromNetease(meta)]);
  const chosen = chooseLyrics(lrclib.value, netease.value);
  // Both sources unreachable isn't the same as a song without words.
  if (!chosen && lrclib.status === "rejected" && netease.status === "rejected") {
    throw fail("", t("Couldn't load lyrics. Check your connection and try again."));
  }
  const result = chosen ? { lrc: chosen.lrc, translation: chosen.translation || "" } : none;
  // "None" is kept only when both sources answered: one that failed for now
  // may have the words next time.
  if (chosen || (lrclib.status === "fulfilled" && netease.status === "fulfilled")) lyricsCache.set(id, result);
  while (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value);
  return result;
}

// --- Spotify Connect ----------------------------------------------------

function usableDevices(list) {
  return (list || []).filter((device) => device?.id && !device.is_restricted);
}

async function listDevices(deadline) {
  return usableDevices((await api("GET", "/me/player/devices", { deadline }))?.devices);
}

const deviceQuery = (device) => (device ? { device_id: device } : undefined);

// --- Built-in player (Spotify Soloist) ---
//
// Without a Spotify app open anywhere, the plugin starts Spotify Soloist,
// Spotify's own headless player, which plays on this computer and shows in
// Spotify as one more device. Spotify doesn't allow passing its binary on, so
// the plugin downloads it from Spotify the first time, into soloist/ in the
// plugin's folder, and again when the build expires after 90 days.
//
// The archive it downloads is kept in the plugin's data folder, which an
// update of the plugin doesn't replace: the update installs Soloist from
// there, rather than downloading it again.
//
// Soloist needs the listener's own API key, from Spotify for Developers, and
// signs in through Spotify Connect: the first time, the listener picks it once
// in a Spotify app on the same network. It keeps that session in its data
// directory after.

// The ID the app's device menu gives the built-in player before it runs, and
// what "device" holds once the listener plays on it.
const LOCAL = "local";
const SOLOIST_CDN = "https://soloist-builds.spotifycdn.com/";
const SOLOIST_ARCHIVES = {
  "darwin-arm64": "soloist_release_osx_arm64.tar.gz",
  "windows-amd64": "soloist_release_windows_x86_64.zip",
  "linux-amd64": "soloist_release_x86_64.tar.gz",
  "linux-arm64": "soloist_release_arm64.tar.gz",
};
const SOLOIST_EXPIRED = 10; // its exit code once the build is too old
// Spotify lets a build work for 90 days after its build date. Treat one a day
// short of that as stale, rather than start a play on it.
const SOLOIST_BUILD_MAX_AGE = 89 * 24 * 60 * 60 * 1000;
// Where the downloaded archive waits, in the plugin's data folder. An update
// replaces the plugin's folder, not that: Soloist is installed from the
// archive there again, rather than downloaded again.
const SOLOIST_STAGE = "soloist-download";
// A download that just failed is asked for again at once, as the app moves on
// to the next song: let a moment pass before asking Spotify again.
const SOLOIST_RETRY_AFTER = 15000;
// How long a command waits for the built-in player before saying what it's
// waiting for: the app gives a command 30 seconds, and the rest of a play
// may have taken some already.
const LOCAL_WAIT = 10000;
// How long it keeps looking for the device in the background, as the
// listener pairs it.
const LOCAL_POLL_EVERY = 1500;
const LOCAL_GIVE_UP = 10 * 60 * 1000;
let local = null; // { process, ready, exited, code, name, stage, lines, key, deviceId }
let downloading = null;
let downloadFailure = null; // why the last download failed, until it's asked for again

function localName() {
  return host.platform === "windows" ? "MyGo Music on Windows" : host.platform === "darwin" ? "MyGo Music on Mac" : "MyGo Music";
}

function soloistKey() {
  return String(host.setting("soloistKey") || "").trim();
}

function soloistArchive() {
  return SOLOIST_ARCHIVES[`${host.platform}-${host.arch}`];
}

// soloistOffered says whether the built-in player could run here at all: with
// the listener's key, on a computer Spotify makes Soloist for.
function soloistOffered() {
  return !!soloistKey() && !!soloistArchive();
}

function soloistBinary() {
  return `soloist/soloist${host.platform === "windows" ? ".exe" : ""}`;
}

function stagedSoloist(archive) {
  return `${host.dataDir}/${SOLOIST_STAGE}/${archive}`;
}

function stopLocal() {
  const running = local;
  local = null;
  if (running?.process && !running.exited) {
    try { running.process.kill(); } catch {}
  }
}

// Forget Soloist's session, for another account to pair it.
function forgetLocal() {
  stopLocal();
  // The pairing, and the audio it cached: another account pairs it anew.
  for (const name of ["soloist", "soloist-cache"]) {
    try { host.removeDataDir(name); } catch {}
  }
}

function spawnProgram(command, args) {
  try {
    return host.spawn(command, args);
  } catch (error) {
    const message = String(error?.message || "");
    if (/allowed/i.test(message)) {
      throw fail("setup", t("To play on this computer without the Spotify app, allow this plugin to start programs in its settings."));
    }
    // The plugin's own manifest doesn't name it: a wrong download won't fix it.
    if (/process permission|one of the programs/i.test(message)) {
      throw fail("setup", t("This version of the plugin can't start the programs it needs. Update the plugin, or update MyGo Music."));
    }
    throw error;
  }
}

function lastLines(text, count = 1) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-count).join(" ").slice(0, 200);
}

// run starts a program, reads what it writes, and answers its exit code, and
// the last of what it wrote.
async function run(command, args) {
  const program = spawnProgram(command, args);
  const lines = [];
  try {
    for (let line; (line = await program.readLine()) !== null;) {
      if (lines.length < 40) lines.push(line);
    }
  } catch {}
  const code = await program.wait();
  let errors = "";
  try { errors = program.errorOutput(); } catch {}
  return { code, errors, lines };
}

function unsupportedSoloist() {
  return fail("unavailable", t("Spotify Soloist isn't made for this computer. Open Spotify on your computer or phone, then play again."));
}

// checkSoloist runs the binary just installed: is it Soloist, and is its build
// within the days Spotify lets one work?
async function checkSoloist() {
  const version = await run(soloistBinary(), ["--version"]);
  const text = [...version.lines, ...String(version.errors || "").split("\n")].join("\n");
  if (version.code === SOLOIST_EXPIRED || /client expired|update to continue using/i.test(text)) {
    return { ok: false, expired: true };
  }
  if (version.code !== 0 || !/\bsoloist\b/i.test(text)) return { ok: false };
  const build = /\bbuild\s+(\d{9,11})\b/.exec(text);
  if (build && Date.now() - Number(build[1]) * 1000 > SOLOIST_BUILD_MAX_AGE) {
    return { ok: false, expired: true };
  }
  return { ok: true };
}

// unpackStagedSoloist installs the archive kept from an earlier download,
// for a plugin update that took the binary with the old plugin's folder.
async function unpackStagedSoloist(archive) {
  try {
    const unpacked = await run("tar", ["-xf", stagedSoloist(archive), "-C", "soloist"]);
    if (unpacked.code !== 0) return false;
    return (await checkSoloist()).ok;
  } catch {
    // No tar, or no archive: a download is the way from here.
    return false;
  }
}

// installSoloist puts Soloist in the plugin's folder: from the archive an
// earlier download kept, or from Spotify.
async function installSoloist() {
  if (downloading) {
    await downloading;
    return;
  }
  const archive = soloistArchive();
  if (!archive) throw unsupportedSoloist();
  if (await unpackStagedSoloist(archive)) return;
  await downloadSoloist();
}

// downloadSoloist fetches the current build from Spotify with curl, unpacks it
// with tar, which macOS and Windows 10 and later come with, and checks that
// what it unpacked runs. The archive stays in the plugin's data folder, for
// the next plugin update to install from rather than download again.
function downloadSoloist() {
  if (downloading) return downloading;
  const archive = soloistArchive();
  if (!archive) return Promise.reject(unsupportedSoloist());
  // The app moves on to the next song when one fails: don't ask Spotify for
  // the same build over and over.
  const last = downloadFailure;
  if (last && last.archive === archive && Date.now() - last.at < SOLOIST_RETRY_AFTER) {
    return Promise.reject(fail(last.code, last.message));
  }
  const staged = stagedSoloist(archive);
  const job = (async () => {
    try {
      const fetched = await run("curl", [
        "--fail", "--location", "--silent", "--show-error", "--create-dirs",
        // Spotify's address only, and only over https, also after a redirect.
        "--proto", "=https", "--proto-redir", "=https",
        // Retry a passing failure, timeouts included: a download cut short is
        // fetched again, rather than unpacked broken.
        "--retry", "3", "--retry-delay", "1", "--retry-max-time", "120", "--retry-all-errors",
        "--connect-timeout", "20", "--max-time", "300", "--max-filesize", "67108864",
        "--output", staged, SOLOIST_CDN + archive,
      ]);
      if (fetched.code !== 0) {
        throw fail("unavailable", `${t("Couldn't download Spotify Soloist.")} (${lastLines(fetched.errors) || `curl ${fetched.code}`})`);
      }
      const unpacked = await run("tar", ["-xf", staged, "-C", "soloist"]);
      if (unpacked.code !== 0) {
        throw fail("unavailable", `${t("Couldn't unpack Spotify Soloist.")} (${lastLines(unpacked.errors) || `tar ${unpacked.code}`})`);
      }
      const checked = await checkSoloist();
      if (!checked.ok) {
        throw fail("unavailable", checked.expired
          ? t("Spotify's Soloist build has expired. Try again in a moment.")
          : t("The downloaded Spotify Soloist can't run. Try again."));
      }
    } catch (error) {
      // Nothing half downloaded is left for an install to trust later.
      try { host.removeDataDir(SOLOIST_STAGE); } catch {}
      const failure = error.code
        ? error
        : fail("unavailable", `${t("Couldn't download Spotify Soloist.")} (${String(error?.message || "").slice(0, 200)})`);
      downloadFailure = { archive, at: Date.now(), code: failure.code, message: failure.message };
      throw failure;
    }
  })();
  downloading = job;
  const done = () => { if (downloading === job) downloading = null; };
  job.then(() => { downloadFailure = null; done(); }, done);
  return job;
}

// launch starts Soloist, installing it first if it isn't here yet.
async function launch(running, installed = false) {
  running.stage = "starting";
  running.exited = false;
  // A relaunched Soloist is a new process: what the old one wrote, and the
  // device ID it had, don't say anything about it.
  running.lines = [];
  running.deviceId = "";
  try {
    running.process = spawnProgram(soloistBinary(), [
      "--device-name", running.name, "--api-key", running.key,
      "--data-dir", `${host.dataDir}/soloist`, "--cache-dir", `${host.dataDir}/soloist-cache`,
      "--cache-size", "500", "--initial-volume", "70",
    ]);
  } catch (error) {
    if (error.code) throw error;
    // Not there yet, or left broken by a download cut short: install it once.
    if (installed) throw fail("unavailable", `${t("Spotify Soloist couldn't start.")} (${String(error?.message || "").slice(0, 200)})`);
    running.stage = "downloading";
    await installSoloist();
    return launch(running, true);
  }
  const program = running.process;
  (async () => {
    try {
      for (let line; (line = await program.readLine()) !== null;) {
        running.lines.push(line);
        if (running.lines.length > 20) running.lines.shift();
        if (/waiting for login/i.test(line)) running.stage = "pairing";
        // Its Spotify device ID, which tells it from another computer's
        // Soloist of the same name on the same account.
        const id = /\bdevice_id=([0-9A-Za-z-]+)/.exec(line);
        if (id) running.deviceId = id[1];
      }
    } catch {}
  })();
  program.wait().then((code) => { running.exited = true; running.code = code; }, () => { running.exited = true; });
}

// localText is what Soloist wrote, without the timestamps it puts before it.
function localText(running) {
  let errors = "";
  try { errors = running.process.errorOutput(); } catch {}
  return [...running.lines, ...String(errors).split("\n")]
    .map((line) => line.replace(/^\d{4}-\d\d-\d\d [\d:.]+:\s*/, "").trim())
    .filter(Boolean);
}

// localReason picks why it stopped: the last line that sounds like a reason.
function localReason(running) {
  const text = localText(running);
  return [...text].reverse().find((line) => /error|fail|invalid|denied|key|expired|premium/i.test(line))
    || text[text.length - 1] || `exit ${running.code}`;
}

// soloistExpired says whether it stopped because its build is too old: its
// documented exit code, or what it last said.
function soloistExpired(running) {
  return running.code === SOLOIST_EXPIRED || localText(running).some((line) => /client expired|update to continue using/i.test(line));
}

// soloistLocked says whether another Soloist still holds its data folder.
function soloistLocked(running) {
  return localText(running).some((line) => /another (?:session|instance) is running/i.test(line));
}

// localFailure says why Soloist stopped, in words the listener can act on.
function localFailure(running) {
  const reason = localReason(running);
  // A Soloist left running by MyGo Music that didn't close still holds the
  // data folder: only the listener can end it.
  if (/another (?:session|instance) is running/i.test(reason)) {
    return fail("unavailable", t("Spotify Soloist is still running from an earlier MyGo Music session. Quit MyGo Music and Soloist (Activity Monitor on a Mac, Task Manager on Windows), then play again."));
  }
  if (/client expired|update to continue using/i.test(reason)) {
    return fail("unavailable", t("Spotify's Soloist build has expired. Try again in a moment."));
  }
  return fail("unavailable", `${t("Spotify Soloist stopped.")} (${reason.slice(0, 200)})`);
}

// follow runs in the background until Soloist shows in Spotify's devices,
// downloading it again if its build expired.
async function follow(running, generation) {
  await launch(running);
  let renewed = false;
  let lockRetried = false;
  // Look often at first, then less: a listener pairing it sees no difference,
  // and the background wait stops asking Spotify four hundred times.
  let poll = LOCAL_POLL_EVERY;
  let deadline = Date.now() + LOCAL_GIVE_UP;
  while (Date.now() < deadline) {
    await sleep(poll);
    if (local !== running || generation !== epoch) throw changed();
    if (running.exited) {
      if (soloistExpired(running) && !renewed) {
        renewed = true;
        running.stage = "downloading";
        await downloadSoloist();
        await launch(running, true);
        // The wait for pairing starts over with the new build.
        deadline = Date.now() + LOCAL_GIVE_UP;
        poll = LOCAL_POLL_EVERY;
        continue;
      }
      // A Soloist that is still shutting down lets its folder go shortly.
      if (soloistLocked(running) && !lockRetried) {
        lockRetried = true;
        await sleep(LOCAL_POLL_EVERY);
        if (local !== running || generation !== epoch) throw changed();
        await launch(running, true);
        continue;
      }
      throw localFailure(running);
    }
    let devices;
    try {
      devices = await listDevices();
      poll = LOCAL_POLL_EVERY;
    } catch (error) {
      // A passing network error doesn't end the wait; signing out does, and a
      // rate limit is no reason to keep asking as often.
      if (error.code === "signIn" || error.code === "setup") throw error;
      poll = Math.min(poll * 2, 30000);
      continue;
    }
    // Its own ID when it has said it, so another computer's Soloist of the
    // same name on the same account isn't taken for this one; by name only
    // if it never says the ID.
    const device = running.deviceId
      ? devices.find((item) => item.id === running.deviceId)
      : devices.find((item) => item.name === running.name);
    if (device) {
      running.stage = "ready";
      return device.id;
    }
    poll = Math.min(poll * 2, 5000);
  }
  throw fail("unavailable", t("Spotify Soloist wasn't paired in time. Play again to try once more."));
}

function stillWaiting(running) {
  if (running.stage === "downloading") {
    return fail("", t("Downloading Spotify Soloist, Spotify's player for this computer (about 11 MB). Play again in a moment."));
  }
  if (running.stage === "pairing") {
    return fail("", t("Pair the built-in player once: in the Spotify app on your phone or this computer, on the same network, open the list of devices and choose \"{device}\". Then play again here.").replace("{device}", running.name));
  }
  return fail("", t("Spotify Soloist is starting. Play again in a moment."));
}

// startLocal answers the Spotify device ID of the built-in player, starting
// it, and downloading it, first if needed. What takes longer than a command
// may goes on in the background, and the listener is told what it waits for.
async function startLocal(wait = LOCAL_WAIT) {
  requireSession();
  const key = soloistKey();
  if (!key) {
    throw fail("setup", t("To play on this computer without the Spotify app, add your Soloist API key in the plugin's settings."));
  }
  // Start it unless it runs, or is on its way, with this key. One that ended
  // after it was ready starts again: its device left Spotify with it.
  if (!local || local.failed || local.key !== key || (local.stage === "ready" && local.exited)) {
    // What an earlier version kept for librespot, its built-in player before.
    if (!local) { try { host.removeDataDir("librespot"); } catch {} }
    stopLocal();
    const running = { process: null, exited: false, name: localName(), stage: "starting", lines: [], key, deviceId: "", failed: false };
    local = running;
    running.ready = follow(running, epoch);
    running.ready.catch(() => { running.failed = true; });
  }
  const running = local;
  let timer;
  const waited = new Promise((_, reject) => { timer = setTimeout(() => reject(stillWaiting(running)), Math.max(0, wait)); });
  try {
    return await Promise.race([running.ready, waited]);
  } finally {
    clearTimeout(timer);
  }
}

// waitWithin is how long starting the built-in player may take within the
// caller's deadline, keeping some of it for the command that follows.
function waitWithin(deadline) {
  if (!Number.isFinite(deadline)) return LOCAL_WAIT;
  return Math.max(0, Math.min(LOCAL_WAIT, deadline - Date.now() - 3000));
}

// Resolve the stored device: the built-in player starts once it's needed.
async function preferredDevice(deadline = Infinity) {
  const stored = host.storage.get("device") || undefined;
  if (stored !== LOCAL) return stored;
  // Its key may have been taken away since: an open Spotify app plays instead.
  if (!soloistOffered()) {
    host.storage.remove("device");
    return undefined;
  }
  return startLocal(waitWithin(deadline));
}

// withDevice runs a player command on the device the listener chose, or the
// one playing, or any Spotify app that's open, or else the built-in player.
async function withDevice(command, deadline = Infinity, restarted = false) {
  const preferred = await preferredDevice(deadline);
  try {
    return await command(preferred);
  } catch (error) {
    if (error.status !== 404) throw error;
    // The built-in player's device left Spotify while its process still ran:
    // start it again, once, so this computer can play again.
    if (!restarted && host.storage.get("device") === LOCAL && local) {
      stopLocal();
      return withDevice(command, deadline, true);
    }
    // A remembered device that's gone, such as one that was renamed, isn't
    // tried again before every play.
    if (preferred && host.storage.get("device") === preferred) host.storage.remove("device");
  }
  const devices = await listDevices(deadline);
  const target = devices.find((device) => device.is_active) || devices.find((device) => device.id === preferred) || devices[0];
  if (!target) {
    const id = await startLocal(waitWithin(deadline));
    // Only a device that answered is remembered, so a failed play doesn't
    // leave the built-in player chosen for every later one.
    try {
      const answer = await command(id);
      host.storage.set("device", LOCAL);
      return answer;
    } catch (error) {
      if (error.status === 404) throw fail("unavailable", t("Open Spotify on your computer or phone, then play again."));
      throw error;
    }
  }
  try {
    return await command(target.id);
  } catch (error) {
    if (error.status === 404) throw fail("unavailable", t("Open Spotify on your computer or phone, then play again."));
    throw error;
  }
}

// Spotify can keep a device that went offline listed as active, and answers
// 204 to a play command sent to it while nothing plays anywhere. Check that
// playback really started, and say which device didn't respond.
const CONFIRM_TRIES = 12;
const CONFIRM_EVERY = 500;
// After a device didn't start, the app may try the next songs at once; fail
// those fast instead of waiting on the same device for each.
const DEVICE_FAILURE_HOLD = 3000;
let deviceFailure = null;

function deviceDidNotStart(name) {
  return fail("", t("Spotify accepted the song, but \"{device}\" didn't start playing. It may be offline. Open Spotify on this computer or your phone, then play again.")
    .replace("{device}", name || "Spotify"));
}

// The app gives a command 30 seconds. A play keeps within this, so what it
// says, rather than the app's timeout, reaches the listener.
const PLAY_BUDGET = 25000;

// confirmPlaying answers null once Spotify plays, or else the device that
// didn't start, looking until the deadline at the latest.
// device is where the play command went, or "" when Spotify chose. Another
// device playing something else doesn't count as this one having started:
// that is how an offline device Spotify kept listed as active stays hidden.
async function confirmPlaying(uris, deadline = Infinity, device = "") {
  const wanted = new Set(uris.map((uri) => uri.split(":").pop()));
  const targeted = !!device;
  let last = null;
  for (let i = 0; i < CONFIRM_TRIES && Date.now() < deadline; i++) {
    if (i > 0 && Date.now() + CONFIRM_EVERY > deadline) break;
    await sleep(CONFIRM_EVERY);
    try {
      last = await api("GET", "/me/player", { query: { additional_types: "episode" }, deadline });
    } catch (error) {
      // A passing error while checking doesn't mean the play failed.
      if (error.code === "signIn" || error.code === "setup") throw error;
      continue;
    }
    if (!last?.item) continue;
    // A relinked track can play under another ID, so the device asked counts
    // as well, as does any device when Spotify chose it.
    if (wanted.has(last.item.id) || (last.is_playing && (!targeted || last.device?.id === device))) return null;
  }
  return { id: last?.device?.id || "", name: last?.device?.name || "" };
}

export async function remotePlay({ ids, start = 0, position = 0 }) {
  if (!Array.isArray(ids) || !ids.length) throw fail("unavailable", t("There's nothing to play."));
  // The note heading an artist page the quota emptied isn't a song: Play on
  // that page starts at the first song after it.
  while (start < ids.length - 1 && ids[start] === QUOTA_ROW) start++;
  const first = uriOf(ids[start] ?? "");
  if (!first) throw fail("unavailable", t("Spotify can't play this song."));
  const uris = [];
  for (let i = start; i < ids.length && uris.length < QUEUE_WINDOW; i++) {
    let uri = null;
    try { uri = uriOf(ids[i]); } catch {}
    if (uri) uris.push(uri);
  }
  if (deviceFailure && Date.now() - deviceFailure.at < DEVICE_FAILURE_HOLD) throw deviceDidNotStart(deviceFailure.name);
  const deadline = Date.now() + PLAY_BUDGET;
  const left = () => deadline - Date.now();
  const body = { uris, offset: { position: 0 }, position_ms: Math.max(0, Math.floor(Number(position) || 0)) };
  // The device each command went to: Spotify's state can say nothing at all
  // of a device that didn't start, and that one mustn't be tried again.
  const tried = new Set();
  const play = (device) => {
    if (device) tried.add(device);
    return api("PUT", "/me/player/play", { query: deviceQuery(device), body, deadline });
  };
  await withDevice(play, deadline);
  // Whatever happened, what follows has to answer before the app gives up, so
  // its own message reaches the listener rather than a timeout.
  if (left() <= MIN_REQUEST) throw fail("", t("Spotify took too long to answer. Try again."));
  let silent = await confirmPlaying(uris, deadline, tried.size ? [...tried].at(-1) : "");
  if (silent) {
    if (left() <= MIN_REQUEST) {
      deviceFailure = { name: silent.name, at: Date.now() };
      throw deviceDidNotStart(silent.name);
    }
    const devices = await listDevices(deadline);
    // Sent without a device, the command went to the one Spotify had active.
    if (!tried.size) for (const device of devices) if (device.is_active) tried.add(device.id);
    if (silent.id) tried.add(silent.id);
    // Try once on another open Spotify app, or else the built-in player, and
    // keep using it if it plays. Why the built-in player can't run says more
    // than the silent device, so its errors go to the listener as they are.
    const silentNames = new Set(devices.filter((device) => tried.has(device.id)).map((device) => device.name));
    if (silent.name) silentNames.add(silent.name);
    const other = devices.find((device) => !tried.has(device.id) && !silentNames.has(device.name));
    // Too little time left to try another device is the same as none.
    const id = left() < 4000 ? null : other ? other.id : await startLocal(waitWithin(deadline));
    if (id && !tried.has(id)) {
      await play(id);
      const again = await confirmPlaying(uris, deadline, id);
      if (!again) host.storage.set("device", other ? other.id : LOCAL);
      silent = again && { ...again, name: again.name || other?.name || localName() };
    }
    if (silent && !silent.name) silent.name = devices.find((device) => tried.has(device.id))?.name || "";
  }
  if (silent) {
    deviceFailure = { name: silent.name, at: Date.now() };
    throw deviceDidNotStart(silent.name);
  }
  deviceFailure = null;
}

// Pausing what's paused, or resuming what plays, is refused with 403. Only
// Premium's 403 says something the listener needs to know.
function ignoreRestriction(error) {
  if (error.status === 403 && error.reason !== "PREMIUM_REQUIRED") return;
  throw error;
}

// Spotify answers 404 to a player command with nothing playing anywhere: say
// what to do about it, rather than pass on the raw status.
const nothingPlaying = () => fail("unavailable", t("Open Spotify on your computer or phone, then play again."));

export async function remotePause() {
  try {
    await api("PUT", "/me/player/pause");
  } catch (error) {
    if (error.status === 404) throw nothingPlaying();
    ignoreRestriction(error);
  }
}

export async function remoteResume() {
  const deadline = Date.now() + PLAY_BUDGET;
  try {
    await withDevice((device) => api("PUT", "/me/player/play", { query: deviceQuery(device), deadline }), deadline);
  } catch (error) {
    if (error.status === 404 || (error.code === "setup" && !soloistKey())) throw nothingPlaying();
    ignoreRestriction(error);
  }
}

export async function remoteSeek({ position }) {
  try {
    await api("PUT", "/me/player/seek", { query: { position_ms: Math.max(0, Math.floor(Number(position) || 0)) } });
  } catch (error) {
    if (error.status === 404) throw nothingPlaying();
    throw error;
  }
}

export async function remoteVolume({ percent }) {
  const value = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
  try {
    await api("PUT", "/me/player/volume", { query: { volume_percent: value } });
  } catch (error) {
    if (error.status === 404) throw nothingPlaying();
    if (error.status === 403 && error.reason !== "PREMIUM_REQUIRED") {
      throw fail("", t("This Spotify device doesn't let others change its volume."));
    }
    throw error;
  }
}

export async function remoteState() {
  const data = await api("GET", "/me/player", { query: { additional_types: "episode" } });
  if (!data || !data.device) return null;
  const item = data.item;
  let trackId = "";
  if (item?.type === "episode") trackId = `episode:${item.id}`;
  else if (item?.id) trackId = item.id;
  return {
    playing: !!data.is_playing, trackId,
    position: data.progress_ms || 0, duration: item?.duration_ms || 0,
    volume: Number.isFinite(data.device.volume_percent) ? data.device.volume_percent : 100,
    device: data.device.name || "",
  };
}

// The device menu lists Spotify's devices, and the built-in player too while
// it isn't running yet.
export async function remoteDevices() {
  const devices = (await listDevices()).map((device) => ({ id: device.id, name: device.name || "Spotify", active: !!device.is_active }));
  const running = local?.stage === "ready" && (local.deviceId
    ? devices.some((device) => device.id === local.deviceId)
    : devices.some((device) => device.name === localName()));
  if (soloistOffered() && !running) {
    devices.push({ id: LOCAL, name: t("This computer (Spotify Soloist)"), active: false });
  }
  return devices;
}

export async function remoteUse({ deviceId }) {
  const id = String(deviceId || "");
  if (!id) throw fail("", t("Choose a device."));
  // The device the listener chose replaces one a failed play named.
  deviceFailure = null;
  const builtIn = id === LOCAL || (local?.stage === "ready" && (await local.ready.catch(() => "")) === id);
  const target = id === LOCAL ? await startLocal() : id;
  await api("PUT", "/me/player", { body: { device_ids: [target] } });
  // The built-in player is remembered as such: its device exists only while
  // it runs, and it's started again when next needed.
  host.storage.set("device", builtIn ? LOCAL : id);
}
