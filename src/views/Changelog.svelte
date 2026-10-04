<script lang="ts">
  import { inlineCode } from "../lib/changelog";
  import { whatsNew } from "../lib/whatsnew.svelte";

  whatsNew.dismiss();

  function formatDate(date: string | null): string {
    if (!date) return "";
    const d = new Date(`${date}T12:00:00`);
    return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { dateStyle: "long" });
  }
</script>

<div class="page">
  <h1>What's new</h1>

  {#each whatsNew.releases as release (release.version)}
    <section class:new={whatsNew.isNew(release)}>
      <header>
        <h2>{release.version === "Unreleased" ? "Unreleased" : `Mildify ${release.version}`}</h2>
        {#if whatsNew.isNew(release)}<span class="tag">New</span>{/if}
        {#if release.version === whatsNew.current}<span class="tag quiet">This version</span>{/if}
        <span class="muted small date">{formatDate(release.date)}</span>
      </header>
      {#each release.groups as group (group.title)}
        <h3>{group.title}</h3>
        <ul>
          {#each group.items as item, i (i)}
            <li>
              {#each inlineCode(item) as part, j (j)}{#if part.code}<code>{part.text}</code>{:else}{part.text}{/if}{/each}
            </li>
          {/each}
        </ul>
      {/each}
    </section>
  {:else}
    <p class="muted">No release notes in this build.</p>
  {/each}
</div>

<style>
  .page {
    display: grid;
    gap: 28px;
    max-width: 780px;
    padding: 20px var(--gutter) 48px;
  }
  h1 {
    font-family: var(--font-display);
    font-variation-settings: "wdth" 125;
    font-weight: 800;
    font-size: clamp(2.5rem, 4.6vw, 4rem);
    letter-spacing: -0.03em;
    line-height: 1;
  }
  section {
    display: grid;
    gap: 6px;
    padding: 18px 20px;
    border-radius: var(--panel-radius);
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  section.new {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brass) 55%, var(--line));
  }
  header {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 4px;
  }
  h2 {
    font-size: var(--t-xl);
  }
  .date {
    margin-left: auto;
  }
  .small {
    font-size: var(--t-sm);
  }
  .tag {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--brass);
    color: var(--brass-ink);
    font-size: var(--t-xs);
    font-weight: 600;
  }
  .tag.quiet {
    background: none;
    color: var(--smoke);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  h3 {
    margin-top: 6px;
    color: var(--smoke);
    font-size: var(--t-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  ul {
    display: grid;
    gap: 6px;
    padding-left: 18px;
    font-size: var(--t-md);
    line-height: 1.5;
  }
  code {
    padding: 1px 5px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--paper) 8%, transparent);
    font-size: 0.92em;
  }
</style>
