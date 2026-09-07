/**
 * Obsidian loads ONE commonjs file. `obsidian` and the electron/codemirror
 * modules are provided by the app at runtime and must stay external — bundling
 * them produces a plugin that loads a second copy of the editor and breaks the
 * host's own state.
 */
import esbuild from 'esbuild';

const production = process.argv.includes('production');
const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  // Obsidian requires readable source in the released bundle; minify-only
  // submissions are rejected at review.
  minify: false,
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  logLevel: 'info',
});
if (production) { await ctx.rebuild(); await ctx.dispose(); }
else { await ctx.watch(); }
