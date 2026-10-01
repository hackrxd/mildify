# librespot-core (patched)

A copy of `core/` from librespot at rev `939dc5ee9d833e1980f9495241219d9d4868a061`,
wired in through `[patch]` in `src-tauri/Cargo.toml`. Changes from upstream:

- `Cargo.toml`: workspace-inherited fields are written out, and the sibling
  `librespot-oauth` / `librespot-protocol` path dependencies point at the same git rev.
- `src/session.rs`: `check_catalogue` no longer calls `exit(1)` on non-premium
  accounts. Upstream does this mid-session, which closed the app with no explanation.
  The app reads the stored `type` attribute instead and shows that Premium is required.

When bumping librespot, re-copy `core/` from the new rev and reapply these changes.
