# Native launcher (`tools/launcher`)

A WinForms + WebView2 shell that replaces "open a browser tab" with a real window.
It owns the local `ui-server` process, keeps the access token in memory, and hands
that token to the page over the WebView2 message bridge.

Built with the C# compiler that already ships with Windows — no Visual Studio,
no .NET SDK, nothing to install on the USB stick.

## Build

```
tools\launcher\build-launcher.cmd
```

Output: `build\launcher\dsh-to-go.exe` plus the three WebView2 binaries it needs
next to it (`Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`,
`WebView2Loader.dll`). The script copies them automatically.

Requires the pinned SDK in `third_party\webview2` (see `VERSION.txt` there:
1.0.2903.40 — newer SDKs throw `E_NOINTERFACE` against the runtime installed here).

## What it does at startup

1. **Single instance.** A named mutex keyed by a hash of the repository root.
   A second launch does not start another server: it sets a named `EventWaitHandle`,
   the running shell restores and foregrounds its window, and the second process exits.
2. **Port.** Probes `127.0.0.1` from 3181 upward with a `TcpListener` and takes the
   first free port.
3. **Server.** Starts `runtime\node\node.exe tools\ui-server.js --no-open --port N`
   hidden, with stdout/stderr redirected. The token is scraped from the printed URL
   with `\?token=([A-Za-z0-9_-]+)`, waiting at most 30 s.
4. **Readiness.** Polls `GET http://127.0.0.1:N/` with `x-config-token` every 300 ms
   until it gets a 200 (30 s cap).
5. **Window.** Fixed title `dsh-to-go`, 1200x840, centred, no menu bar. WebView2
   profile lives in `data\.webview` (created on demand).
6. **Page.** Navigates to `http://127.0.0.1:N/` — **no token in the URL**, per contract.

## Token handling (the red lines)

- The token is parsed from child stdout into a private field. stdout is **never**
  logged; on stderr, `Host.Log` rewrites `?token=...` to `?token=<redacted>`.
- It is never written to the window title (constant `dsh-to-go`), never passed on a
  command line, never written to disk, never put in the URL.
- Because the current `ui-server.js` rejects even `/` without a token, the shell
  attaches `x-config-token` to **same-origin only** requests through
  `CoreWebView2.WebResourceRequested` (filter scoped to `http://127.0.0.1:N/*` plus a
  URI prefix check). Third-party requests never see it.
- `ui/app.html` asks for the token after load:

  ```js
  window.chrome.webview.postMessage({ type: 'dsh.token.request' });
  window.chrome.webview.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'dsh.token') { /* e.data.token */ }
  });
  ```

  The shell answers with `{"type":"dsh.token","token":"<token>"}` via
  `PostWebMessageAsJson`. It also accepts `{"type":"dsh.activate"}` to raise the window.

## WebView2 hardening

DevTools, context menus, browser accelerator keys, password autosave, general
autofill, script dialogs, the status bar and host objects are all disabled.
`NavigationStarting` cancels anything outside `http://127.0.0.1:N` (plus
`about:`/`data:` for the built-in message pages), so a stray link cannot navigate
the shell somewhere else.

## Failure paths

- **No `runtime\node\node.exe`:** the window stays open and shows a Chinese hint page
  telling the user to run `build.cmd` first. No crash, no silent exit.
- **WebView2 will not initialise** (missing runtime, `E_NOINTERFACE`, …): the shell
  closes itself, launches `dsh-ui.cmd` as the browser fallback, and appends a line to
  `data\logs\launcher.log`.
- **Window closed:** the `ui-server` process *this shell started* is killed with
  `taskkill /F /T /PID`, so no orphan node keeps the port. A server started by
  something else is left alone.

## Diagnosing

`data\logs\launcher.log` records port, "token received (N chars)", readiness, page
load results and exit codes — never the token itself.

Set `DSH_LAUNCHER_SELFTEST=1` before launching to have the shell drive the real
message bridge after the first page load and log the reply type plus the token
**length**. Useful when the page-side bridge code changes.
