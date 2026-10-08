//! Everything the DJ downloads, pinned: the two runtimes for this platform, the language models and the
//! voices. Nothing here ships with the app; `install.rs` fetches only what the chosen model and voice need,
//! and only once the DJ is turned on.

/// How a download is packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pack {
    /// Used as downloaded, under the component's folder.
    File,
    TarGz,
    TarBz2,
    Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Component {
    /// Also the name of its folder in the DJ folder; a new version gets a new id.
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    /// SHA-256 of the download. Model weights come from a fixed Hugging Face commit, so theirs never changes either.
    pub sha256: &'static str,
    /// Size in bytes, for the UI before the download says.
    pub bytes: u64,
    pub pack: Pack,
}

/// The two programs everything runs on, built for one platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Runtime {
    /// llama.cpp's `llama-server`: runs the language model on this computer.
    pub llm: Component,
    /// sherpa-onnx's offline text-to-speech program.
    pub tts: Component,
}

pub const LLAMA_SERVER: &str = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
pub const TTS_PROGRAM: &str = if cfg!(windows) { "sherpa-onnx-offline-tts.exe" } else { "sherpa-onnx-offline-tts" };

/// The runtimes for an OS and CPU, as `std::env::consts` names them; `None` where there are no prebuilt ones.
pub fn runtime(os: &str, arch: &str) -> Option<Runtime> {
    let llm = |file: &'static str, sha256, bytes, pack| Component {
        id: "llama-b11382",
        label: "Language model runtime (llama.cpp)",
        url: file,
        sha256,
        bytes,
        pack,
    };
    let tts = |file: &'static str, sha256, bytes| Component {
        id: "sherpa-onnx-v1.13.8",
        label: "Speech runtime (sherpa-onnx)",
        url: file,
        sha256,
        bytes,
        pack: Pack::TarBz2,
    };
    // URLs are spelled out whole, so each can be checked by eye; the tests hold them to one release each.
    Some(match (os, arch) {
        ("linux", "x86_64") => Runtime {
            llm: llm(
                "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-ubuntu-x64.tar.gz",
                "34407d59947ed4ab35fe4ab2db5f61bb4d5aedfe25e6a72f702f3ae9758a396d",
                17_669_957,
                Pack::TarGz,
            ),
            tts: tts(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2",
                "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4",
                28_156_791,
            ),
        },
        ("linux", "aarch64") => Runtime {
            llm: llm(
                "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-ubuntu-arm64.tar.gz",
                "f4ac1827e58e3df1c7f4657acc03352be4f8ad85b8abddc23741cd7bb3730cee",
                13_703_641,
                Pack::TarGz,
            ),
            tts: tts(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2",
                "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789",
                28_091_778,
            ),
        },
        ("macos", "aarch64") => Runtime {
            llm: llm(
                "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-macos-arm64.tar.gz",
                "c2540b6515cf508c270815b494ff3f228818165fe7dcdac73f643e4f10bde2e6",
                11_925_743,
                Pack::TarGz,
            ),
            tts: tts(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2",
                "b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56",
                20_314_448,
            ),
        },
        // sherpa-onnx builds Intel Macs only into its universal download.
        ("macos", "x86_64") => Runtime {
            llm: llm(
                "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-macos-x64.tar.gz",
                "37355fefe4fd208172746872e173f10e19d945ac35da01a209d9518e6ba39c13",
                11_477_182,
                Pack::TarGz,
            ),
            tts: tts(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-universal2-shared.tar.bz2",
                "2249f97f10df7d828af1b0d10e3d1eeaa2198b60b9a999a7ed853c150181ccfd",
                43_567_145,
            ),
        },
        ("windows", "x86_64") => Runtime {
            llm: llm(
                "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-win-cpu-x64.zip",
                "40d55282382909be50d27a3e182885860c28ff148e4d952beca7aaad91504051",
                19_366_882,
                Pack::Zip,
            ),
            tts: tts(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2",
                "6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df",
                24_805_859,
            ),
        },
        ("windows", "aarch64") => Runtime {
            llm: llm(
                "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-win-cpu-arm64.zip",
                "d599c476541d9ac4c929483e6150b6a906d0c6bd21ac739eb30d6cb6d4faaded",
                12_219_255,
                Pack::Zip,
            ),
            tts: tts(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-arm64-shared-MT-Release.tar.bz2",
                "455ea18dc44aea188b4f7976037dea3d77e3f8d7afe0760f34244a7a0db53c4c",
                23_341_583,
            ),
        },
        _ => return None,
    })
}

/// The runtimes for the computer this is running on.
pub fn this_runtime() -> Option<Runtime> {
    runtime(std::env::consts::OS, std::env::consts::ARCH)
}

/// A language model the DJ can download and run itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    /// It calls tools well enough to look songs up before picking.
    pub tools: bool,
    pub component: Component,
}

/// The id of the setting that uses the user's own model server instead of a download.
pub const OWN_SERVER: &str = "own";

pub const MODELS: &[Model] = &[
    Model {
        id: "qwen2.5-1.5b",
        label: "Qwen2.5 1.5B",
        detail: "Quick on any computer. About 2 GB of memory while the DJ is on.",
        tools: false,
        component: Component {
            id: "model-qwen2.5-1.5b-q4km",
            label: "Language model (Qwen2.5 1.5B Instruct)",
            url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/62a8d092b0a1047016f3edbd0fde387598727aa5/qwen2.5-1.5b-instruct-q4_k_m.gguf",
            sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
            bytes: 1_117_320_736,
            pack: Pack::File,
        },
    },
    Model {
        id: "qwen3-4b",
        label: "Qwen3 4B",
        detail: "Better writing, slower without a graphics card. About 4 GB of memory while the DJ is on.",
        tools: true,
        component: Component {
            id: "model-qwen3-4b-q4km",
            label: "Language model (Qwen3 4B)",
            url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
            sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
            bytes: 2_497_280_256,
            pack: Pack::File,
        },
    },
];

pub const DEFAULT_MODEL: &str = "qwen2.5-1.5b";

pub fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

/// How a voice package is laid out, and which of the TTS program's options load it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceKind {
    Kokoro,
    Kitten,
}

impl VoiceKind {
    /// The model file, which marks the package's folder inside the download.
    pub fn model_file(self) -> &'static str {
        match self {
            VoiceKind::Kokoro => "model.int8.onnx",
            VoiceKind::Kitten => "model.fp16.onnx",
        }
    }

    /// The TTS program's option prefix for this kind (`--kokoro-model`, …).
    pub fn option(self) -> &'static str {
        match self {
            VoiceKind::Kokoro => "kokoro",
            VoiceKind::Kitten => "kitten",
        }
    }
}

const KOKORO: Component = Component {
    id: "voice-kokoro-int8-en-v0_19",
    label: "Voices (Kokoro)",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2",
    sha256: "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd",
    bytes: 103_248_205,
    pack: Pack::TarBz2,
};

const KITTEN: Component = Component {
    id: "voice-kitten-nano-en-v0_2",
    label: "Voices (KittenTTS nano)",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_2-fp16.tar.bz2",
    sha256: "0345a8a2f4a710cb8f7912c9a731ded8b3e1e69b33a871efa95c2e64651518fe",
    bytes: 26_586_708,
    pack: Pack::TarBz2,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Voice {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: VoiceKind,
    /// Speaker number inside the package.
    pub sid: u32,
    pub component: Component,
}

/// Kokoro's English package numbers its speakers af, af_bella, af_nicole, af_sarah, af_sky, am_adam,
/// am_michael, bf_emma, bf_isabella, bm_george, bm_lewis (0–10); Kitten nano v0.2 alternates m/f voices.
pub const VOICES: &[Voice] = &[
    Voice { id: "michael", label: "Michael (American)", kind: VoiceKind::Kokoro, sid: 6, component: KOKORO },
    Voice { id: "adam", label: "Adam (American)", kind: VoiceKind::Kokoro, sid: 5, component: KOKORO },
    Voice { id: "bella", label: "Bella (American)", kind: VoiceKind::Kokoro, sid: 1, component: KOKORO },
    Voice { id: "sarah", label: "Sarah (American)", kind: VoiceKind::Kokoro, sid: 3, component: KOKORO },
    Voice { id: "george", label: "George (British)", kind: VoiceKind::Kokoro, sid: 9, component: KOKORO },
    Voice { id: "emma", label: "Emma (British)", kind: VoiceKind::Kokoro, sid: 7, component: KOKORO },
    Voice { id: "light-male", label: "Light (male, faster)", kind: VoiceKind::Kitten, sid: 2, component: KITTEN },
    Voice { id: "light-female", label: "Light (female, faster)", kind: VoiceKind::Kitten, sid: 1, component: KITTEN },
];

pub const DEFAULT_VOICE: &str = "michael";

pub fn voice(id: &str) -> Option<&'static Voice> {
    VOICES.iter().find(|v| v.id == id)
}

/// Every component id this build knows, on any platform, so stale folders can be told apart.
pub fn known_ids() -> Vec<&'static str> {
    let mut ids = vec!["llama-b11382", "sherpa-onnx-v1.13.8"];
    ids.extend(MODELS.iter().map(|m| m.component.id));
    ids.extend(VOICES.iter().map(|v| v.component.id));
    ids.sort_unstable();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    const LLAMA: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b11382/llama-b11382-bin-";
    const SHERPA: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-";

    const PLATFORMS: &[(&str, &str)] = &[
        ("linux", "x86_64"),
        ("linux", "aarch64"),
        ("macos", "aarch64"),
        ("macos", "x86_64"),
        ("windows", "x86_64"),
        ("windows", "aarch64"),
    ];

    fn all_components() -> Vec<Component> {
        let mut all: Vec<Component> = PLATFORMS
            .iter()
            .flat_map(|(os, arch)| {
                let r = runtime(os, arch).unwrap();
                [r.llm, r.tts]
            })
            .collect();
        all.extend(MODELS.iter().map(|m| m.component));
        all.extend(VOICES.iter().map(|v| v.component));
        all
    }

    #[test]
    fn every_desktop_platform_the_app_ships_for_has_runtimes() {
        for (os, arch) in PLATFORMS {
            let r = runtime(os, arch).unwrap_or_else(|| panic!("{os} {arch}"));
            assert!(r.llm.url.starts_with(LLAMA), "{}", r.llm.url);
            assert!(r.tts.url.starts_with(SHERPA), "{}", r.tts.url);
            assert_eq!(r.llm.pack, if *os == "windows" { Pack::Zip } else { Pack::TarGz });
        }
        assert_eq!(runtime("linux", "riscv64"), None);
        assert_eq!(runtime("freebsd", "x86_64"), None);
    }

    #[test]
    fn every_download_is_pinned_by_hash() {
        for c in all_components() {
            assert!(c.url.starts_with("https://"), "{}", c.url);
            let h = c.sha256;
            assert!(h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{h}");
            assert!(c.bytes > 1_000_000);
        }
    }

    #[test]
    fn model_weights_come_from_a_fixed_commit() {
        for m in MODELS {
            let url = m.component.url;
            let revision = url.split("/resolve/").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or_default();
            assert!(revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()), "{url}");
        }
    }

    #[test]
    fn ids_are_safe_folder_names() {
        for c in all_components() {
            assert!(!c.id.is_empty());
            assert!(c.id.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch)), "{}", c.id);
            assert!(!c.id.starts_with('.'));
            assert!(known_ids().contains(&c.id), "{}", c.id);
        }
    }

    #[test]
    fn defaults_exist_and_choices_are_unique() {
        assert!(model(DEFAULT_MODEL).is_some());
        assert!(voice(DEFAULT_VOICE).is_some());
        assert!(model(OWN_SERVER).is_none(), "the own-server setting isn't a download");
        let mut ids: Vec<_> = VOICES.iter().map(|v| v.id).chain(MODELS.iter().map(|m| m.id)).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn a_package_shared_by_several_voices_is_one_component() {
        let kokoro: Vec<_> = VOICES.iter().filter(|v| v.kind == VoiceKind::Kokoro).collect();
        assert!(kokoro.len() > 1);
        assert!(kokoro.iter().all(|v| v.component == KOKORO));
        assert_eq!(known_ids().iter().filter(|id| **id == KOKORO.id).count(), 1);
    }
}
