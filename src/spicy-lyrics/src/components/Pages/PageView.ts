// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Native Spotify: rewritten. Builds the same #SpicyLyricsPage DOM and
// class contract as upstream, but mounts it into a host element supplied by the app
// instead of Spotify's main view, and drops the Spotify-specific chrome (route
// handling, card/PiP modes, Tippy view controls). View controls are rendered by the
// host; the NowBar keeps upstream's markup with a simplified updater.

// Imported first so the binding exists before the import cycle below evaluates.
import { PageContainer, SetPageContainer } from "./PageState.ts";
import fetchLyrics from "../../utils/Lyrics/fetchLyrics.ts";
import { SkeletonMarkup } from "../../utils/Lyrics/LyricsSkeleton.ts";
import "../../css/Loaders/DotLoader.css";
import { DestroyAllLyricsContainers } from "../../utils/Lyrics/Applyer/CreateLyricsContainer.ts";
import ApplyLyrics, { cleanupApplyLyricsAbortController } from "../../utils/Lyrics/Global/Applyer.ts";
import { addLinesEvListener, removeLinesEvListener } from "../../utils/Lyrics/lyrics.ts";
import {
  CleanupScrollEvents,
  InitializeScrollEvents,
  ResetLastLine,
} from "../../utils/Scrolling/ScrollToActiveLine.ts";
import { ClearScrollSimplebar, ScrollSimplebar } from "../../utils/Scrolling/Simplebar/ScrollSimplebar.ts";
import ApplyDynamicBackground, { KawarpMap } from "../DynamicBG/dynamicBackground.ts";
import {
  $lineHoverBackground,
  $lyricsContainerExists,
  $minimalLyricsMode,
  $simpleLyricsMode,
  $skipSpicyFont,
} from "../../utils/stores.ts";
import { $isNowBarOpen, $nowBarSide } from "../../utils/uiState.ts";
import Global from "../Global/Global.ts";
import { SpotifyPlayer } from "../Global/SpotifyPlayer.ts";
import { CleanUpIsByCommunity } from "../../utils/Lyrics/Applyer/Credits/ApplyIsByCommunity.tsx";
import Logger from "../../utils/Logger.ts";
import { ApplyExperimentClasses } from "../../utils/experiments.ts";
import { triggerRemeasureLV } from "../../utils/Lyrics/LyricsVirtualizer.ts";

const pageLogger = new Logger("Page View");

export const Tooltips: Record<string, { destroy: () => void } | null> = {};

export { PageContainer };
export const IsCardMode = false;
export let LyricsApplied = false;

let PageHost: HTMLElement | null = null;

export const GetPageRoot = () => PageHost;

const PageView = {
  Open: OpenPage,
  Destroy: DestroyPage,
  /** Upstream renders its view controls here; Native Spotify renders them in Svelte. */
  AppendViewControls: (_reAppend: boolean = false) => {},
  IsOpened: false,
  IsTippyCapable: false,
};

async function OpenPage(AppendTo: HTMLElement | undefined = undefined) {
  if (PageView.IsOpened) return;
  if (!AppendTo) {
    pageLogger.error("OpenPage needs a host element in Native Spotify");
    return;
  }
  PageHost = AppendTo;

  const elem = document.createElement("div");
  elem.id = "SpicyLyricsPage";
  elem.classList.add("SpicyRenderer", "ViewControlsPosition_Top");
  elem.innerHTML = `
        <div class="ContentBox">
            <div class="NowBar">
                <div class="CenteredView">
                    <div class="Header">
                        <div class="MediaBox">
                            <div class="MediaContent"></div>
                            <div class="MediaImageContainer">
                              <div class="fi_FromImage ib_ImageBox"></div>
                              <div class="ti_ToImage ib_ImageBox"></div>
                            </div>
                        </div>
                        <div class="Metadata">
                            <div class="SongName">
                                <span></span>
                            </div>
                            <div class="Artists">
                                <span></span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="LyricsContainer">
                <div class="loaderContainer">
                    <div id="DotLoader"></div>
                </div>
                ${SkeletonMarkup}
                <div class="LyricsContent ScrollbarScrollable"></div>
            </div>
            <div class="ViewControls"></div>
        </div>
    `;

  SetPageContainer(elem);

  if (!$skipSpicyFont.get()) elem.classList.add("UseSpicyFont");
  if ($simpleLyricsMode.get()) elem.classList.add("SimpleLyricsMode");
  if ($minimalLyricsMode.get()) elem.classList.add("MinimalLyricsMode");
  if (!$lineHoverBackground.get()) elem.classList.add("NoLineHoverBackground");

  ApplyExperimentClasses(elem);

  const contentBox = elem.querySelector<HTMLElement>(".ContentBox");
  if (contentBox) {
    try {
      ApplyDynamicBackground(contentBox, "lpagebg");
    } catch (err) {
      pageLogger.error("Error applying dynamic background", err);
    }
  }

  AppendTo.appendChild(elem);
  addLinesEvListener();

  $lyricsContainerExists.set(true);
  PageView.IsOpened = true;

  SetNowBarOpen($isNowBarOpen.get());
  UpdateNowBar();

  const currentUri = SpotifyPlayer.GetUri();
  if (currentUri) fetchLyrics(currentUri).then(ApplyLyrics);

  Global.Event.evoke("page:open", { cardMode: false });
}

async function DestroyPage() {
  if (!PageView.IsOpened) return;
  PageView.IsOpened = false;

  cleanupApplyLyricsAbortController();

  KawarpMap.get("lpagebg")?.dispose();
  KawarpMap.delete("lpagebg");
  ResetLastLine();
  CleanupScrollEvents();
  $lyricsContainerExists.set(false);
  DestroyAllLyricsContainers();
  CleanUpIsByCommunity();

  PageContainer?.remove();
  removeLinesEvListener();
  ClearScrollSimplebar();
  Global.Event.evoke("page:destroy", null);
  SetPageContainer(null);
  PageHost = null;
}

/** Called by the host on track change: refresh the NowBar, background and lyrics. */
export function OnSongChange() {
  if (!PageContainer) return;
  UpdateNowBar();
  const contentBox = PageContainer.querySelector<HTMLElement>(".ContentBox");
  if (contentBox) void ApplyDynamicBackground(contentBox, "lpagebg");
  const uri = SpotifyPlayer.GetUri();
  if (uri) fetchLyrics(uri).then(ApplyLyrics);
}

export function SetNowBarOpen(open: boolean) {
  $isNowBarOpen.set(open);
  const nowBar = PageContainer?.querySelector<HTMLElement>(".ContentBox .NowBar");
  if (!PageContainer || !nowBar) return;
  nowBar.classList.toggle("Active", open);
  PageContainer.classList.toggle("NowBarStatus__Open", open);
  PageContainer.classList.toggle("NowBarStatus__Closed", !open);
  const right = $nowBarSide.get() === "right";
  nowBar.classList.toggle("RightSide", right);
  nowBar.classList.toggle("LeftSide", !right);
  PageContainer.classList.toggle("NowBarSide__Right", right);
  PageContainer.classList.toggle("NowBarSide__Left", !right);
  if (open) UpdateNowBar();
  setTimeout(() => triggerRemeasureLV(), 450);
}

/** Simplified upstream UpdateNowBar: cover art, title and artists. */
export function UpdateNowBar() {
  const nowBar = PageContainer?.querySelector<HTMLElement>(".ContentBox .NowBar");
  if (!nowBar) return;
  const cover = SpotifyPlayer.GetCover("xlarge") ?? "";
  const url = cover.startsWith("spotify:image:")
    ? `https://i.scdn.co/image/${cover.slice("spotify:image:".length)}`
    : cover;
  const fromImage = nowBar.querySelector<HTMLElement>(".MediaImageContainer .fi_FromImage");
  if (fromImage && url) {
    fromImage.style.backgroundImage = `url("${url}")`;
    fromImage.classList.add("containsImage");
  }
  const name = nowBar.querySelector<HTMLElement>(".Metadata .SongName span");
  if (name) name.textContent = SpotifyPlayer.GetName() ?? "";
  const artists = nowBar.querySelector<HTMLElement>(".Metadata .Artists span");
  if (artists) artists.textContent = (SpotifyPlayer.GetArtists() ?? []).map((a) => a.name).join(", ");
}

export const isSizeReadyToBeCompacted = () => window.matchMedia("(max-width: 70.812rem)").matches;
export function Compactify(_element?: HTMLElement) {}

// Same apply/not-apply wiring as upstream.
Global.Event.listen("lyrics:not-apply", () => {
  CleanupScrollEvents();
  LyricsApplied = false;
  CleanUpIsByCommunity();
});

Global.Event.listen("lyrics:apply", ({ Type }: { Type: string }) => {
  CleanupScrollEvents();

  if (!Type || Type === "Static") return;
  if (ScrollSimplebar) {
    InitializeScrollEvents(ScrollSimplebar);
    LyricsApplied = true;
  }

  setTimeout(() => triggerRemeasureLV(), 1000);
  setTimeout(() => triggerRemeasureLV(), 1500);
});

export default PageView;
