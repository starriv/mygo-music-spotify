import test from "node:test";
import assert from "node:assert/strict";
import {
  json, empty, bytes, signedIn, setup, track, me, fastPolling,
} from "./helpers.mjs";

// The host asks for the next page at the number already shown. Null items
// must not make it ask for results it has already had.
test("search pages by Spotify's offset even when it drops items", async () => {
  const offsets = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    const params = call.url.searchParams;
    assert.equal(params.get("limit"), "10");
    assert.equal(params.get("type"), "playlist");
    const offset = Number(params.get("offset"));
    offsets.push(offset);
    const items = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? null : {
      id: `p${offset + i}`, name: `List ${offset + i}`, owner: { id: "someone" }, items: { total: 4 },
    }));
    return json({ playlists: { items, next: offset < 20 ? "https://api.spotify.com/v1/search?offset=x" : null } });
  }, { saved: signedIn() });
  const first = await plugin.search({ query: "mix", kind: "playlists", offset: 0 });
  assert.equal(first.playlists.length, 6);
  assert.equal(first.playlists[0].trackCount, 4);
  assert.equal(first.more, true);
  const second = await plugin.search({ query: "mix", kind: "playlists", offset: 6 });
  assert.deepEqual(offsets, [0, 10]);
  assert.equal(second.playlists[0].id, "p11");
  await plugin.search({ query: "mix", kind: "playlists", offset: 12 });
  assert.deepEqual(offsets, [0, 10, 20]);
});

test("home keeps working when one section fails", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/top/artists") return json({ error: { status: 500 } }, 500);
    if (call.url.pathname === "/v1/me/player/recently-played") return json({ items: [{ track: track("a") }, { track: track("a") }, { track: track("b") }] });
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  const home = await plugin.home();
  assert.deepEqual(home.sections[0].tracks.map((t) => t.id), ["a", "b"]);
  assert.match(home.sections[2].empty, /Couldn't load this/);
});

test("artist page finds the artist's own songs by search, without top tracks", async () => {
  const paths = [];
  const { plugin } = await setup((call) => {
    paths.push(call.url.pathname);
    if (call.url.pathname === "/v1/artists/artist1") return json({ id: "artist1", name: "Artist" });
    if (call.url.pathname === "/v1/artists/artist1/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (call.url.pathname === "/v1/me/library/contains") return json([true]);
    assert.equal(call.url.searchParams.get("q"), "artist:\"Artist\"");
    return json({ tracks: { items: [track("a"), track("b", { artists: [{ id: "other" }] })], next: null } });
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "artist1" });
  assert.equal(page.artist.following, true);
  assert.deepEqual(page.tracks.map((t) => t.id), ["a"]);
  assert.deepEqual(page.albums.map((a) => a.id), ["al"]);
  assert.ok(!paths.some((p) => p.endsWith("top-tracks")));
});

test("an artist page keeps what loaded when Spotify limits one section", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/artist1") return json({ id: "artist1", name: "Artist" });
    if (path === "/v1/artists/artist1/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    // The searches the songs section makes are the two that get turned down.
    return json({ error: { status: 429, message: "API rate limit exceeded" } }, 429);
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "artist1" });
  assert.equal(page.artist.name, "Artist");
  assert.deepEqual(page.albums.map((a) => a.id), ["al"]);
  // The songs are missing, and the page is still a page.
  assert.deepEqual(page.tracks, []);
});

test("a page loads even when Spotify can't say whether it's saved", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me/library/contains") return json({ error: { status: 400, message: "Unsupported type" } }, 400);
    if (call.url.pathname === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (call.url.pathname === "/v1/artists/ar1/albums") return json({ items: [], next: null });
    if (call.url.pathname === "/v1/albums/al1") return json({ id: "al1", name: "Album", tracks: { items: [track("a")], next: null } });
    return json({ tracks: { items: [], next: null } });
  }, { saved: signedIn() });
  assert.equal((await plugin.album({ id: "al1" })).album.saved, false);
  assert.equal((await plugin.artist({ id: "ar1" })).artist.following, false);
});

test("odd data doesn't break pages: bad character references, a bad local ID, an empty next page", async () => {
  let pages = 0;
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/playlists/p1") {
      return json({ id: "p1", name: "L", owner: { id: "listener" }, description: "A &#99999999; B &#x1F3B5; &amp;",
        items: { total: 5, items: [{ item: track("a") }], next: "https://api.spotify.com/v1/playlists/p1/items?offset=1" } });
    }
    pages++;
    return json({ items: [], next: "https://api.spotify.com/v1/playlists/p1/items?offset=1" });
  }, { saved: signedIn() });
  const list = await plugin.playlist({ id: "p1" });
  assert.equal(list.description, "A &#99999999; B 🎵 &");
  assert.equal(list.tracks.length, 1);
  assert.equal(pages, 1);
  await assert.rejects(plugin.removeFromPlaylist({ id: "p1", trackIds: ["local:%E0%A4%A"] }), /isn't a list of songs/);
});

test("a read that meets a passing server error is tried once more; a write isn't", async (t) => {
  fastPolling(t);
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 1000 ? 0 : ms, ...args));
  let reads = 0;
  let writes = 0;
  const { plugin } = await setup((call) => {
    if (call.method === "GET") return ++reads === 1 ? json({}, 503) : json({ items: [], next: null });
    writes++;
    return json({}, 503);
  }, { saved: signedIn() });
  await plugin.liked({ offset: 0 });
  assert.equal(reads, 2);
  await assert.rejects(plugin.like({ id: "a", on: true }), /having trouble/);
  assert.equal(writes, 1);
});

test("a short rate limit is waited out once", async () => {
  let calls = 0;
  const { plugin } = await setup(() => (++calls === 1 ? json({ error: { status: 429 } }, 429, { "retry-after": "0" }) : json({ items: [], next: null })), { saved: signedIn() });
  await plugin.liked({ offset: 0 });
  assert.equal(calls, 2);
});

test("home asks only for the first playlists it shows", async () => {
  const pages = [];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/playlists") {
      pages.push(Number(call.url.searchParams.get("offset") || 0));
      return json({
        items: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, owner: { id: "listener" }, items: { total: 0 } })),
        next: "https://api.spotify.com/v1/me/playlists?offset=50",
      });
    }
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  await plugin.home();
  assert.deepEqual(pages, [0]);
});

test("a 404 from Spotify is unavailable, with words the listener can act on", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/library/contains") return json([false]);
    return json({ error: { status: 404, message: "non existing id" } }, 404);
  }, { saved: signedIn() });
  await assert.rejects(plugin.album({ id: "gone" }), { code: "unavailable", message: /can't find this/ });
  await assert.rejects(plugin.artist({ id: "gone" }), { code: "unavailable" });
});

test("an image without a width isn't chosen by width", async () => {
  const album = (images) => ({
    id: "al", name: "A", images,
    artists: [], release_date: "", tracks: { items: [track("a")], next: null },
  });
  let images = [{ url: "https://i.scdn.co/1000", width: 1000 }, { url: "https://i.scdn.co/no-width" }];
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/me/library/contains") return json([false]);
    return json(album(images));
  }, { saved: signedIn() });
  assert.equal((await plugin.album({ id: "al" })).album.imageUrl, "https://i.scdn.co/1000");
  images = [{ url: "https://i.scdn.co/only" }];
  assert.equal((await plugin.album({ id: "al" })).album.imageUrl, "https://i.scdn.co/only");
});

test("descriptions are decoded once, and a plain one keeps its angle brackets", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/shows/s1") {
      return json({ id: "s1", name: "Show", description: "plain <b> text", html_description: "<p>A &#38;lt; B</p>", total_episodes: 1 });
    }
    if (call.url.pathname === "/v1/shows/s1/episodes") {
      return json({ items: [{ id: "e1", name: "Ep", description: "episode <i> plain", duration_ms: 1 }], next: null });
    }
    return json([false]);
  }, { saved: signedIn() });
  const page = await plugin.show({ id: "s1" });
  // "&#38;lt;" is the text "&lt;", not a second entity to turn into "<".
  assert.equal(page.show.description, "A &lt; B");
  assert.equal(page.episodes[0].description, "episode <i> plain");
});

test("a search keeps its place across a plugin restart, without keeping the query", async () => {
  const store = new Map();
  const offsets = [];
  const handler = (call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname !== "/v1/search") throw new Error(`unexpected ${call.url.pathname}`);
    const offset = Number(call.url.searchParams.get("offset"));
    offsets.push(offset);
    const items = Array.from({ length: 10 }, (_, i) => (i % 3 === 0 ? null : {
      id: `p${offset + i}`, name: `List ${offset + i}`, owner: { id: "someone" }, items: { total: 4 },
    }));
    return json({ playlists: { items, next: offset < 20 ? "https://api.spotify.com/v1/search?offset=x" : null } });
  };
  let ctx = await setup(handler, { saved: signedIn(), store });
  const first = await ctx.plugin.search({ query: "mix", kind: "playlists", offset: 0 });
  assert.equal(first.playlists.length, 6);
  // A restarted plugin has its own module state, but the host's storage stays.
  ctx = await setup(handler, { saved: signedIn(), store });
  const second = await ctx.plugin.search({ query: "mix", kind: "playlists", offset: 6 });
  assert.deepEqual(offsets, [0, 10]);
  assert.equal(second.playlists[0].id, "p11");
  // The listener's query itself isn't kept in the plugin's storage.
  assert.ok(!JSON.stringify(store.get("searchCursors")).includes("mix"));
});

test("a search still answers when it can't save its place", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname !== "/v1/search") throw new Error(`unexpected ${call.url.pathname}`);
    return json({ tracks: { items: [track("a")], next: null } });
  }, { saved: signedIn() });
  const set = globalThis.host.storage.set;
  globalThis.host.storage.set = () => { throw new Error("disk full"); };
  try {
    const page = await plugin.search({ query: "x", kind: "tracks", offset: 0 });
    assert.deepEqual(page.tracks.map((t) => t.id), ["a"]);
  } finally {
    globalThis.host.storage.set = set;
  }
});

// --- the player identity -------------------------------------------------

// Just enough protobuf to stand in for spclient's answers.
const pbVarint = (value) => {
  const bytes = [];
  let left = value;
  while (left > 0x7f) { bytes.push((left & 0x7f) | 0x80); left = Math.floor(left / 128); }
  bytes.push(left);
  return Uint8Array.from(bytes);
};
const pbJoin = (parts) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
};
const pbBytes = (number, value) => pbJoin([pbVarint(number * 8 + 2), pbVarint(value.length), value]);
const pbString = (number, value) => pbBytes(number, new TextEncoder().encode(value));
const pbInt = (number, value) => pbJoin([pbVarint(number * 8), pbVarint(value)]);
const pbSint = (number, value) => pbInt(number, value >= 0 ? value * 2 : -value * 2 - 1);

const ALBUM_GID = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
const ARTIST_GID = Uint8Array.from([0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
  0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]);
const COVER = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef]);

const playlistRows = (uris, total = uris.length) => pbJoin([
  pbInt(2, total),
  pbBytes(5, pbJoin(uris.map((uri) => pbBytes(3, pbString(1, uri))))),
]);

const entity = (uri, message) => pbBytes(3, pbJoin([
  pbString(2, uri),
  pbBytes(3, pbJoin([pbString(1, "spotify:track"), pbBytes(2, message)])),
]));
const BASE62_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const base62Of = (bytes) => {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 62; carry = Math.floor(carry / 62); }
    while (carry) { digits.push(carry % 62); carry = Math.floor(carry / 62); }
  }
  return digits.reverse().map((digit) => BASE62_DIGITS[digit]).join("").padStart(22, "0");
};
const metadataAnswer = (entries) => pbJoin(entries.map((message) => pbBytes(2, message)));
// The kinds /extended-metadata is asked for, and what a request says.
const ARTIST_V4 = 8;
const ALBUM_V4 = 9;
const TRACK_V4 = 10;
const extensionKindOf = (body) => {
  const bytes = Array.from(body || []);
  const at = bytes.findIndex((byte, index) => byte === 0x08 && [ARTIST_V4, ALBUM_V4, TRACK_V4].includes(bytes[index + 1]));
  return at < 0 ? 0 : bytes[at + 1];
};
const carriesCountry = (body, country) => Buffer.from(body || []).includes(Buffer.from(pbString(1, country)));
// An artist's own metadata, wrapped the way /extended-metadata answers it.
const artistAnswer = (id, message) => bytes(metadataAnswer([entity(`spotify:artist:${id}`, message)]));

test("a playlist the Web API withholds is read from the player identity", async () => {
  const first = "0qMZXgcLfkl5RI3q50KHMH";
  const second = "41QC4JsoYNy5LwW679i6Yx";
  const track = (name, duration) => pbJoin([
    pbString(2, name),
    pbBytes(3, pbJoin([
      pbBytes(1, ALBUM_GID), pbString(2, "10,000 gecs"),
      pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
    ])),
    pbBytes(4, pbJoin([pbBytes(1, ARTIST_GID), pbString(2, "100 gecs")])),
    pbSint(7, duration),
  ]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin, calls } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    if (call.url.pathname === "/v1/playlists/theirs") {
      return json({ id: "theirs", name: "Theirs", owner: { id: "other" }, items: { total: 2 } });
    }
    if (call.url.pathname === "/playlist/v2/playlist/theirs") {
      return bytes(playlistRows([`spotify:track:${first}`, "spotify:local:CHEMOTEX:Schrade+Knives:Schrade+Knives:353", `spotify:track:${second}`]));
    }
    if (call.url.pathname === "/extended-metadata/v0/extended-metadata") {
      return bytes(metadataAnswer([
        entity(`spotify:track:${first}`, track("Dumbest Girl Alive", 200000)),
        entity(`spotify:track:${second}`, track("Residual Stress", 155000)),
      ]));
    }
    throw new Error(`unexpected ${call.url.pathname}`);
  }, { saved: signedIn(), store });

  const theirs = await plugin.playlist({ id: "theirs" });
  assert.equal(theirs.tracks.length, 3);
  assert.equal(theirs.trackCount, 3);
  assert.deepEqual(theirs.tracks.map((song) => song.id), [
    first, `local:${encodeURIComponent("spotify:local:CHEMOTEX:Schrade+Knives:Schrade+Knives:353")}`, second,
  ]);
  assert.deepEqual(theirs.tracks.map((song) => song.name), ["Dumbest Girl Alive", "Schrade Knives", "Residual Stress"]);
  // A local file counts in the playlist, as the Spotify app counts it.
  assert.equal(theirs.tracks[1].unavailable, true);
  assert.equal(theirs.tracks[1].duration, 353000);
  assert.equal(theirs.tracks[0].duration, 200000);
  assert.equal(theirs.tracks[0].url, `https://open.spotify.com/track/${first}`);
  // A gid comes back as bytes: the app's album ID is the base62 of them.
  assert.equal(theirs.tracks[0].album.id, "0296TIIbB3u904riPYGPJJ");
  assert.equal(theirs.tracks[0].artists[0].id, "7KUVjxDTSChB9IHu38yRSo");
  assert.equal(theirs.tracks[0].album.imageUrl, "https://i.scdn.co/image/deadbeefdeadbeefdeadbeef");
  assert.equal(theirs.tracks[0].album.name, "10,000 gecs");

  // The player's own token reads spclient; the app's Web API token doesn't.
  const reads = calls.filter((call) => call.url.host === "spclient.wg.spotify.com");
  // The rows, then one metadata request for the two songs that need details.
  assert.equal(reads.length, 2);
  assert.equal(reads[0].headers.Authorization, "Bearer player-access");
  // Two songs cost one metadata request, not one each.
  const metadata = reads.filter((call) => call.url.pathname === "/extended-metadata/v0/extended-metadata");
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].method, "POST");
  assert.equal(metadata[0].headers["Content-Type"], "application/x-protobuf");
});

// A row shows its cover a few dozen points wide: the size Spotify labels
// large is the one it gets, not the largest, which is several times the bytes.
test("a song row takes the large cover, not the largest", async () => {
  const LARGE = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc]);
  const XLARGE = Uint8Array.from([0xdd, 0xee, 0xff, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01]);
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const song = "0qMZXgcLfkl5RI3q50KHMH";
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/me") return json(me);
    if (path === "/v1/playlists/theirs") {
      return json({ id: "theirs", name: "Theirs", owner: { id: "other" }, items: { total: 1 } });
    }
    if (path === "/playlist/v2/playlist/theirs") return bytes(playlistRows([`spotify:track:${song}`]));
    return bytes(metadataAnswer([entity(`spotify:track:${song}`, pbJoin([
      pbString(2, "Song"),
      pbBytes(3, pbJoin([pbBytes(17, pbJoin([
        pbBytes(1, pbJoin([pbBytes(1, XLARGE), pbInt(2, 3)])),
        pbBytes(1, pbJoin([pbBytes(1, LARGE), pbInt(2, 2)])),
      ]))])),
    ]))]));
  }, { saved: signedIn(), store });

  const list = await plugin.playlist({ id: "theirs" });
  assert.equal(list.tracks[0].album.imageUrl, `https://i.scdn.co/image/${hex(LARGE)}`);
});
test("a listener who never approves the player identity keeps the note", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    return json({ id: "theirs", name: "Theirs", owner: { id: "other" }, items: { total: 30 } });
  }, {
    saved: signedIn(),
    // A closed page is a rejected approval, and nothing else is asked for.
    redirect: async () => { throw new Error("sign-in timed out"); },
  });
  const theirs = await plugin.playlist({ id: "theirs" });
  assert.deepEqual(theirs.tracks, []);
  assert.match(theirs.description, /only your own and collaborative playlists/);
  // The second playlist doesn't open a browser window again.
  const again = await plugin.playlist({ id: "theirs" });
  assert.deepEqual(again.tracks, []);
});

test("a chart country is asked for on its own, and wins", async () => {
  const song = (gid, name) => pbJoin([
    pbBytes(1, gid),
    pbString(2, name),
    pbBytes(3, pbJoin([pbString(2, "Album")])),
    pbBytes(4, pbJoin([pbString(2, "Artist")])),
    pbSint(7, 120000),
  ]);
  const ACCOUNT_GID = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const WANTED_GID = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const searched = [];
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") { searched.push(call); return json({ tracks: { items: [], next: null } }); }
    // The session's own search finds nothing here.
    if (path.startsWith("/context-resolve/")) return bytes(new TextEncoder().encode(JSON.stringify({ pages: [] })));
    // The country-by-gid route answers the chart of the country it is asked for.
    if (path.startsWith("/metadata/4/artist/")) {
      return bytes(pbJoin([
        pbString(2, "Artist"),
        pbBytes(4, pbJoin([pbString(1, "JP"),
          pbBytes(2, song(WANTED_GID, "JP Song"))])),
      ]));
    }
    // The chart's row names its song by gid, so the page reads its details.
    if (path === "/extended-metadata/v0/extended-metadata" && extensionKindOf(call.body) === TRACK_V4) {
      return bytes(metadataAnswer([entity(`spotify:track:${base62Of(WANTED_GID)}`, song(WANTED_GID, "JP Song"))]));
    }
    // The extension answers for the account's own country, whatever it is told.
    return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
      pbString(2, "Artist"), pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
      pbBytes(4, pbJoin([pbString(1, "IN"), pbBytes(2, song(ACCOUNT_GID, "Account Song"))])),
    ]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "jp" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((song) => song.name), ["JP Song"]);
  assert.deepEqual(page.tracks.map((song) => song.id), [base62Of(WANTED_GID)]);
  assert.equal(page.tracks[0].duration, 120000);
  // The page took its songs from the session, so the Web API's own search
  // wasn't needed.
  assert.equal(searched.length, 0);
  const reads = calls.filter((call) => call.url.host === "spclient.wg.spotify.com");
  const artistRead = reads.find((call) => call.method === "POST");
  assert.equal(extensionKindOf(artistRead.body), ARTIST_V4);
  const chartRead = reads.find((call) => call.url.pathname.startsWith("/metadata/4/artist/"));
  assert.equal(chartRead.url.searchParams.get("country"), "JP");
  assert.equal(chartRead.headers.Authorization, "Bearer player-access");
  assert.ok(reads.some((call) => call.url.pathname.startsWith("/context-resolve/v1/spotify:search:")));
});

test("with no chart country set, the request names none", async () => {
  const american = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const worldwide = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [], next: null } });
    // The rows name their songs by gid, so the page reads their details.
    if (extensionKindOf(call.body) === TRACK_V4) {
      return bytes(metadataAnswer([
        entity(`spotify:track:${base62Of(american)}`, pbJoin([pbString(2, "US Song")])),
        entity(`spotify:track:${base62Of(worldwide)}`, pbJoin([pbString(2, "Worldwide Song")])),
      ]));
    }
    if (extensionKindOf(call.body) === ARTIST_V4) {
      return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
        pbString(2, "Artist"),
        pbBytes(4, pbJoin([pbString(1, "US"), pbBytes(2, pbBytes(1, american))])),
        pbBytes(4, pbJoin([pbString(1, "ZZ"), pbBytes(2, pbBytes(1, worldwide))])),
      ]));
    }
    // No country in the settings means no chart route to ask.
    return bytes(new TextEncoder().encode(JSON.stringify({ pages: [] })));
    throw new Error(`unexpected ${path}`);
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  // No country in the settings leaves the request without one, so the session
  // answers for the account's own country, as Spotify's clients ask it.
  const artist = calls.find((call) => call.url.pathname === "/extended-metadata/v0/extended-metadata");
  assert.equal(Array.from(artist.body)[0], 0x12);
  assert.ok(!carriesCountry(artist.body, "US"));
  // A list for the country in the settings is what the page shows, and the
  // worldwide one stands in when no list names it.
  assert.deepEqual(page.tracks.map((t) => t.name), ["Worldwide Song"]);
});

// Spotify can revoke the player approval. The artist page then asks for a
// new one, instead of falling back to search on every page from then on.
test("a revoked player approval is asked for again by the artist page", async () => {
  const popular = "0qMZXgcLfkl5RI3q50KHMH";
  const POPULAR_GID = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  // An access token past its time, and a refresh token Spotify revoked.
  const store = new Map([["player", {
    accessToken: "old-access", refreshToken: "revoked", expiresAt: Date.now() - 1000,
  }]]);
  const prompts = [];
  const { plugin, calls, opened } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/api/token") {
      const form = new URLSearchParams(call.body);
      if (form.get("grant_type") === "refresh_token") {
        return json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
      }
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
    if (path === "/v1/me") return json(me);
    if (path.startsWith("/playlist/v2/user/")) return bytes(new Uint8Array());
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [], next: null } });
    if (path.startsWith("/context-resolve/")) return bytes(new TextEncoder().encode(JSON.stringify({ pages: [] })));
    if (extensionKindOf(call.body) === TRACK_V4) {
      return bytes(metadataAnswer([entity(`spotify:track:${base62Of(POPULAR_GID)}`, pbJoin([
        pbString(2, "Popular Song"), pbSint(7, 1000)]))]));
    }
    if (extensionKindOf(call.body) === ARTIST_V4) {
      return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
        pbString(2, "Artist"),
        pbBytes(4, pbJoin([pbString(1, "JP"), pbBytes(2, pbBytes(1, POPULAR_GID))])),
      ]));
    }
    throw new Error(`unexpected ${path}`);
  }, {
    saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" },
    // The plugin listens before it opens the browser: answer once it has.
    redirect: async (_options, urls) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { code: "code", state: new URL(urls.at(-1)).searchParams.get("state") };
    },
  });
  globalThis.host.signInPrompt = (prompt) => prompts.push(prompt.text);

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((song) => song.id), [popular]);
  // One browser window, saying what it is for.
  assert.equal(opened.length, 1);
  assert.match(prompts[0], /popular songs on an artist's page/);
  assert.equal(store.get("player").refreshToken, "new-refresh");
  const artist = calls.find((call) => call.url.pathname === "/extended-metadata/v0/extended-metadata");
  assert.equal(artist.headers.Authorization, "Bearer new-access");
});

test("an artist page turned down for the approval falls back to search once", async () => {
  let asked = 0;
  const { plugin, opened } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/artists/ar1/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [track("s1", { artists: [{ id: "ar1", name: "Artist" }] })], next: null } });
    throw new Error(`unexpected ${path}`);
  }, {
    saved: signedIn(), settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" },
    redirect: async () => { asked++; throw new Error("sign-in timed out"); },
  });
  const page = await plugin.artist({ id: "ar1" });
  assert.deepEqual(page.tracks.map((t) => t.id), ["s1"]);
  // The next artist page doesn't open a browser window again.
  await plugin.artist({ id: "ar1" });
  assert.equal(asked, 1);
  assert.equal(opened.length, 1);
});

test("an artist page comes from the session when the quota is spent", async () => {
  const POPULAR = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const ALBUM = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin } = await setup((call) => {
    if (call.url.host === "api.spotify.com") {
      return json({ error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } }, 429);
    }
    // The artist's answer names its albums and songs by gid alone, so the page
    // fills both in with a batch each, whether the Web API's quota is spent or
    // not.
    if (extensionKindOf(call.body) === ALBUM_V4) {
      return bytes(metadataAnswer([entity(`spotify:album:${base62Of(ALBUM)}`, pbJoin([
        pbString(2, "Album"),
        pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
      ]))]));
    }
    if (extensionKindOf(call.body) === TRACK_V4) {
      return bytes(metadataAnswer([entity(`spotify:track:${base62Of(POPULAR)}`, pbJoin([
        pbString(2, "Popular Song"),
        pbBytes(4, pbJoin([pbString(2, "Artist")])),
        pbSint(7, 120000),
      ]))]));
    }
    return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
      pbString(2, "Artist"),
      pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
      pbBytes(5, pbBytes(1, pbBytes(1, ALBUM))),
      pbBytes(4, pbJoin([pbString(1, "JP"), pbBytes(2, pbBytes(1, POPULAR))])),
    ]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.equal(page.artist.name, "Artist");
  assert.match(page.artist.imageUrl, /^https:\/\/i\.scdn\.co\/image\//);
  assert.deepEqual(page.tracks.map((t) => t.name), ["Popular Song"]);
  assert.deepEqual(page.albums.map((a) => a.name), ["Album"]);
  // The album's gid is the ID the app shows, as the Web API's albums are.
  assert.deepEqual(page.albums.map((a) => a.id), [base62Of(ALBUM)]);
  assert.equal(page.albums[0].imageUrl, "https://i.scdn.co/image/deadbeefdeadbeefdeadbeef");
});

test("with a country set, the charts win even while the Web API answers", async () => {
  const POPULAR = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const searched = [];
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") { searched.push(call); return json({ tracks: { items: [], next: null } }); }
    // The country route answers the chart, the artist's own answer the rest,
    // and the rows' details come from the last of the three.
    if (path.startsWith("/metadata/4/artist/")) {
      return bytes(pbJoin([pbString(2, "Artist"), pbBytes(4, pbJoin([pbString(1, "JP"),
        pbBytes(2, pbBytes(1, POPULAR))]))]));
    }
    if (extensionKindOf(call.body) === TRACK_V4) {
      return bytes(metadataAnswer([entity(`spotify:track:${base62Of(POPULAR)}`, pbJoin([
        pbString(2, "Chart Song"), pbSint(7, 100000)]))]));
    }
    if (extensionKindOf(call.body) === ARTIST_V4) {
      return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
        pbString(2, "Artist"), pbBytes(17, pbBytes(1, pbJoin([pbBytes(1, COVER), pbInt(2, 3)]))),
        // An album the session could read, were the Web API's albums missing.
        pbBytes(5, pbBytes(1, pbBytes(1, ALBUM_GID))),
      ]));
    }
    return bytes(new TextEncoder().encode(JSON.stringify({ pages: [] })));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((t) => t.name), ["Chart Song"]);
  // The session's page carried the songs, so the Web API's search wasn't asked.
  assert.equal(searched.length, 0);
  // The Web API still answered the albums, so the session didn't fetch them.
  assert.deepEqual(page.albums.map((a) => a.id), ["al"]);
  assert.ok(!calls.some((call) => extensionKindOf(call.body) === ALBUM_V4));
});

// An artist's charts can name their songs by gid alone. The page then fills
// them in with one batch, instead of the rows going missing.
test("a chart list that only names its songs is read in one batch", async () => {
  const GID_A = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const GID_B = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [], next: null } });
    if (extensionKindOf(call.body) === ARTIST_V4) {
      return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
        pbString(2, "Artist"),
        pbBytes(4, pbJoin([
          pbString(1, "JP"),
          pbBytes(2, pbBytes(1, GID_A)),
          pbBytes(2, pbBytes(1, GID_B)),
        ])),
      ]));
    }
    return bytes(metadataAnswer([
      entity(`spotify:track:${base62Of(GID_A)}`, pbJoin([pbString(2, "One"), pbSint(7, 1000)])),
      entity(`spotify:track:${base62Of(GID_B)}`, pbJoin([pbString(2, "Two"), pbSint(7, 2000)])),
    ]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "JP" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((t) => t.name), ["One", "Two"]);
  // The artist, then one batch for the songs it only named.
  const metadata = calls.filter((call) => call.url.pathname === "/extended-metadata/v0/extended-metadata");
  assert.equal(metadata.length, 2);
  assert.equal(extensionKindOf(metadata[1].body), TRACK_V4);
});

// A chart is ten songs of an artist who has many more. The page leads with the
// chart's order, then adds what search finds of the same artist, once each.
test("the charts lead, and search adds the rest of the songs", async () => {
  const POPULAR = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const popular = base62Of(POPULAR);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") {
      const mine = { artists: [{ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" }] };
      return json({
        tracks: {
          items: [
            track(popular, { name: "Popular Song", ...mine }),
            track("41QC4JsoYNy5LwW679i6Yx", { name: "Another Song", ...mine }),
            track("5JaPBs2aQjEfLwM5kVb4jq", { name: "Someone Else", artists: [{ id: "another", name: "Another" }] }),
          ],
          next: null,
        },
      });
    }
    return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
      pbString(2, "Artist"),
      pbBytes(4, pbJoin([pbString(1, "IN"), pbBytes(2, pbJoin([
        pbBytes(1, POPULAR), pbString(2, "Popular Song")]))])),
    ]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  // The chart's song leads, the same song isn't listed twice, another artist's
  // song isn't this artist's, and the rest of the songs follow.
  assert.deepEqual(page.tracks.map((song) => song.name), ["Popular Song", "Another Song"]);
  const search = calls.filter((call) => call.url.pathname === "/v1/search");
  assert.equal(search.length, 1);
  assert.equal(search[0].url.searchParams.get("q"), 'artist:"Artist"');
});

// The Web API's search is a narrow index: an artist's name there can miss
// every song of theirs. The session's own search names them, and the page
// adds the ones the charts leave out, once each, keeping only the artist's own.
test("the session's search adds the songs the charts leave out", async () => {
  const POPULAR = Uint8Array.from([0x0e, 0x32, 0x8f, 0xc4, 0x26, 0xfa, 0x46, 0x43,
    0x84, 0xd3, 0xaa, 0xb8, 0x16, 0xad, 0x40, 0x67]);
  const BESIDE = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const store = new Map([["player", {
    accessToken: "player-access", refreshToken: "player-refresh", expiresAt: Date.now() + 3600000,
  }]]);
  const ARTIST_GID = Uint8Array.from([0xe0, 0x4d, 0xe8, 0xad, 0x65, 0x87, 0x45, 0x06,
    0x9a, 0xcb, 0x16, 0x91, 0x36, 0x86, 0x54, 0xcf]);
  const track = (name, artistGid) => pbJoin([
    pbString(2, name),
    pbBytes(4, pbJoin([pbBytes(1, artistGid), pbString(2, "Artist")])),
    pbSint(7, 1000),
  ]);
  const { plugin, calls } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3") return json({ id: "6PfSUFtkMVoDkx4MQkzOi3", name: "Artist" });
    if (path === "/v1/artists/6PfSUFtkMVoDkx4MQkzOi3/albums") return json({ items: [], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/context-resolve/v1/spotify:artist:6PfSUFtkMVoDkx4MQkzOi3") {
      // The artist's own context: their charts, then their latest album's.
      return bytes(new TextEncoder().encode(JSON.stringify({
        pages: [
          { tracks: [{ uri: `spotify:track:${base62Of(POPULAR)}` }] },
          { tracks: [{ uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }] },
        ],
      })));
    }
    if (path.startsWith("/context-resolve/v1/spotify:search:")) {
      // The same song the charts have, one of the artist's own, and one by
      // somebody else, and another pressing of a song already listed.
      return bytes(new TextEncoder().encode(JSON.stringify({
        pages: [{
          tracks: [
            { uri: `spotify:track:${base62Of(POPULAR)}` },
            { uri: `spotify:track:${base62Of(BESIDE)}` },
            { uri: "spotify:track:5JaPBs2aQjEfLwM5kVb4jq" },
            { uri: "spotify:track:0MMxQds9WTR9OSqrCCY7Mg" },
          ],
        }],
      })));
    }
    if (extensionKindOf(call.body) === TRACK_V4) {
      return bytes(metadataAnswer([
        // The chart's own row, then the latest album's, then what search found.
        entity(`spotify:track:${base62Of(POPULAR)}`, track("Popular Song", ARTIST_GID)),
        entity("spotify:track:4uLU6hMCjMI75M1A2tKUQC", track("Album Song", ARTIST_GID)),
        entity(`spotify:track:${base62Of(BESIDE)}`, track("Beside Song", ARTIST_GID)),
        entity("spotify:track:5JaPBs2aQjEfLwM5kVb4jq", track("Someone Else", ALBUM_GID)),
        entity("spotify:track:0MMxQds9WTR9OSqrCCY7Mg", track("Popular Song", ARTIST_GID)),
      ]));
    }
    return artistAnswer("6PfSUFtkMVoDkx4MQkzOi3", pbJoin([
      pbString(2, "Artist"),
      pbBytes(4, pbJoin([pbString(1, "IN"), pbBytes(2, pbJoin([
        pbBytes(1, POPULAR), pbString(2, "Popular Song")]))])),
    ]));
  }, { saved: signedIn(), store, settings: { clientId: "0123456789abcdef0123456789abcdef", market: "" } });

  const page = await plugin.artist({ id: "6PfSUFtkMVoDkx4MQkzOi3" });
  assert.deepEqual(page.tracks.map((song) => song.name), ["Popular Song", "Album Song", "Beside Song"]);
  // The Web API's own search wasn't needed: the session's found the artist's
  // songs, and the name was what it was asked for first.
  const queries = calls
    .filter((call) => call.url.pathname.startsWith("/context-resolve/v1/spotify:search:"))
    .map((call) => decodeURIComponent(call.url.pathname.split("spotify:search:")[1]).replace(/\+/g, " "));
  assert.deepEqual(queries, ["Artist", "Popular Song"]);
});

const quota = { error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } };
// Spotify says how long a spent quota lasts: here, 35077 s, about 10 h.
const spent = () => json(quota, 429, { "retry-after": "35077" });

test("a spent quota is named, with how long it lasts", async () => {
  let calls = 0;
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/me") return json(me);
    if (path === "/v1/playlists/p1") {
      return json({ id: "p1", name: "L", owner: { id: "listener" },
        items: { total: 2, items: [{ item: track("a") }], next: "https://api.spotify.com/v1/playlists/p1/items?offset=1" } });
    }
    calls++;
    return spent();
  }, { saved: signedIn() });

  // The playlist still loads, with the reason in its description.
  const list = await plugin.playlist({ id: "p1" });
  assert.equal(list.tracks.length, 1);
  assert.match(list.description, /quota for your app is spent\. Part of this page is missing\. It comes back in about 10 h\./);
  // A quota hours away isn't waited out.
  assert.equal(calls, 1);
});

test("an artist page the quota emptied says so in a grey row", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/me/library/contains") return json([false]);
    return spent();
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "ar1" });
  assert.equal(page.artist.name, "Artist");
  assert.deepEqual(page.albums, []);
  assert.equal(page.tracks.length, 1);
  const [row] = page.tracks;
  assert.equal(row.unavailable, true);
  assert.match(row.id, /^missing:/);
  assert.match(row.name, /quota for your app is spent/);
  assert.match(row.artists[0].name, /about 10 h/);
  // The row can't be played or saved.
  await assert.rejects(plugin.remotePlay({ ids: [row.id] }), /can't play this song/);
});

test("an artist page names the quota when only its albums are missing", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [track("s1", { artists: [{ id: "ar1", name: "Artist" }] })], next: null } });
    return spent();
  }, { saved: signedIn() });
  const page = await plugin.artist({ id: "ar1" });
  assert.deepEqual(page.tracks.map((t) => t.id), ["missing:quota", "s1"]);
});

test("an artist page the quota didn't touch has no note", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path === "/v1/artists/ar1/albums") return json({ items: [{ id: "al", name: "Al" }], next: null });
    if (path === "/v1/me/library/contains") return json([false]);
    if (path === "/v1/search") return json({ tracks: { items: [track("s1", { artists: [{ id: "ar1", name: "Artist" }] })], next: null } });
    // Another page spent its quota earlier: this one is unaffected.
    return spent();
  }, { saved: signedIn() });
  await plugin.browse({ page: "top" });
  const page = await plugin.artist({ id: "ar1" });
  assert.deepEqual(page.tracks.map((t) => t.id), ["s1"]);
});

test("the pages that can say the quota is spent, say so", async () => {
  const { plugin } = await setup(() => spent(), { saved: signedIn() });
  // Home is headed by the app itself, which shows no description of ours, so
  // the note lives on the pages the plugin makes: here, Top tracks.
  const top = await plugin.browse({ page: "top" });
  assert.match(top.description, /quota for your app is spent/);
  assert.equal(top.sections.length, 3);
  const recent = await plugin.browse({ page: "recent" });
  assert.match(recent.description, /about 10 h/);
  // Home says it in each section the quota emptied.
  const home = await plugin.home();
  for (const section of home.sections) assert.match(section.empty, /quota for your app is spent/);
});

test("a page Spotify answered says nothing of a quota spent elsewhere", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/artists/ar1/albums") return spent();
    if (path === "/v1/artists/ar1") return json({ id: "ar1", name: "Artist" });
    if (path.startsWith("/v1/me/top/")) return json({ items: [] });
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  await plugin.artist({ id: "ar1" });
  const top = await plugin.browse({ page: "top" });
  assert.equal(top.description, undefined);
});

test("the playlists page lists every playlist, yours first", async () => {
  const { plugin } = await setup((call) => {
    const path = call.url.pathname;
    if (path === "/v1/me") return json(me);
    if (path === "/v1/me/playlists") {
      const offset = Number(call.url.searchParams.get("offset") || 0);
      const items = Array.from({ length: offset ? 10 : 50 }, (_, i) => ({
        id: `p${offset + i}`, name: `List ${offset + i}`, owner: { id: (offset + i) % 2 ? "other" : "listener" }, items: { total: 1 },
      }));
      return json({ items, next: offset ? null : "https://api.spotify.com/v1/me/playlists?offset=50&limit=50" });
    }
    throw new Error(`unexpected ${path}`);
  }, { saved: signedIn() });
  const page = await plugin.browse({ page: "playlists" });
  assert.equal(page.description, undefined);
  assert.deepEqual(page.sections.map((s) => s.title), ["Created by you", "Saved playlists"]);
  // All 60, past the 20 that home shows.
  assert.equal(page.sections[0].playlists.length + page.sections[1].playlists.length, 60);
  assert.ok(page.sections[0].playlists.every((p) => p.mine));
  assert.ok(page.sections[1].playlists.every((p) => !p.mine));
});

test("the playlists page has no saved section when there are none", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    return json({ items: [{ id: "p", name: "Mine", owner: { id: "listener" }, items: { total: 1 } }], next: null });
  }, { saved: signedIn() });
  const page = await plugin.browse({ page: "playlists" });
  assert.deepEqual(page.sections.map((s) => s.title), ["Created by you"]);
});

test("the following page lists followed artists across cursor pages", async () => {
  const asked = [];
  const { plugin } = await setup((call) => {
    assert.equal(call.url.pathname, "/v1/me/following");
    assert.equal(call.url.searchParams.get("type"), "artist");
    const after = call.url.searchParams.get("after");
    asked.push(after);
    if (!after) {
      return json({ artists: { items: [{ id: "a1", name: "One", images: [] }],
        next: "https://api.spotify.com/v1/me/following?type=artist&limit=50&after=a1" } });
    }
    return json({ artists: { items: [{ id: "a2", name: "Two", images: [] }], next: null } });
  }, { saved: signedIn() });
  const page = await plugin.browse({ page: "following" });
  assert.deepEqual(page.sections[0].artists.map((a) => [a.id, a.following]), [["a1", true], ["a2", true]]);
  assert.deepEqual(asked, [null, "a1"]);
});

test("the following page says why it is empty when the quota is spent", async () => {
  const { plugin } = await setup(() => spent(), { saved: signedIn() });
  const page = await plugin.browse({ page: "following" });
  assert.deepEqual(page.sections[0].artists, []);
  assert.match(page.description, /quota for your app is spent/);
  assert.match(page.sections[0].empty, /about 10 h/);
});

test("home's playlists lead to the playlists page", async () => {
  const { plugin } = await setup((call) => {
    if (call.url.pathname === "/v1/me") return json(me);
    return json({ items: [], next: null });
  }, { saved: signedIn() });
  const home = await plugin.home();
  const lists = home.sections.find((s) => s.title === "Your playlists");
  assert.equal(lists.morePage, "playlists");
  // The page it leads to is one the plugin serves.
  await plugin.browse({ page: lists.morePage });
});
