// Themes that ship with the app. Each is a stylesheet next to this file, linked the same way as a
// theme from the user's folder, so it overrides the same variables (docs/mods.md).

const urls = import.meta.glob<string>("./*.css", { query: "?url", import: "default", eager: true });

export interface BuiltinTheme {
  /** `builtin:<file>`, so it can't clash with a file or folder name in the themes folder. */
  id: string;
  name: string;
  description: string;
  author: string;
  href: string;
}

function theme(file: string, name: string, description: string): BuiltinTheme {
  return { id: `builtin:${file}`, name, description, author: "Mildify", href: urls[`./${file}.css`] };
}

export const builtinThemes: BuiltinTheme[] = [
  theme("ember", "Ember", "Warm charcoal and a glowing coral accent."),
  theme("frost", "Frost", "Cool slate greys and an icy blue accent."),
  theme("midnight", "Midnight", "Blue-black panels lit by a soft moonlit indigo."),
  theme("midnight_dark", "Midnight (Dark)", "Blue-black panels lit by a soft moonlit indigo."),
  theme("moss", "Moss", "Forest greens with a fresh sage accent."),
  theme("tide", "Tide", "Deep navy panels under a cool cyan accent."),
  theme("velvet", "Velvet", "Dusky plum with a neon pink accent."),
  theme("verde", "Verde", "Near-black panels and a bright green accent."),
  theme("void", "Void", "True black for OLED screens, with plain white for the accent."),
];
