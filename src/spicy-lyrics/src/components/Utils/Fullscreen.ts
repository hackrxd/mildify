// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Mildify: rewritten as state only. Mildify hosts the
// lyrics page in its own view and toggles "full screen" itself, so the renderer
// only needs to read these flags.

const Fullscreen = {
  IsOpen: false,
  CinemaViewOpen: false,
  CloseImmediately: () => {},
};

export const IsFullscreenClosing = () => false;

/** Called by the host view when it enters/leaves its full-window lyrics mode. */
export function SetFullscreenState(open: boolean) {
  Fullscreen.IsOpen = open;
}

export default Fullscreen;
