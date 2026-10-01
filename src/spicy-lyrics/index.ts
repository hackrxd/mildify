// Entry point for the vendored Spicy Lyrics renderer inside Native Spotify.
// Mirrors the parts of upstream src/app.tsx that boot the renderer: stylesheets in
// the same order, fonts, and the per-frame auto-scroll loop. The animation loop
// itself starts when lyrics.ts is first imported, exactly as upstream.

// Must come first: the vendored stores read Spicetify.LocalStorage at import time.
import "./compat/spicetify.ts";

import "./src/css/tokens.css";
import "./src/css/primitives.css";
import "./src/css/default.css";
import "./src/css/default.scss";
import "./src/css/Simplebar.css";
import "./src/css/ContentBox.css";
import "./src/css/DynamicBG/spicy-dynamic-bg.css";
import "./src/css/Lyrics/main.css";
import "./src/css/Lyrics/Mixed.css";
import "./src/css/Loaders/LoaderContainer.css";
import "./src/css/Loaders/LyricsSkeleton.css";
import "./src/css/font-pack/font-pack.css";
import "./compat/fonts.css";

import { ApplyFontPixel } from "./src/components/Styling/Fonts.ts";
import PageView, { OnSongChange, PageContainer, SetNowBarOpen } from "./src/components/Pages/PageView.ts";
import { SetFullscreenState } from "./src/components/Utils/Fullscreen.ts";
import { DisableCompactMode, EnableCompactMode } from "./src/components/Utils/CompactMode.ts";
import { SpotifyPlayer } from "./src/components/Global/SpotifyPlayer.ts";
import Global from "./src/components/Global/Global.ts";
import { IntervalManager } from "./src/utils/IntervalManager.ts";
import { ScrollingIntervalTime, isRomanized, setRomanizedStatus } from "./src/utils/Lyrics/lyrics.ts";
import { ScrollToActiveLine } from "./src/utils/Scrolling/ScrollToActiveLine.ts";
import { ScrollSimplebar } from "./src/utils/Scrolling/Simplebar/ScrollSimplebar.ts";
import fetchLyrics from "./src/utils/Lyrics/fetchLyrics.ts";
import ApplyLyrics from "./src/utils/Lyrics/Global/Applyer.ts";
import { $isNowBarOpen } from "./src/utils/uiState.ts";

export { setHost, type Host, type HostTrack } from "./compat/host.ts";

let started = false;

function start() {
  if (started) return;
  started = true;
  // Upstream's LoadFonts() pulls stylesheets from fonts.spikerko.org; the typeface
  // comes from compat/fonts.css instead.
  ApplyFontPixel();
  new IntervalManager(ScrollingIntervalTime, () => {
    if (ScrollSimplebar) ScrollToActiveLine(ScrollSimplebar);
  }).Start();
}

/** Mounts the lyrics page into `host` and loads lyrics for the current track. */
export async function mount(host: HTMLElement) {
  start();
  await PageView.Open(host);
}

export async function unmount() {
  await PageView.Destroy();
}

/** Tell the renderer the track changed (refreshes lyrics, NowBar and background). */
export function songChanged() {
  OnSongChange();
}

export function setNowBar(open: boolean) {
  SetNowBarOpen(open);
}

export function isNowBarOpen() {
  return $isNowBarOpen.get();
}

export function setFullscreen(open: boolean) {
  SetFullscreenState(open);
  PageContainer?.classList.toggle("Fullscreen", open);
}

export function setCompact(on: boolean) {
  if (on) EnableCompactMode();
  else DisableCompactMode();
}

/** Whether the lyrics on screen ship a romanization the user can switch to. */
export function romanizationAvailable() {
  return !!PageContainer?.classList.contains("Lyrics_RomanizationAvailable");
}

export function isRomanizedView() {
  return isRomanized;
}

export function toggleRomanization() {
  setRomanizedStatus(!isRomanized);
  const uri = SpotifyPlayer.GetUri();
  if (uri) fetchLyrics(uri).then(ApplyLyrics);
}

/** Subscribe to lyrics being applied (or replaced by a notice). Returns an unsubscribe. */
export function onLyricsApplied(cb: (type: string) => void) {
  const a = Global.Event.listen("lyrics:apply", (e: { Type: string }) => cb(e?.Type ?? "None"));
  const b = Global.Event.listen("lyrics:not-apply", () => cb("None"));
  return () => {
    Global.Event.unListen(a);
    Global.Event.unListen(b);
  };
}
