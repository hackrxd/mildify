// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Native Spotify: rewritten as a stub. Upstream reads Spotify's private
// audio-analysis endpoint to pulse the background with the beat; it isn't reachable
// from a Web API client, so the background animates without it.

import type { AudioAnalysisData } from "../components/DynamicBG/BackgroundAnimationController.ts";

export async function getDynamicAudioAnalysis(_uri: string): Promise<AudioAnalysisData | null> {
  return null;
}
