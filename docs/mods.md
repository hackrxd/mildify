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
  --graphite: #0f1420; /* window background */
  --panel: #141b2b;    /* sidebar, cards */
  --raised: #1d2740;   /* hovered and selected rows, buttons */
  --line: #26314d;     /* dividers, field borders */
  --paper: #e6ecf7;    /* main text */
  --smoke: #8a97b3;    /* secondary text */
  --brass: #6fd3f7;    /* the accent: play buttons, active items, sliders */
  --brass-ink: #04202b; /* text on the accent */
  --danger: #f07a6a;
}
```

Also available: `--font-ui`, `--font-display`, the type scale `--t-xs` … `--t-2xl`, and the layout
sizes `--sidebar-w`, `--deck-h` (the player bar's height) and `--gutter`. The window frame behind the
floating panels is `--frame` (derived from `--graphite`), the gap between panels `--seam`, their corners
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
items, watchers, `onUnload` callbacks) and calls the function it returned. Editing it (for a folder extension,
any file in the folder) restarts it the next time the app window gets focus. A module without a default export just runs once; it
can't be undone, so turning it off or editing it takes effect when the window reloads (Settings
offers a **Reload window** button then).

### The API

| Member | What it does |
| --- | --- |
| `appVersion` | The app's version, e.g. `"0.3.0"`. |
| `extension` | `{ id, name, url }`: the extension's folder or file name, its display name and its entry file's URL (`new URL("./icon.svg", ns.extension.url)` points at a file next to it). |
| `player` | Playback state and controls: `track`, `isPlaying`, `position`, `positionNow()`, `volume`, `shuffle`, `repeat`, `devices`, and `togglePlay()`, `next()`, `prev()`, `seek(ms)`, `setVolume(percent)`, `toggleShuffle()`, `cycleRepeat()`, `playContext(uri, startUri?)`, `playUris(uris, index?)`, `addToQueue(uri)`, `transferTo(deviceId)`. |
| `router` | Navigation: `current`, `go(route)`, `back()`, `forward()`, `openUri(spotifyUri)`. Routes are `{ name: "home" }`, `{ name: "album", id }`, `{ name: "artist", id }`, `{ name: "playlist", id }`, `{ name: "search", q }`, `{ name: "liked" }`, `{ name: "lyrics" }`, `{ name: "settings" }`… |
| `session` | `user` (the Spotify profile) and `playlists`. |
| `api(method, path, { query, body })` | Calls the Spotify Web API through the app's backend, which holds the token: `ns.api("GET", "/me/top/tracks", { query: { limit: 10 } })`. Rejects with `{ kind, message, status }`. The app's development-mode limits apply (see the README). |
| `toasts.show(message, tone?)` | Shows a notification; `tone` is `"info"` or `"error"`. |
| `watch(fn)` | Runs `fn` now and again whenever app state it read (`player.track`, `player.isPlaying`, `router.current`, …) changes. `fn` may return a cleanup that runs before each re-run. Returns a stop function. |
| `addStyle(css)` | Adds a stylesheet. Returns a remove function. |
| `addTrackMenuItem({ label, action, when? })` | Adds an entry to the right-click menu of every track. `label` may be a function of the track; `when(track)` hides it for tracks it doesn't apply to; `action(track)` runs on click. The track is the Web API track object (`uri`, `name`, `artists`, `album`, …). Returns a remove function. |
| `addPage({ id, label, icon?, render })` | Adds a page to the sidebar. `render(el)` draws it into an empty element each time the page opens and may return a cleanup for when it closes. `icon` is one of the app's icon names (`"queue"`, `"heart"`, `"disc"`, `"mic"`, `"lyrics"`, …); the default is a puzzle piece. Returns a remove function. |
| `storage.get(key)`, `storage.set(key, value)`, `storage.remove(key)` | Settings that persist across restarts, kept separate per extension. Values are stored as JSON. |
| `onUnload(fn)` | Runs `fn` when the extension is turned off or restarted. |

Network access is limited to the app's own backend: use `ns.api` for Spotify. `fetch` works for
files next to the extension (`fetch(new URL("./data.json", ns.extension.url))`).

## When something breaks

If a theme or extension leaves the app unusable, start it once with `--safe-mode`: no theme,
Quick CSS or extension loads, and you can turn the culprit off or clear Quick CSS in Settings. Or just delete it from its folder.

On macOS: `open -a "Mildify" --args --safe-mode`. On Linux, run the app from a terminal with
the flag. On Windows, add it to the end of the shortcut's Target (right-click the shortcut →
Properties).

An extension that throws while starting is reported in Settings and isn't retried until its file
changes. Its errors, and anything it logs, show up in the webview's developer console.
