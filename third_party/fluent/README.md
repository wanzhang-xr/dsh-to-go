# third_party/fluent

Offline, single-file browser build of **Fluent UI Web Components v3** plus a Fluent 2
**dark theme** stylesheet. No CDN, no network, no ESM loader — just two `<link>`/`<script>`
tags, so `ui/app.html` stays a self-contained file that works with `file://`.

```
<link rel="stylesheet" href="third_party/fluent/fluent-theme.css">
<script src="third_party/fluent/fluent.min.js"></script>
```

Order matters: the theme CSS defines the `--color*` custom properties that the components'
shadow DOM styles read. Load `fluent-theme.css` first (or at least before first paint) and
`fluent.min.js` after.

## What it contains

- `fluent.min.js` — IIFE bundle (~194 KB minified) registering 22 `<fluent-*>` custom
  elements, tree-shaken to only the components the config UI uses:
  accordion, accordion-item, badge, button, checkbox, dialog, dialog-body, divider,
  dropdown, field, label, message-bar, option, progress-bar, spinner, switch, tab,
  tablist, text-input, textarea, toggle-button, tooltip.
- `fluent-theme.css` — all 455 `webDarkTheme` tokens from `@fluentui/tokens` as
  `:root { --token: value }`, plus a minimal `html, body` base surface and
  `color-scheme: dark`.
- `src/entry.js` — the exact entry file used for the bundle (single source of truth for
  which components are registered).
- `src/gen-theme.js` — regenerates `fluent-theme.css` from `@fluentui/tokens`.
- `VERSION.txt` — pinned versions, build date, exact commands.

## Using it from app.html

```html
<fluent-button appearance="primary">Save</fluent-button>
<fluent-text-input type="password" placeholder="token"></fluent-text-input>
<fluent-switch>Auto start</fluent-switch>
<fluent-tablist>
  <fluent-tab>General</fluent-tab>
  <fluent-tab>Advanced</fluent-tab>
</fluent-tablist>
```

Readiness probe / tag manifest (handy when debugging a missing component):

```js
FluentUI.tags          // ['fluent-accordion', ...] — tags this bundle registers
FluentUI.pending()     // tags that failed to register; should be []
FluentUI.setTheme(obj) // optional: scope a theme object onto a node
```

## Rebuilding

Nothing here is built by `build.cmd`; the artifacts are committed, so a plain checkout
works offline. Rebuild only when bumping Fluent. Do it **outside** the repo so
`node_modules` never lands in the working tree.

```bash
mkdir -p /d/Hermes/cache/scratch/fluent-build
cd /d/Hermes/cache/scratch/fluent-build

# 1. install pinned deps (npmmirror first; fall back to registry.npmjs.org)
cat > package.json <<'JSON'
{
  "name": "fluent-build", "private": true, "type": "module",
  "dependencies": {
    "@fluentui/web-components": "3.1.3",
    "@microsoft/fast-element": "3.1.2"
  },
  "devDependencies": { "esbuild": "0.25.10" }
}
JSON
npm install --registry=https://registry.npmmirror.com/ --no-audit --no-fund

# 2. drop the entry in place
mkdir -p src
cp /d/HermesWorkspace/dsh-to-go/third_party/fluent/src/entry.js src/entry.js

# 3. bundle
npx esbuild src/entry.js --bundle --format=iife --minify --target=chrome110 \
  --charset=utf8 --legal-comments=none \
  --outfile=D:/HermesWorkspace/dsh-to-go/third_party/fluent/fluent.min.js

# 4. regenerate the dark theme (needs @fluentui/tokens, see VERSION.txt)
node src/gen-theme.js > D:/HermesWorkspace/dsh-to-go/third_party/fluent/fluent-theme.css
```

After rebuilding, sanity-check without a browser:

```bash
node -e "new Function(require('fs').readFileSync('D:/HermesWorkspace/dsh-to-go/third_party/fluent/fluent.min.js','utf8')); console.log('parses')"
grep -o 'fluent-[a-z-]*' D:/HermesWorkspace/dsh-to-go/third_party/fluent/fluent.min.js | sort -u
```

## Adding a component

1. Look up the real export names — do **not** guess them:
   `node_modules/@fluentui/web-components/dist/esm/index.js` (or `web-components.d.ts`).
   v3.1.3 exports `<Name>` + `<Name>Definition`, e.g. `Slider` / `SliderDefinition`.
2. Add both to the import list and to the `definitions` array in `src/entry.js`, and add
   the literal tag name to `tags[]`.
3. Rebuild, then re-check the size (target < 600 KB minified).

## Gotchas found while building this

- **No `provideFluentDesignSystem()`** in v3.1.3. Registration is
  `Xxx.define(XxxDefinition)`. Searching the docs for the v2 helper leads nowhere.
- **Tag names are computed**, `\`${prefix}-button\``, so grepping the minified bundle for
  `fluent-button` only works because `src/entry.js` also lists the tag names literally in
  `tags[]`. Those literals are the manifest, not decoration — keep them in sync.
- **`fluent-textarea`, not `fluent-text-area`.** The name is derived from the folder
  (`textarea`), so hyphenating the "text area" pair in markup silently gives you an
  unregistered element that renders nothing. Same trap class: `fluent-text-input` *is*
  hyphenated.
- **Not in 3.1.3**: `fluent-card`, `fluent-tab-panel`, `fluent-toast`. There is no
  `<fluent-select>` either — the select control is `fluent-dropdown` + `fluent-option`.
  Use `fluent-field` + `fluent-dialog` for card-like grouping and messages instead.
- Styles live in shadow DOM; page CSS cannot restyle component internals. Use design
  tokens (`--colorNeutralBackground1`, …) and the documented attributes instead of
  descending selectors.
