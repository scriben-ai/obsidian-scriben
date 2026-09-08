// Obsidian's automated review runs these rules and refuses the release on an
// error, which is how 0.1.2 failed and how 0.1.3 would have failed again on a
// rule I introduced while fixing the first three. Running them here turns a
// nine-hour round trip through the listing page into a twenty-second one.
//
// Only obsidianmd/* rules are allowed to fail the gate. Obsidian grades the
// typescript-eslint findings as warnings and never blocks on them; gating on
// those would mean the untyped .mjs helpers could never ship.
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

const asWarnings = {};
for (const c of obsidianmd.configs.recommended) {
  for (const rule of Object.keys(c.rules ?? {})) {
    // their config carries a typo'd rule name that only survives because it is
    // set to "off"; re-declaring it at any other severity fails config validation.
    const sev = c.rules[rule];
    const on = sev === 2 || sev === 'error' || (Array.isArray(sev) && (sev[0] === 2 || sev[0] === 'error'));
    if (on && !rule.startsWith('obsidianmd/')) asWarnings[rule] = 'warn';
  }
}

export default tseslint.config(
  { ignores: ['node_modules/**', 'main.js', 'test/**', '*.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: asWarnings,
  },
);
