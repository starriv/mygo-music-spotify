import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT, json, empty, signedIn, setup, track, me, playing, fakeSoloist, fastPolling,
} from "./helpers.mjs";

test("remote play sends a window of the queue from the chosen song", async () => {
  let body;
  const { plugin } = await setup((call) => {
    if (call.method === "GET") return playing("a");
    body = JSON.parse(call.body);
    assert.equal(call.url.pathname, "/v1/me/player/play");
    return empty();
  }, { saved: signedIn() });
  const ids = ["x", "missing:1", "a", "local:abc", "episode:e", ...Array.from({ length: 80 }, (_, i) => `q${i}`)];
  await plugin.remotePlay({ ids, start: 2, position: 1234.6 });
  assert.equal(body.uris.length, 50);
  assert.deepEqual(body.uris.slice(0, 3), ["spotify:track:a", "spotify:episode:e", "spotify:track:q0"]);
  assert.deepEqual(body.offset, { position: 0 });
  assert.equal(body.position_ms, 1234);
  await assert.rejects(plugin.remotePlay({ ids, start: 1, position: 0 }), { code: "unavailable" });
});

test("play on a list headed by the quota note starts at its first song", async () => {
  let body;
  const { plugin } = await setup((call) => {
    if (call.method === "GET") return playing("a");
    body = JSON.parse(call.body);
    return empty();
  }, { saved: signedIn() });
  await plugin.remotePlay({ ids: ["missing:quota", "a", "b"], start: 0 });
  assert.deepEqual(body.uris, ["spotify:track:a", "spotify:track:b"]);
  // The note alone is still nothing to play.
  await assert.rejects(plugin.remotePlay({ ids: ["missing:quota"] }), /can't play this song/);
});

test("with no active device, play goes to an open Spotify app, or says to open one", async () => {
  for (const devices of [[{ id: "restricted", is_restricted: true }, { id: "phone", name: "Phone", is_active: false }], []]) {
    const plays = [];
    const { plugin } = await setup((call) => {
      if (call.url.pathname === "/v1/me/player/devices") return json({ devices });
      if (call.url.pathname === "/v1/me/player") return playing("a");
      plays.push(call.url.searchParams.get("device_id"));
      if (!call.url.searchParams.get("device_id")) {
        return json({ error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" } }, 404);
      }
      return empty();
    }, { saved: signedIn() });
    if (devices.length) {
      await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
      assert.deepEqual(plays, [null, "phone"]);
    } else {
      await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), { code: "unavailable" });
    }
  }
});

// Seen live: an offline PC stayed "active", Spotify answered 204 to play, and
// nothing played. The app then showed a few seconds of progress and stopped.
test("when no device starts, not even the built-in player, it says which, then fails fast", async (t) => {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 500 ? 0 : ms, ...args));
  const player = fakeSoloist();
  const seen = [];
  const { plugin } = await setup((call) => {
    seen.push(`${call.method} ${call.url.pathname}`);
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices([{ id: "ghost", name: "HOMEPC", is_active: true }]) });
    if (call.method === "PUT") return empty();
    return json({ is_playing: false, progress_ms: 0, currently_playing_type: "unknown", item: null, device: { name: "HOMEPC", is_active: true } });
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await assert.rejects(plugin.remotePlay({ ids: ["a", "b"], start: 0, position: 0 }), /"HOMEPC" didn't start playing/);
  assert.equal(seen.filter((s) => s === "GET /v1/me/player").length, 24);
  const calls = seen.length;
  await assert.rejects(plugin.remotePlay({ ids: ["a", "b"], start: 1, position: 0 }), /HOMEPC/);
  assert.equal(seen.length, calls);
});

test("when the active device stays silent, another open Spotify app takes over and is remembered", async (t) => {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 500 ? 0 : ms, ...args));
  let target = null;
  const plays = [];
  const { plugin, storage } = await setup((call) => {
    if (call.method === "PUT") {
      target = call.url.searchParams.get("device_id");
      plays.push(target);
      return empty();
    }
    if (call.url.pathname === "/v1/me/player/devices") {
      return json({ devices: [{ id: "ghost", name: "HOMEPC", is_active: true }, { id: "mba", name: "MacBook Air", is_active: false }] });
    }
    return target === "mba" ? playing("a") : json({ is_playing: false, item: null, device: { id: "ghost", name: "HOMEPC" } });
  }, { saved: signedIn() });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, [null, "mba"]);
  assert.equal(storage.get("device"), "mba");
});

test("a relinked track that plays under another ID counts as started", async () => {
  const answers = [json({ is_playing: false, item: null, device: { name: "Mac" } }), playing("relinked")];
  const { plugin } = await setup((call) => (call.method === "PUT" ? empty() : answers.shift()), { saved: signedIn() });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
});

test("Premium is required to control playback, and says so", async () => {
  const { plugin } = await setup(() => json({ error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } }, 403), { saved: signedIn() });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), { code: "unavailable", message: /Premium/ });
  await assert.rejects(plugin.remotePause(), { code: "unavailable" });
});

test("pausing what is already paused is not an error", async () => {
  const { plugin } = await setup(() => json({ error: { status: 403, message: "Restriction violated", reason: "UNKNOWN" } }, 403), { saved: signedIn() });
  await plugin.remotePause();
});

test("remote state maps tracks and episodes, and nothing playing is null", async () => {
  const answers = [
    empty(),
    json({ is_playing: true, progress_ms: 5000, item: track("a"), device: { name: "Mac", volume_percent: 40 } }),
    json({ is_playing: false, progress_ms: 0, item: { type: "episode", id: "e", duration_ms: 9 }, device: { name: "Phone", volume_percent: null } }),
  ];
  const { plugin, calls } = await setup(() => answers.shift(), { saved: signedIn() });
  assert.equal(await plugin.remoteState(), null);
  assert.deepEqual(await plugin.remoteState(), { playing: true, trackId: "a", position: 5000, duration: 200000, volume: 40, device: "Mac" });
  assert.deepEqual(await plugin.remoteState(), { playing: false, trackId: "episode:e", position: 0, duration: 9, volume: 100, device: "Phone" });
  assert.equal(calls[0].url.searchParams.get("additional_types"), "episode");
});

test("choosing a device transfers playback and remembers it", async () => {
  const { plugin, storage, calls } = await setup(() => empty(), { saved: signedIn() });
  await plugin.remoteUse({ deviceId: "speaker" });
  assert.deepEqual(JSON.parse(calls[0].body), { device_ids: ["speaker"] });
  assert.equal(storage.get("device"), "speaker");
});

// Seen live: the offline PC was the only device and inactive. Spotify took
// the command for it, then /me/player answered 204, naming no device, and the
// plugin tried the same PC again instead of the built-in player.
test("a silent device that Spotify's state doesn't name isn't tried twice", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const plays = [];
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices([{ id: "ghost", name: "HOMEPC", is_active: false }]) });
    if (call.url.pathname === "/v1/me/player/play") {
      const device = call.url.searchParams.get("device_id");
      plays.push(device);
      return device ? empty() : json({ error: { status: 404, reason: "NO_ACTIVE_DEVICE" } }, 404);
    }
    return plays.at(-1) === "soloist-id" ? playing("a") : empty();
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, [null, "ghost", "soloist-id"]);
  assert.equal(storage.get("device"), "local");
});

test("the same goes for the active device Spotify picked itself", async (t) => {
  fastPolling(t);
  const player = fakeSoloist();
  const plays = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: player.devices([{ id: "ghost", name: "HOMEPC", is_active: true }]) });
    if (call.url.pathname === "/v1/me/player/play") { plays.push(call.url.searchParams.get("device_id")); return empty(); }
    return plays.at(-1) === "soloist-id" ? playing("a") : empty();
  }, { saved: signedIn(), spawn: (...args) => player.spawn(...args) });
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, [null, "soloist-id"]);
});

test("why the built-in player can't run reaches the listener", async (t) => {
  fastPolling(t);
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: [{ id: "ghost", name: "HOMEPC", is_active: true }] });
    return empty();
  }, { saved: signedIn() });
  await assert.rejects(plugin.remotePlay({ ids: ["a"], start: 0, position: 0 }), { code: "unavailable", message: /Couldn't download Spotify Soloist/ });
});

test("a remembered device that's gone is forgotten", async (t) => {
  fastPolling(t);
  const plays = [];
  const { plugin, storage } = await setup((call) => {
    if (call.url.pathname === "/v1/me/player/devices") return json({ devices: [{ id: "mac", name: "Mac", is_active: true }] });
    if (call.url.pathname === "/v1/me/player/play") {
      const device = call.url.searchParams.get("device_id");
      plays.push(device);
      return device === "old" ? json({ error: { status: 404, message: "Device not found" } }, 404) : empty();
    }
    return playing("a");
  }, { saved: signedIn() });
  storage.set("device", "old");
  await plugin.remotePlay({ ids: ["a"], start: 0, position: 0 });
  assert.deepEqual(plays, ["old", "mac"]);
  assert.equal(storage.get("device"), undefined);
});

test("player commands with nothing playing say to open Spotify", async () => {
  const notFound = () => json({ error: { status: 404, message: "Player command failed: No active device found", reason: "NO_ACTIVE_DEVICE" } }, 404);
  const { plugin } = await setup(notFound, { saved: signedIn(), settings: { clientId: CLIENT } });
  for (const call of [
    () => plugin.remotePause(),
    () => plugin.remoteResume(),
    () => plugin.remoteSeek({ position: 1000 }),
    () => plugin.remoteVolume({ percent: 50 }),
  ]) {
    await assert.rejects(call(), { code: "unavailable", message: /Open Spotify/ });
  }
});
