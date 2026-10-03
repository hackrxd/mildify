// Spicy Lyrics (https://github.com/Spikerko/spicy-lyrics), AGPL-3.0.
// Modified for Mildify: rewritten. Compact mode pins the active line to the
// top instead of centring it; the host view enables it when the lyrics panel is narrow.

let compact = false;

export const IsCompactMode = () => compact;

export function EnableCompactMode() {
  compact = true;
}

export function DisableCompactMode() {
  compact = false;
}
