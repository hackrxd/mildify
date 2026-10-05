// Fake Tauri backend for driving Mildify's frontend in a plain browser (no Spotify login, no Rust).
// Injected with page.addInitScript before the app loads; see ../SKILL.md.
(() => {
  const hues = [350, 20, 45, 150, 190, 220, 260, 300];
  const cover = (i, label = "") => {
    const h = hues[i % hues.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},70%,55%)'/><stop offset='1' stop-color='hsl(${(h + 60) % 360},60%,25%)'/></linearGradient></defs><rect width='300' height='300' fill='url(#g)'/><circle cx='150' cy='150' r='${50 + (i % 3) * 20}' fill='rgba(255,255,255,.15)'/></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  };
  const img = (i) => [{ url: cover(i), width: 300, height: 300 }];
  const artistNames = ["Luna Park", "The Paper Cranes", "Neon Meadow", "Soft Static", "Orla Vance", "Midnight Ferry", "Coral Hex", "Velvet Arcade"];
  const artists = artistNames.map((name, i) => ({ id: "ar" + i, name, uri: "spotify:artist:ar" + i, images: img(i), genres: ["dream pop"] }));
  const sa = (a) => ({ id: a.id, name: a.name, uri: a.uri });
  const albumNames = ["Glass Hours", "Paper Lanterns", "Static Bloom", "After the Tide", "Night Bus", "Cinder & Silk", "Tiny Orbit", "Honey Weather", "Low Light", "Sundial", "Parade", "Moth Songs"];
  const albums = albumNames.map((name, i) => ({ id: "al" + i, name, uri: "spotify:album:al" + i, album_type: "album", images: img(i + 2), artists: [sa(artists[i % 8])], release_date: `${2015 + (i % 10)}-0${1 + (i % 9)}-12`, total_tracks: 10 }));
  const trackNames = ["Afterglow", "Paper Moon", "Slow Dissolve", "Fireflies in March", "Velvet Hours", "Satellite Heart", "Glass Houses", "Lantern", "Winter Light", "Sugar Static", "Tidal", "Overpass", "Honeycomb", "Midnight Bloom", "Daydream Express", "Soft Landing"];
  const tracks = trackNames.map((name, i) => ({ id: "tr" + i, name, uri: "spotify:track:tr" + i, duration_ms: 170000 + i * 9000, explicit: i % 7 === 3, artists: [sa(artists[i % 8])], track_number: (i % 10) + 1, disc_number: 1, type: "track", is_playable: true, album: albums[i % 12] }));
  const user = { id: "u1", display_name: "Mika Tanaka", images: [] };
  const playlistNames = ["Late Night Drive", "Focus Flow", "Sunday Morning", "Gym Hype", "Rainy Day", "Road Trip", "Coffee Shop", "Throwbacks"];
  const playlists = playlistNames.map((name, i) => ({ id: "pl" + i, name, uri: "spotify:playlist:pl" + i, description: "A playlist of " + name.toLowerCase(), images: img(i + 4), owner: user, collaborative: false, public: true }));
  const page = (items, extra = {}) => ({ items, next: null, total: items.length, offset: 0, limit: 50, ...extra });
  const now = Date.now();
  const status = {
    config: { client_id: "mockclientid", device_name: "Mildify", device_id: "dev1", bitrate: 160, initial_volume: 70, normalisation: true, devtools: false,
      dj: { enabled: false, model: "own", voice: "", server_url: "", server_model: "" } },
    redirect_uri: "http://127.0.0.1:8898/callback", signed_in: true,
    device: { state: "ready", device_id: "dev1", name: "Mildify", error: null },
    devtools: { port: null, error: null },
  };
  if (window.__SIGNED_OUT) { status.config.client_id = null; status.signed_in = false; }
  window.__mock = { status, tracks, albums, artists, playlists };
  const api = (method, path, q) => {
    path = path.replace("https://api.spotify.com/v1", "");
    if (path === "/me") return user;
    if (path === "/me/playlists") return page(playlists);
    if (path === "/me/tracks") return page(tracks.map((t, i) => ({ added_at: new Date(now - i * 864e5).toISOString(), track: t })), { total: 16 });
    if (path === "/me/albums") return page(albums.map((a) => ({ added_at: "2025-01-01T00:00:00Z", album: a })));
    if (path === "/me/following") return { artists: page(artists) };
    if (path === "/me/player/recently-played") return page(tracks.map((t, i) => ({ track: t, played_at: new Date(now - i * 36e5).toISOString(), context: null })));
    if (path === "/me/top/artists") return page(artists);
    if (path === "/me/top/tracks") return page(tracks);
    if (path === "/me/library/contains") return (q?.query?.find?.(() => 0) ?? []);
    if (path.startsWith("/albums/")) { const a = albums.find((x) => x.id === path.slice(8)) || albums[0]; return { ...a, tracks: page(tracks.slice(0, 10).map((t, i) => ({ ...t, track_number: i + 1 }))) , copyrights: [{ text: "2024 Mock Records", type: "C" }] }; }
    if (path.match(/^\/artists\/[^/]+\/albums/)) return page(albums.slice(0, 10));
    if (path.startsWith("/artists/")) return artists.find((x) => x.id === path.slice(9)) || artists[0];
    if (path.startsWith("/playlists/")) { const p = playlists.find((x) => x.id === path.split("/")[2]) || playlists[0]; const items = tracks.map((t, i) => ({ added_at: new Date(now - i * 864e5).toISOString(), item: t })); return path.endsWith("/items") ? page(items) : { ...p, items: page(items) }; }
    if (path === "/search") return { tracks: page(tracks.slice(0, 8)), artists: page(artists.slice(0, 6)), albums: page(albums.slice(0, 6)), playlists: page(playlists.slice(0, 5)) };
    if (path === "/me/player") return { device: { id: "dev1", name: "Mildify", type: "Computer", is_active: true, is_restricted: false, volume_percent: 70 }, repeat_state: "off", shuffle_state: false, context: null, timestamp: Date.now(), progress_ms: 62000, is_playing: window.__playing !== false, item: tracks[0], currently_playing_type: "track" };
    if (path === "/me/player/devices") return { devices: [{ id: "dev1", name: "Mildify", type: "Computer", is_active: true, is_restricted: false, volume_percent: 70 }] };
    if (path === "/me/player/queue") return { currently_playing: tracks[0], queue: tracks.slice(1, 9) };
    return null;
  };
  const handlers = {
    app_status: () => window.__mock.status, save_settings: () => window.__mock.status, sign_in: () => window.__mock.status, sign_out: () => window.__mock.status,
    api: (a) => api(a.method, a.path, { query: Object.entries(a.query || {}) }),
    list_mods: () => ({ themes_dir: "~/.config/mildify/themes", extensions_dir: "~/.config/mildify/extensions", base_url: "nsmod://localhost", safe_mode: false, themes: [], extensions: [] }),
    lyrics_server_status: () => ({ url: "https://lyrics.example", reachable: true, auth_required: false, version: "1.0", username: null, error: null }),
    spicy_lyrics: () => null, ui_update: () => ({ status: "up_to_date" }),
    dj_status: () => ({ supported: true, settings: window.__mock.status.config.dj, ready: false, setup: null, needed: [], install: { running: false, component: null, received: 0, total: null, error: null }, disk_bytes: 0, folder: "~/dj", models: [], voices: [] }),
  };
  let cb = 1; const cbs = {};
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (f) => { const id = cb++; cbs[id] = f; window["_" + id] = f; return id; },
    unregisterCallback: () => {}, convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd === "plugin:event|listen") return 1;
      if (cmd.startsWith("plugin:")) return null;
      const h = handlers[cmd];
      return h ? h(args || {}) : null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
