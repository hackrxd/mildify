# Themes and extensions

Mildify loads CSS themes and JavaScript extensions from two folders in its config directory:

| OS | Folder |
| --- | --- |
| Linux | `~/.config/dev.hackrxd.nativespotify/` |
| macOS | `~/Library/Application Support/dev.hackrxd.nativespotify/` |
| Windows | `%APPDATA%\dev.hackrxd.nativespotify\` |

Themes go in `themes/` and extensions in `extensions/`. **Settings → Themes and extensions** has buttons
that open both folders (and create them the first time).

Ready-made examples are in [docs/mods](mods): copy one into the matching folder to try it.

## Themes

A theme is either a single `.css` file, or a folder with a `theme.css` (or `index.css`) in it. Use a
folder when the theme has images or fonts: `url(./background.jpg)` and `@import "./parts.css"`
resolve to files next to the stylesheet.

Pick a theme under **Settings → Theme**. One theme is active at a time. Edits show up when you switch
back to the app window, so you can keep the app open next to your editor. For a folder theme, that
includes its images and `@import`ed files.

The app also comes with a few built-in themes: Ember, Frost, Midnight, Moss, Tide, Velvet, Verde and
Void. They only change the colour variables below, so their stylesheets in [src/themes](../src/themes)
make good starting points for your own.

A theme loads after the app's own styles, so a rule with the same specificity wins. The easiest way
to restyle the app is to override its colour variables:

```css
:root {
  --bg: #0f1420;             /* panel background: sidebar, main view, queue */
  --surface: #141b2b;        /* cards, top bar, settings groups */
  --surface-raised: #1d2740; /* hovered and selected rows, buttons */
  --border: #26314d;         /* dividers, field borders */
  --text: #e6ecf7;           /* main text */
  --text-muted: #8a97b3;     /* secondary text */
  --highlight: #6fd3f7;      /* the accent: play buttons, active items, sliders */
  --on-highlight: #04202b;   /* text on the accent */
  --danger: #f07a6a;
}
```

Themes written for Mildify 1.1 and earlier used `--graphite`, `--panel`, `--raised`, `--line`, `--paper`,
`--smoke`, `--brass` and `--brass-ink` for these. A theme that sets them still works, but extensions should
read the new names.

Also available: `--font-ui`, `--font-display`, the type scale `--t-xs` … `--t-2xl`, and the layout
sizes `--sidebar-w`, `--deck-h` (the player bar's height) and `--gutter`. The window frame behind the
floating panels is `--frame` (derived from `--bg`), the gap between panels `--seam`, their corners
`--panel-radius`, and the shadow under menus and popovers `--shadow-pop`. Animations use `--ease-out`,
`--ease-spring` and `--stagger` (the delay between list items popping in). `--ambient` is set per page
from the cover art.

Components keep their class names (`.sidebar`, `.nav-item`, `.row`, `.btn`, …), but Svelte adds a
`svelte-xxxx` class to scope its styles, so a component rule is one class more specific than it
looks. Repeat a class (`.nav-item.nav-item`) or use `!important` to win against it. Inspect the app
with the webview's developer tools: run the app with `npm run tauri dev` and press Ctrl+Shift+I
(Cmd+Option+I on macOS).

### Quick CSS

**Settings → Quick CSS** is for small tweaks that don't need a file. It applies as you type, on top of
whatever theme is active.

### Metadata

Start a theme or extension with a block comment to give it a name and description in Settings.
Without one, the file name is used.

```css
/**
 * @name Midnight
 * @description Deep blue panels with a cool cyan accent.
 * @author you
 * @version 1.0
 */
```

## Extensions

An extension is an ES module: either a single `.js`/`.mjs` file, or a folder with an `index.js` (or
`index.mjs`, `extension.js`) in it. Relative `import`s work, so a folder extension can be split into
several files. Extensions are off until you turn them on under **Settings → Themes and extensions**.

> Extensions run inside the app with the same access it has: your Spotify account, playback and
> everything on screen. Only turn on extensions you trust.

The module's default export is called with the extension API once the app is signed in. It may
return a cleanup function:

```js
/**
 * @name Hello
 * @description Says hello when a song starts.
 */
export default function (ns) {
  const stop = ns.watch(() => {
    const track = ns.player.track;
    if (track) ns.toasts.show(`Now playing ${track.name}`);
  });
  return () => stop(); // optional: everything registered through `ns` is undone anyway
}
```

Turning an extension off undoes everything it registered through the API (styles, pages, menu
items, watchers, what it added to the DJ, `onUnload` callbacks) and calls the function it returned. From then on, a timer or event handler
the extension left running can't add styles, pages, menu items, watchers or toasts back through the `ns` it was
given, its `ns.api` calls reject without reaching Spotify, and an `onUnload` registered then runs at once.
`ns.player`, `ns.router` and `ns.storage` still work, so stop your own timers and listeners in the function you
return. Editing it (for a folder extension,
any file in the folder) restarts it the next time the app window gets focus. A module without a default export just runs once; it
can't be undone, so turning it off or editing it takes effect when the window reloads (Settings
offers a **Reload window** button then).

### The API

| Member | What it does |
| --- | --- |
| `appVersion` | The app's version, e.g. `"0.3.0"`. |
| `extension` | `{ id, name, url }`: the extension's folder or file name, its display name and its entry file's URL (`new URL("./icon.svg", ns.extension.url)` points at a file next to it). |
| `player` | Playback state and controls: `track`, `isPlaying`, `position`, `positionNow()`, `volume`, `shuffle`, `repeat`, `devices`, and `togglePlay()`, `next()`, `prev()`, `seek(ms)`, `setVolume(percent)`, `toggleShuffle()`, `cycleRepeat()`, `playContext(uri, startUri?)`, `playUris(uris, index?)`, `addToQueue(uri)`, `transferTo(deviceId)`. |
| `router` | Navigation: `current`, `go(route)`, `back()`, `forward()`, `openUri(spotifyUri)`. Routes are `{ name: "home" }`, `{ name: "album", id }`, `{ name: "artist", id }`, `{ name: "playlist", id }`, `{ name: "search", q }`, `{ name: "liked" }`, `{ name: "lyrics" }`, `{ name: "dj" }`, `{ name: "settings" }` (with `section: "dj"`, opened at the AI DJ's settings)… |
| `session` | `user` (the Spotify profile) and `playlists`. |
| `api(method, path, { query, body })` | Calls the Spotify Web API through the app's backend, which holds the token: `ns.api("GET", "/me/top/tracks", { query: { limit: 10 } })`. Rejects with `{ kind, message, status }`, and with `kind: "cancelled"` once the extension is turned off. The app's development-mode limits apply (see the README). |
| `toasts.show(message, tone?)` | Shows a notification; `tone` is `"info"` or `"error"`. |
| `watch(fn)` | Runs `fn` now and again whenever app state it read (`player.track`, `player.isPlaying`, `router.current`, …) changes. `fn` may return a cleanup that runs before each re-run. Returns a stop function. |
| `addStyle(css)` | Adds a stylesheet. Returns a remove function. |
| `addTrackMenuItem({ label, action, when? })` | Adds an entry to the right-click menu of every track, the DJ's songs included. `label` may be a function of the track; `when(track)` hides it for tracks it doesn't apply to; `action(track)` runs on click, and may be async: if it throws or its promise rejects, the error shows as a notice. An entry whose `label` or `when` throws is left out of that menu. The track is the Web API track object (`uri`, `name`, `artists`, `album`, …). Returns a remove function. |
| `addPage({ id, label, icon?, render })` | Adds a page to the sidebar. `render(el)` draws it into an empty element each time the page opens and may return a cleanup for when it closes. `icon` is one of the app's icon names (`"queue"`, `"heart"`, `"disc"`, `"mic"`, `"lyrics"`, …); the default is a puzzle piece. Returns a remove function. |
| `dj` | The AI DJ: what it plays and says, what happens in its sessions, entries for its sets' menus, instructions for it, and segments of your own. See [The DJ](#the-dj). |
| `storage.get(key)`, `storage.set(key, value)`, `storage.remove(key)` | Settings that persist across restarts, kept separate per extension. Values are stored as JSON. |
| `onUnload(fn)` | Runs `fn` when the extension is turned off or restarted. |

Network access is limited to the app's own backend: use `ns.api` for Spotify. `fetch` works for
files next to the extension (`fetch(new URL("./data.json", ns.extension.url))`).

### The DJ

`ns.dj` follows the [AI DJ](dj.md). Its state is reactive, like `ns.player`'s, so read it in `ns.watch`:

| Member | What it is |
| --- | --- |
| `phase` | `"off"`, `"starting"` (getting its first set ready) or `"on"`. |
| `ready` | Turned on, with everything it needs downloaded and set up. |
| `current`, `upNext` | The set playing, and the one after it once it's picked; or `null`. |
| `onAir` | The DJ's talk while it's on, an item of its own in the player: `{ setId, name, durationMs, next }`, where `next` is the song it leads into. |
| `said` | What it said this session, oldest first: `{ setId, name, talk, byModel, spoken }`. `spoken` is false for a line that was only shown. |
| `speaking`, `showing` | Its voice is reading a line out; a line shows without it (Just play, or the voice failed). |
| `requested` | What the listener asked the next set to be, until a set for it comes on. |

A set is `{ id, name, segment, from, songs, talk, byModel, live, request }`: `segment` is the kind of set
(`"onRepeat"`, `"favorites"`, `"throwbacks"`, `"fresh"`, `"rediscover"`, `"request"`, or an extension's
`"ext:<extension id>/<its id>"`), `from` the name of the extension whose segment it is, or `null`, `talk` what the DJ says
to bring it in, `byModel` false when that came from a template, `live` true for a set picked song by song as it
plays, and `request` what the listener asked for, when it's their request. A set picked as it goes grows: each
step is a new copy with the same `id`. A song is `{ uri, name, artists, album, year, durationMs, explicit,
reasons, likedAt, playedAt }`. `reasons` says how it's in the listener's listening (`"onRepeat"`, `"favorite"`,
`"allTime"`, `"recent"`, `"likedLately"`, `"likedLongAgo"`); the dates are ISO strings, or `null`.

These are copies, frozen: changing them changes nothing. The DJ keeps the same copy for as long as it has the same
set, song or list of lines, so comparing with `===` tells you whether anything changed.

`ns.dj.on(fn)` calls `fn` with each thing that happens in a session, and returns a function that stops it:

| Event | When |
| --- | --- |
| `{ type: "set-picked", set }` | A set is picked, ahead of its turn. |
| `{ type: "line-spoken", line }` | The DJ said a line, or showed it: usually just before the `set-started` of the set it brings in, and just after when the set's first song came on before the DJ had had its say. |
| `{ type: "line-withdrawn", line }` | The DJ took a line back: you went back in the song it talked over. It says it again later, with another `line-spoken`. |
| `{ type: "set-started", set }` | A set's first song came on. |
| `{ type: "song-started", song, set }` | One of the DJ's songs came on; `set` is its set, or `null`. |
| `{ type: "song-skipped", song }`, `{ type: "song-unskipped", song }` | A song was left before halfway; Previous right after took that back. |
| `{ type: "song-liked", song }` | A song was liked while the DJ played it. |
| `{ type: "set-skipped", set }` | The listener skipped the rest of a set. |
| `{ type: "stopped" }` | The session ended. |

An event reaches `fn` just after the step of the DJ's that it's about, so the DJ may already be further on: read
`ns.dj` for where it is now. A listener that throws is logged in the developer console, and the others still hear
of it.

`ns.dj.addSetAction({ label, action, when? })` adds an entry to the menu of each set on the DJ page (its "…"
button, or a right-click on its name), as `addTrackMenuItem` does for tracks, with a copy of the set. Returns a
remove function.

`ns.dj.setInstructions(text)` tells the DJ how to talk or what to play from the listener's songs, as the
listener's own instructions under **Tell your DJ** do. The model reads them after the listener's, which come first
where the two disagree. An extension has one set of instructions, up to 300 characters: calling it again replaces
them, and an empty string takes them back, as does the remove function it returns. All extensions' instructions
together can be 600 characters in a prompt; past that, the latest wait until there's room. The DJ page lists each
extension's instructions, so the listener sees everything the DJ is told, and with a cloud model they go to its
provider with the rest of the prompt. They apply from the next set the DJ picks.

`ns.dj.addSegment({ id, label, brief, phrase?, fits })` adds a segment of its own: a kind of set the DJ plays from
the listener's songs, as it does On repeat or Throwbacks. `fits(song)` says whether one of the listener's songs
belongs in it, given a copy of the song as above; it's asked about every song the DJ could play each time it picks a
set, so keep it quick, and its answers about the same song the same. `label` names the segment when the model
doesn't, `brief` says what it is for the model ("songs under three minutes"), up to 200 characters, and `phrase` is
how a template line brings it in ("some short songs"; the label by default). The DJ takes turns between its own
segments and those extensions add, among those with at least three songs that fit, and not one of the last two
while there are others; it opens the show with one of its own whenever it can. The songs only ever come from the listener's own
listening. An extension can add up to three segments, and one with the same `id` replaces it. A `fits` that throws
is taken as not fitting, and logged once. Returns a remove function. The model hears which segments came from an
extension, and the DJ page says so on each of their sets.

`ns.dj` doesn't offer the DJ's settings or keys, what went wrong with its model, or a way to start or stop it. To
play something else, use `ns.player`: the DJ steps out when other music plays.

[DJ log](mods/extensions/dj-log.js) uses all of it: a page that logs what the DJ does, a Short songs segment,
a line of instructions and an entry in each set's menu.

## When something breaks

If a theme or extension leaves the app unusable, start it once with `--safe-mode`: no theme,
Quick CSS or extension loads, and you can turn the culprit off or clear Quick CSS in Settings. Or just delete it from its folder.

On macOS: `open -a "Mildify" --args --safe-mode`. On Linux, run the app from a terminal with
the flag. On Windows, add it to the end of the shortcut's Target (right-click the shortcut →
Properties).

An extension that throws while starting is reported in Settings and isn't retried until its file
changes. Its errors, and anything it logs, show up in the webview's developer console.
