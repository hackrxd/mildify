// Native Spotify addition (not in upstream Spicy Lyrics).
// Holds the page element in a module with no imports. Upstream declares it in
// PageView.ts, which sits in an import cycle with modules that read it while the
// cycle is still evaluating; esbuild's top-level let→var rewrite hides that
// upstream, but native ES modules (Vite) throw a TDZ error. PageView re-exports
// this binding, so every `import { PageContainer } from "PageView.ts"` still works.

export let PageContainer: HTMLElement | null = null;

export function SetPageContainer(el: HTMLElement | null) {
  PageContainer = el;
}
