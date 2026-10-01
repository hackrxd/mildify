// Dev-only harness: mounts the Spicy Lyrics renderer in a plain browser tab with a
// fake host (simulated clock, sample sync), so the port can be checked without Tauri.
// Served by Vite at /lyrics-harness.html; not part of the app bundle.

import * as renderer from "spicy-lyrics-renderer";

type Syl = { Text: string; StartTime: number; EndTime: number; IsPartOfWord: boolean };

/** Builds a syllable-synced line: words split on spaces, "-" marks a syllable break. */
function line(start: number, text: string, perSyllable = 0.32, opposite = false) {
  const syllables: Syl[] = [];
  let t = start;
  for (const word of text.split(" ")) {
    const parts = word.split("-");
    parts.forEach((p, i) => {
      syllables.push({ Text: p, StartTime: t, EndTime: t + perSyllable, IsPartOfWord: i < parts.length - 1 });
      t += perSyllable;
    });
  }
  return {
    Type: "Vocal",
    OppositeAligned: opposite,
    Lead: { StartTime: start, EndTime: t, Syllables: syllables },
  };
}

// Original placeholder text (not real lyrics).
const content = [
  line(2, "Paper la-n-terns drift a-cross the har-bor"),
  line(6, "Count-ing ev-ery light we left be-hind"),
  line(10, "Hum the a-nswer when the en-gine's qui-et", 0.3, true),
  line(14, "Read the weath-er in the win-dow glass"),
  line(18, "Some-where east the morn-ing finds the sig-nal"),
  line(22, "And the sta-tic turns to some-thing kind"),
  line(26, "Fold the map and let the ri-ver steer us"),
  line(30, "Lean-ing in-to ev-ery bend that comes", 0.3, true),
  line(34, "Paper la-n-terns drift a-cross the har-bor"),
  line(38, "Count-ing ev-ery light we left be-hind"),
];

const sample = {
  Body: {
    Type: "Syllable",
    StartTime: 2,
    EndTime: 42,
    SongWriters: ["Sample Writer"],
    Content: content,
    id: "0000000000000000000000",
    source: "spicy_lyrics",
    UploadAttribution: {
      Maker: { id: "1", username: "sample-maker", avatar: "", hasProfileBanner: false, url: "https://example.com/maker" },
      Uploader: { id: "2", username: "sample-uploader", avatar: "", hasProfileBanner: false, url: "https://example.com/uploader" },
    },
  },
  Status: 200,
  Type: "object",
};

let base = performance.now();
let offset = 0;
let playing = true;
const position = () => (playing ? offset + (performance.now() - base) : offset) % 44000;

renderer.setHost({
  position,
  isPlaying: () => playing,
  track: () => ({
    uri: "spotify:track:0000000000000000000000",
    id: "0000000000000000000000",
    name: "Harbor Lights (sample)",
    album: "Harness",
    artists: [{ name: "Sample Artist", uri: "spotify:artist:0000000000000000000000" }],
    // Same-origin image so the dynamic background can fetch it without CORS.
    cover: "/src-tauri/icons/icon.png",
    durationMs: 44000,
    type: "track",
  }),
  seek: (ms) => {
    offset = ms;
    base = performance.now();
  },
  fetchLyrics: async () => sample,
  openUrl: (url) => console.log("open", url),
});

const host = document.getElementById("stage")!;
renderer.mount(host);

document.getElementById("toggle")!.addEventListener("click", () => {
  offset = position();
  base = performance.now();
  playing = !playing;
});
document.getElementById("nowbar")!.addEventListener("click", () => renderer.setNowBar(!renderer.isNowBarOpen()));
