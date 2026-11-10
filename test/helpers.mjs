// Shared by the tests: a stand-in for MyGo Music's host and for fetch, so
// the plugin runs here without the app, the network or a Spotify account,
// and fakes of what it talks to (Spotify's answers, Soloist, curl and tar,
// the lyrics sources).
import assert from "node:assert/strict";

// Each test imports the plugin anew, for state of its own.
const PLUGIN = new URL("../src/index.js", import.meta.url).href;

export const CLIENT = "0123456789abcdef0123456789abcdef";

let sequence = 0;

export const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

export const empty = (status = 204) => json(undefined, status);

// A binary answer, for the protobuf spclient sends.
export const bytes = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  headers: { get: () => null },
  text: async () => "",
});

export const signedIn = (extra = {}) => ({
  clientId: CLIENT, accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
  expiresAt: Date.now() + 3600000, ...extra,
});

export async function setup(handler, {
  saved, settings = { clientId: CLIENT, soloistKey: "synthetic-soloist-key" },
  redirect, spawn, platform = "darwin", arch = "arm64", store,
} = {}) {
  const storage = store || new Map();
  if (saved) storage.set("session", structuredClone(saved));
  const reads = [];
  const calls = [];
  const opened = [];
  const removed = [];
  globalThis.host = {
    storage: {
      get: (k) => { reads.push(k); return structuredClone(storage.get(k)); },
      set: (k, v) => storage.set(k, structuredClone(v)),
      remove: (k) => storage.delete(k),
    },
    setting: (k) => settings[k],
    t: (text) => text,
    openURL: (url) => opened.push(url),
    signInPrompt: () => {},
    waitForRedirect: (options) => redirect(options, opened),
    platform, arch, dataDir: "/data/spotify-connect",
    removeDataDir: (name) => removed.push(name),
    spawn: (command, args) => {
      if (!spawn) throw new Error(`fork/exec ${command}: no such file or directory`);
      return spawn(command, args);
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: new URL(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(call);
    return handler(call);
  };
  const plugin = await import(`${PLUGIN}?test=${++sequence}`);
  return { plugin, storage, reads, calls, opened, removed };
}

export const track = (id, extra = {}) => ({
  id, type: "track", name: `Song ${id}`, uri: `spotify:track:${id}`, duration_ms: 200000,
  artists: [{ id: "artist1", name: "Artist" }],
  album: { id: "album1", name: "Album", images: [{ url: "https://i.scdn.co/640", width: 640 }, { url: "https://i.scdn.co/64", width: 64 }] },
  ...extra,
});

export const me = { id: "listener", display_name: "Listener", images: [] };

export const playing = (id) => json({ is_playing: true, progress_ms: 10, item: track(id), device: { name: "Mac" } });

// A fake Spotify Soloist, and the curl and tar that fetch it. Once running
// and paired, it shows in Spotify's devices, until killed or it exits.
export function program(lines = [], exitCode, stderr = "") {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const queue = [...lines];
  if (exitCode !== undefined) setTimeout(() => finish(exitCode), 0);
  return {
    pid: 1, readLine: async () => (queue.length ? queue.shift() : (await done, null)), wait: () => done,
    kill: () => finish(0), errorOutput: () => stderr, write() {}, closeStdin() {}, done,
  };
}

export function fakeSoloist({
  installed = true, paired = true, expireOnce = false, expireText = false, exitWith,
  staged = false, buildAge = 0, versionFails = false, announceId = true,
  curlFails = false, tarFails = false, cdnStale = false,
  thenExitWith, lockOnce = false, binary = "soloist/soloist",
} = {}) {
  const state = {
    installed, paired, staged, spawns: [], current: null, killed: false,
    buildAge, versionFails, announceId, curlFails, tarFails, cdnStale, binary,
  };
  const version = () => `soloist 1.3.10.51 build ${Math.floor((Date.now() - state.buildAge) / 1000)} (20261106) (macos/aarch64)`;
  state.spawn = (command, args) => {
    state.spawns.push({ command, args });
    if (command === "curl") {
      if (state.curlFails) return program(["curl: (28) Connection timed out"], 28, "curl: (28) Connection timed out after 20001 milliseconds");
      state.staged = true;
      // A build downloaded now is fresh, unless the CDN serves a stale one.
      if (!state.cdnStale) state.buildAge = 0;
      return program([], 0);
    }
    if (command === "tar") {
      if (state.tarFails) return program([], 2, "tar: Error exit delayed from previous errors.");
      // No archive to unpack until one is downloaded.
      if (!state.staged) return program([], 2, "tar: Cannot open: No such file or directory");
      state.installed = true;
      return program([], 0);
    }
    assert.equal(command, state.binary);
    if (args[0] === "--version") {
      if (!state.installed || state.versionFails) return program(["soloist: not a valid executable"], 1);
      return program([version()], 0);
    }
    if (!state.installed) throw new Error(`fork/exec ${state.binary}: no such file or directory`);
    if (lockOnce && !state.locked) {
      state.locked = true;
      return program([], 1, 'Error: another session is running for data directory "/data/spotify/soloist".');
    }
    if (expireOnce && !state.expired) {
      state.expired = true;
      return program(["client expired, please update to a newer version. Exiting with exit code 10"], expireText ? 1 : 10);
    }
    if (state.expired && thenExitWith) {
      return program([`2026-11-08 02:19:20.364: ${thenExitWith}`], 1);
    }
    if (exitWith) return program(["2026-11-08 02:19:20.363: soloist 1.3.10", `2026-11-08 02:19:20.364: ${exitWith}`], 1);
    const run = program([`2026-11-08 02:19:20.388: ready, device_name=${args[1]}${state.announceId ? " device_id=soloist-id" : ""}`,
      ...(state.paired ? [] : [`2026-11-08 02:19:20.389: waiting for login — connect to "${args[1]}" from your Spotify app`])]);
    const kill = run.kill;
    run.kill = () => { state.killed = true; kill(); };
    state.crash = kill;
    state.current = { alive: true };
    const current = state.current;
    run.done.then(() => { current.alive = false; });
    return run;
  };
  state.devices = (others = []) => [...others, ...(state.current?.alive && state.paired ? [{ id: "soloist-id", name: "MyGo Music on Mac", is_active: false }] : [])];
  return state;
}

// Polls run at once; a command's wait for the built-in player is short.
export function fastPolling(t) {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    const fixed = ms === 10000 ? 60 : [500, 1500, 3000, 5000, 6000, 30000].includes(ms) ? 0 : ms;
    return timer(fn, fixed, ...args);
  });
}

export const noDeviceThenSoloist = (player, others = []) => {
  let target = null;
  const plays = [];
  const handler = (call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices(others) });
    if (call.url.pathname === "/v1/me/player/play") {
      const device = call.url.searchParams.get("device_id");
      plays.push(device);
      if (!player.devices(others).some((d) => d.id === device)) return json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
      target = device;
      return empty();
    }
    return target ? playing("a") : empty();
  };
  return { handler, plays };
};

// Lyrics come from LRCLIB and NetEase, matched by name, artist and length.
export function lyricsSources({ lrclibGet, lrclibSearch = [], neteaseSongs = [], neteaseLyric = {}, fail = [] } = {}) {
  const seen = [];
  const handler = (call) => {
    const { host: h, pathname } = call.url;
    seen.push(`${h}${pathname}`);
    if (fail.includes(h)) throw new Error("offline");
    if (pathname === "/v1/tracks/t1") {
      return json({ id: "t1", name: "驚鴻一面", duration_ms: 256470, artists: [{ name: "許嵩" }], album: { name: "不如吃茶去" } });
    }
    if (pathname === "/api/get") return lrclibGet ? json(lrclibGet) : json({ code: 404 }, 404);
    if (pathname === "/api/search") return json(lrclibSearch);
    if (pathname === "/api/cloudsearch/pc") return json({ code: 200, result: { songs: neteaseSongs } });
    if (pathname === "/api/song/lyric") return json({ code: 200, ...neteaseLyric });
    throw new Error(`unexpected ${pathname}`);
  };
  return { handler, seen };
}
