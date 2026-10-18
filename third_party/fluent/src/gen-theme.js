/**
 * Regenerates third_party/fluent/fluent-theme.css from @fluentui/tokens" webDarkTheme.
 *
 * Run inside the throwaway build dir (needs @fluentui/tokens installed):
 *   node src/gen-theme.js > D:/HermesWorkspace/dsh-to-go/third_party/fluent/fluent-theme.css
 *
 * Why generate instead of hand-writing: the dark theme has ~455 tokens, and
 * hand-copied values drift. This keeps the CSS byte-for-byte derived from the
 * same tokens package that ships with @fluentui/web-components.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Resolve @fluentui/tokens from wherever it happens to be installed: this file
 * may live in the repo (third_party/fluent/src) while node_modules lives in the
 * throwaway build dir, so try the script's own location first, then cwd.
 */
function loadTokens() {
  const bases = [import.meta.url, pathToFileURL(path.join(process.cwd(), 'noop.js')).href];
  let lastError;
  for (const base of bases) {
    try {
      const req = createRequire(base);
      return { tokens: req('@fluentui/tokens'), version: req('@fluentui/tokens/package.json').version };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Cannot resolve @fluentui/tokens; install it in the build dir first.\n${lastError?.message}`,
  );
}

const { tokens, version: pkgVersion } = loadTokens();

const dark = tokens.webDarkTheme;

const declarations = Object.entries(dark)
  .filter(([, value]) => typeof value === 'string')
  .map(([name, value]) => `  --${name}: ${value};`)
  .join('\n');

process.stdout.write(`/* Fluent 2 (Web) dark theme tokens for dsh-to-go.
 * Generated from @fluentui/tokens@${pkgVersion} webDarkTheme (the theme
 * package bundled with @fluentui/web-components@3.1.3). Do not hand-edit:
 * regenerate with src/gen-theme.js as described in README.md.
 *
 * Fluent Web Components read these custom properties from the host page; they
 * are NOT baked into fluent.min.js. Load this file BEFORE fluent.min.js.
 */

:root {
${declarations}
}

/* Base page surface so the dark theme reads correctly even before the app CSS
 * loads. Keep in sync with --colorNeutralForeground1 / --colorNeutralBackground1. */
html, body {
  background-color: var(--colorNeutralBackground1);
  color: var(--colorNeutralForeground1);
  font-family: var(--fontFamilyBase);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
  color-scheme: dark;
}
`);
