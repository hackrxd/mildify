// Drives the Mildify frontend in headless Chromium against the fake Tauri backend in mock.js.
// Usage: node driver.mjs <outdir> [views] [themes] [setup] [lyrics]   (default: all four)
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

// Playwright isn't a project dependency; the container has it globally (override with PLAYWRIGHT_DIR).
const { chromium } = await import((process.env.PLAYWRIGHT_DIR ?? "/opt/node-tools/node_modules/playwright") + "/index.mjs");
const here = fileURLToPath(new URL(".", import.meta.url));
const out = process.argv[2] ?? "shots";
const what = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["views", "themes", "setup", "lyrics"]);
const URL_ = process.env.MILDIFY_URL ?? "http://localhost:1420";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
async function page({ signedOut = false } = {}) {
  const p = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  p.on("pageerror", (e) => console.log("PAGEERR", e.message));
  if (signedOut) await p.addInitScript(() => (window.__SIGNED_OUT = true));
  await p.addInitScript({ path: here + "mock.js" });
  return p;
}
const shot = async (p, name) => { await p.waitForTimeout(900); await p.screenshot({ path: `${out}/${name}.png` }); console.log("ok", name); };
const click = async (p, sel) => { try { await p.locator(sel).first().click({ timeout: 3000 }); } catch { console.log("FAIL click", sel); } };

if (what.has("views")) {
  const p = await page();
  await p.goto(URL_); await p.waitForTimeout(2000);
  await shot(p, "01-home");
  await p.mouse.move(800, 400); await p.mouse.wheel(0, 700); await shot(p, "02-home-scrolled");
  await click(p, "nav >> text=Search"); await p.keyboard.type("glass"); await p.keyboard.press("Enter"); await shot(p, "03-search");
  await click(p, "nav >> text=Liked songs"); await shot(p, "04-liked");
  await click(p, "nav >> text=Albums"); await shot(p, "05-albums");
  await click(p, "nav >> text=Artists"); await shot(p, "06-artists");
  await click(p, "text=Late Night Drive"); await shot(p, "07-playlist");
  await click(p, "text=Glass Hours"); await shot(p, "08-album");
  await click(p, "text=Luna Park"); await shot(p, "09-artist");
  await click(p, "[aria-label*=ueue i], [title*=ueue i]"); await shot(p, "10-queue");
  await click(p, "text=Settings"); await shot(p, "11-settings");
  await p.mouse.move(800, 400); await p.mouse.wheel(0, 900); await shot(p, "12-settings-more");
  await p.close();
}
if (what.has("themes")) {
  const p = await page();
  await p.goto(URL_); await p.waitForTimeout(1500);
  await click(p, "text=Settings"); await p.waitForTimeout(500);
  const sel = p.locator("select", { has: p.locator("option", { hasText: "Velvet" }) }).first();
  for (const t of ["Ember", "Frost", "Midnight", "Midnight (Dark)", "Moss", "Tide", "Velvet", "Verde", "Void"]) {
    await sel.selectOption({ label: t }); await p.waitForTimeout(700);
    await click(p, "nav >> text=Home"); await shot(p, "theme-" + t.toLowerCase().replace(/\W+/g, "_").replace(/_$/, ""));
    await click(p, "text=Settings"); await p.waitForTimeout(400);
  }
  await p.close();
}
if (what.has("setup")) {
  const p = await page({ signedOut: true });
  await p.goto(URL_); await p.waitForTimeout(1500); await shot(p, "13-setup"); await p.close();
}
if (what.has("lyrics")) {
  const p = await page();
  await p.goto(URL_ + "/lyrics-harness.html"); await p.waitForTimeout(4000); await shot(p, "14-lyrics-harness"); await p.close();
}
await browser.close();
