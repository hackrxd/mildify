// Typed surface of src/spicy-lyrics/index.ts, as the app sees it through the
// `spicy-lyrics-renderer` alias. Keeps the non-strict vendored code out of the
// app's strict type-check.

declare module "spicy-lyrics-renderer" {
  export interface HostTrack {
    uri: string;
    id: string;
    name: string;
    album: string;
    artists: { name: string; uri: string }[];
    cover: string | null;
    durationMs: number;
    type: "track" | "episode" | "local" | "unknown";
  }

  export interface Host {
    position(): number;
    isPlaying(): boolean;
    track(): HostTrack | null;
    seek(ms: number): void;
    fetchLyrics(trackId: string): Promise<unknown | null>;
    openUrl(url: string): void;
  }

  export function setHost(impl: Host): void;
  /** With a `backdrop`, the cover background is painted there instead of behind the lyrics. */
  export function mount(host: HTMLElement, backdrop?: HTMLElement | null): Promise<void>;
  export function unmount(): Promise<void>;
  export function songChanged(): void;
  export function setNowBar(open: boolean): void;
  export function isNowBarOpen(): boolean;
  export function setFullscreen(open: boolean): void;
  export function setCompact(on: boolean): void;
  export function remeasure(): void;
  export function romanizationAvailable(): boolean;
  export function isRomanizedView(): boolean;
  export function toggleRomanization(): void;
  export function onLyricsApplied(cb: (type: string) => void): () => void;
}
