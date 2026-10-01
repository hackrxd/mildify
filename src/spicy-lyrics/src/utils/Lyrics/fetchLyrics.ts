// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Native Spotify: the transport is replaced. Upstream posts to the
// extension's private /query endpoint and caches in IndexedDB; this asks the host
// (Rust backend), which calls the public v1 API or a Native Spotify lyrics server
// and caches there. AdaptApiLyrics maps the public response onto the renderer's
// internal shape. The presentation/loader/staleness logic is upstream's.

import { $currentLyricsData, $currentLyricsType, $currentlyFetching } from "../stores.ts";
import { SpotifyPlayer } from "../../components/Global/SpotifyPlayer.ts";
import PageView, { PageContainer } from "../../components/Pages/PageView.ts";
import { ProcessLyrics } from "./ProcessLyrics.ts";
import { IsEmptyLyrics } from "./EmptyLines.ts";
import Logger from "../Logger.ts";
import { LyricsQueueRetry } from "./LyricsQueueRetry.ts";
import { HideLyricsSkeleton, IsLyricsSkeletonEnabled, ShowLyricsSkeleton } from "./LyricsSkeleton.ts";
import { onExperimentChange } from "../experiments.ts";
import { host } from "../../../compat/host.ts";

const lyricsLogger = new Logger("Lyrics Pipeline");

/** Public API `source` values mapped to the provider codes the renderer understands. */
const SOURCE_CODES: Record<string, string> = {
  spicy_lyrics: "spl",
  apple_music: "aml",
  spotify: "spt",
};

/**
 * Turns a public v1 response (`{ Body, Status, Type }`) into the renderer's
 * internal lyrics object. Returns null when there's nothing to render.
 */
export function AdaptApiLyrics(response: any): any | null {
  const body = response?.Body ?? response;
  if (!body || typeof body !== "object" || !body.Type) return null;
  const lyrics: any = { ...body };
  lyrics.ApiSource = body.source;
  lyrics.source = SOURCE_CODES[body.source] ?? body.source;
  // Community syncs credit an uploader and maker; upstream calls this TTMLUploadMetadata.
  if (body.UploadAttribution) lyrics.TTMLUploadMetadata = body.UploadAttribution;
  return lyrics;
}

function setRomanizationClass(hasTransliterations: boolean | undefined): void {
  if (hasTransliterations) {
    PageContainer?.classList.add("Lyrics_RomanizationAvailable");
  } else {
    PageContainer?.classList.remove("Lyrics_RomanizationAvailable");
  }
}

/** Shared "lyrics are ready" presentation, as upstream. */
function presentLyrics(lyricsData: any): void {
  LyricsQueueRetry.NotifyResolved(lyricsData?.uri);
  setRomanizationClass(lyricsData?.HasTransliterations);
  HideLoaderContainer();
  $currentLyricsType.set(lyricsData.Type);
  PageContainer?.querySelector<HTMLElement>(".ContentBox")?.classList.remove("LyricsHidden");
  PageContainer?.querySelector(".ContentBox .LyricsContainer")?.classList.remove("Hidden");
  PageView.AppendViewControls(true);
  $currentlyFetching.set(false);
}

/** [descriptor (lyrics or notice keyword), status, uri the fetch was made for]. */
export type FetchLyricsResult = [object | string, number, string?] | null;

let inFlightUri: string | null = null;
let latestRequestedUri: string | null = null;

function isStaleFetch(uri: string): boolean {
  if (latestRequestedUri !== null && latestRequestedUri !== uri) return true;
  const currentUri = SpotifyPlayer.GetUri();
  return currentUri != null && currentUri !== uri;
}

function hideLoaderFor(uri: string): void {
  if (!isStaleFetch(uri)) HideLoaderContainer();
}

export default async function fetchLyrics(uri: string): Promise<FetchLyricsResult> {
  if (!uri) return null;
  if (inFlightUri === uri) {
    lyricsLogger.debug("Fetch already in flight for this track, skipping", uri);
    return null;
  }

  inFlightUri = uri;
  latestRequestedUri = uri;
  $currentlyFetching.set(true);

  try {
    const result = await runFetchLyrics(uri);
    return result ? [result[0], result[1], uri] : null;
  } finally {
    if (inFlightUri === uri) inFlightUri = null;
    $currentlyFetching.set(false);
  }
}

async function runFetchLyrics(uri: string): Promise<[object | string, number] | null> {
  const LyricsContent = PageContainer?.querySelector(".LyricsContainer .LyricsContent") ?? undefined;
  if (!LyricsContent) return null;
  LyricsContent.classList.remove("offline");

  const contentType = SpotifyPlayer.GetContentType();
  if (contentType === "episode") return ["episode-track", 400];
  if (uri.startsWith("spotify:local:")) return ["local-track", 400];
  if (contentType !== "track" || !uri.startsWith("spotify:track:")) return ["unknown-track", 400];

  const trackId = uri.split(":")[2];

  if (IsLyricsSkeletonEnabled()) ShowLyricsSkeleton();
  LyricsContent.classList.add("HiddenTransitioned");

  // Same-track re-open: reuse what's already parsed.
  const saved = $currentLyricsData.get();
  if (saved) {
    if (saved === `NO_LYRICS:${uri}`) return ["lyrics-not-found", 404];
    if (!saved.startsWith("NO_LYRICS:")) {
      try {
        const lyricsData = JSON.parse(saved);
        if (lyricsData?.uri === uri) {
          presentLyrics(lyricsData);
          return [lyricsData, 200];
        }
      } catch {
        // fall through to a fresh fetch
      }
    }
  }

  if (!navigator.onLine) return ["offline", 400];

  ShowLoaderContainer(uri);

  try {
    const response = await host.fetchLyrics(trackId);
    const lyrics = AdaptApiLyrics(response);

    if (!lyrics) {
      hideLoaderFor(uri);
      return ["lyrics-not-found", 404];
    }

    await ProcessLyrics(lyrics);

    if (IsEmptyLyrics(lyrics)) {
      lyricsLogger.warn("Lyrics payload had no renderable lines after pruning");
      hideLoaderFor(uri);
      return ["lyrics-not-found", 404];
    }

    lyrics.uri = uri;
    if (isStaleFetch(uri)) return [{ ...lyrics, fromCache: false }, 200];

    $currentLyricsData.set(JSON.stringify(lyrics));
    presentLyrics(lyrics);
    return [{ ...lyrics, fromCache: false }, 200];
  } catch (error: any) {
    const status: number | null = error?.status ?? null;
    const kind: string | undefined = error?.kind;

    if (status === 503) {
      if (isStaleFetch(uri)) return ["lyrics-queued", 503];
      LyricsQueueRetry.HandleQueued(uri);
      return ["lyrics-queued", 503];
    }

    hideLoaderFor(uri);
    lyricsLogger.warn("Lyrics request failed", error);

    if (kind === "rate_limited" || status === 429) return ["rate-limited", 429];
    if (status === 401) return ["lyrics-signin", 401];
    if (kind === "auth") return ["lyrics-not-configured", 0];
    if (kind === "network") return navigator.onLine ? ["service-unavailable", 0] : ["offline", 400];
    if (status !== null) return ["status-not-200", status];
    return ["unknown-error", 0];
  }
}

let ContainerShowLoaderTimeout: ReturnType<typeof setTimeout> | null = null;

/** Default copy shown in the loader while a lyrics request is queued (HTTP 503). */
export const LYRICS_QUEUE_MESSAGE =
  "Your request is in the queue — hang tight, your lyrics are on the way!";

function ShowLoaderContainer(uri: string): void {
  if (IsLyricsSkeletonEnabled()) return;
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  if (!loaderContainer) return;
  if (ContainerShowLoaderTimeout) clearTimeout(ContainerShowLoaderTimeout);
  ContainerShowLoaderTimeout = setTimeout(() => {
    ContainerShowLoaderTimeout = null;
    if (isStaleFetch(uri) || inFlightUri !== uri) return;
    loaderContainer.classList.add("active");
  }, 2000);
}

export function ShowQueueLoader(message: string = LYRICS_QUEUE_MESSAGE): void {
  if (IsLyricsSkeletonEnabled()) {
    ShowLyricsSkeleton(message);
    return;
  }
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  if (!loaderContainer) return;

  if (ContainerShowLoaderTimeout) {
    clearTimeout(ContainerShowLoaderTimeout);
    ContainerShowLoaderTimeout = null;
  }

  loaderContainer.classList.add("active", "queued");

  let messageEl = loaderContainer.querySelector<HTMLElement>(".loaderMessage");
  if (!messageEl) {
    messageEl = document.createElement("div");
    messageEl.className = "loaderMessage";
    loaderContainer.appendChild(messageEl);
  }
  messageEl.textContent = message;
}

export function HideLoaderContainer(): void {
  if (ContainerShowLoaderTimeout) {
    clearTimeout(ContainerShowLoaderTimeout);
    ContainerShowLoaderTimeout = null;
  }
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  if (loaderContainer) {
    loaderContainer.classList.remove("active", "queued");
    loaderContainer.querySelector(".loaderMessage")?.remove();
  }
}

onExperimentChange((experiment) => {
  if (experiment.id !== "lyricsSkeleton") return;
  const loaderContainer = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .loaderContainer");
  const skeleton = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .LyricsSkeleton");
  const queuedMessage = loaderContainer?.classList.contains("queued")
    ? loaderContainer.querySelector(".loaderMessage")?.textContent
    : skeleton?.classList.contains("active") && skeleton.classList.contains("LongLabel")
      ? skeleton.querySelector(".SkeletonLabel")?.textContent
      : null;
  if (!$currentlyFetching.get() && !queuedMessage) return;

  if (IsLyricsSkeletonEnabled()) {
    HideLoaderContainer();
    ShowLyricsSkeleton(queuedMessage ?? undefined);
  } else {
    HideLyricsSkeleton();
    if (queuedMessage) ShowQueueLoader(queuedMessage);
    else loaderContainer?.classList.add("active");
  }
});

export function ClearLyricsPageContainer(): void {
  const lyricsContent = PageContainer?.querySelector<HTMLElement>(".LyricsContainer .LyricsContent");
  if (lyricsContent) {
    lyricsContent.innerHTML = "";
  }
}
