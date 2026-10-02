//! WebKitGTK workarounds that have to be in the environment before GTK starts.

use std::env;
use std::ffi::OsStr;
use std::path::Path;

/// Re-enables hardware-accelerated rendering on NVIDIA's proprietary driver under Wayland.
///
/// Debian and Ubuntu patch WebKitGTK (`disable-nvidia-dmabuf.patch`) to fall back to software
/// rendering whenever the GL vendor is NVIDIA. The AppImage bundles that build, and the lyrics
/// view (an animated background under blurred, masked text) drops to ~20 fps when every frame is
/// painted on the CPU. `WEBKIT_FORCE_DMABUF_RENDERER` skips the check. On its own it trips a
/// Wayland protocol error in NVIDIA's EGL explicit sync ("no acquire point is set"), so explicit
/// sync is turned off too. Under X11 the forced renderer draws nothing, so it's Wayland only.
///
/// Variables the user has set themselves are left alone.
pub fn configure() {
    if !Path::new("/sys/module/nvidia").exists() || !uses_wayland() {
        return;
    }
    for (key, value) in [("WEBKIT_FORCE_DMABUF_RENDERER", "1"), ("__NV_DISABLE_EXPLICIT_SYNC", "1")] {
        if env::var_os(key).is_none() {
            env::set_var(key, value);
        }
    }
    log::info!("NVIDIA driver on Wayland: forcing the WebKitGTK DMA-BUF renderer");
}

/// Whether GDK will pick its Wayland backend (it tries Wayland first unless `GDK_BACKEND` says otherwise).
fn uses_wayland() -> bool {
    picks_wayland(
        env::var_os("WAYLAND_DISPLAY").as_deref(),
        &env::var("GDK_BACKEND").unwrap_or_default(),
    )
}

fn picks_wayland(wayland_display: Option<&OsStr>, gdk_backend: &str) -> bool {
    if wayland_display.is_none_or(|d| d.is_empty()) {
        return false;
    }
    matches!(gdk_backend.split(',').next().map(str::trim), None | Some("" | "*" | "wayland"))
}
