// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Mildify: romanization removed. Upstream detects the language
// and romanizes Japanese/Chinese/Korean/Cyrillic/Greek with packages it downloads
// and executes from a CDN at runtime, which this app doesn't allow. Empty-line
// pruning is kept, and transliterations the API ships still enable the toggle.

import { PageContainer } from "../../components/Pages/PageView.ts";
import { StripEmptyLyricsLines } from "./EmptyLines.ts";

export const ProcessLyrics = async (lyrics: any) => {
  StripEmptyLyricsLines(lyrics);

  lyrics.HasTransliterations = lyrics.HasTransliterations === true;

  if (lyrics.HasTransliterations) {
    PageContainer?.classList.add("Lyrics_RomanizationAvailable");
  } else {
    PageContainer?.classList.remove("Lyrics_RomanizationAvailable");
  }
};
