# Copilot Instructions

## Build, test, and lint commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install dependencies | `npm install` | Uses `package-lock.json`; stay on npm unless the repo changes package managers. |
| Run the app locally | `npm start` | Starts the Electron Forge development app. |
| Package the app | `npm run package` | Produces a packaged app build through Electron Forge. |
| Create distributables | `npm run make` | Generates installer/output artifacts; Windows Squirrel is the active maker in `forge.config.js`. |
| Test command status | `npm test` | Placeholder only; it exits with an error and there is no real test suite configured yet. |

There is currently **no lint script** and **no supported single-test command** because no test runner is configured in this repository.

## High-level architecture

- This repo is a small Electron Forge client with all app code at the repository root, not under a `src/` tree.
- `main.js` is the main process entrypoint. It creates the `BrowserWindow`, owns the application menu, persists configuration, and handles IPC.
- `preload.js` is the only bridge between the renderer and Electron APIs. Renderer code should talk to Electron through the functions exposed on `window.versions`.
- `index.html` and `renderer.js` implement a local configuration screen where the user enters the base URL of the business music service.
- The app stores the selected service URL in `app.getPath('userData')\config.json`. After the renderer validates and normalizes the URL, the main process saves it and navigates the window to `${baseUrl}/login`.
- The remote service UI is **not** part of this repository. This repo owns the Electron shell, the configuration flow, and the handoff into the external service.
- `forge.config.js` controls packaging. The app is packaged as `asar`, uses icons from `images\`, and is currently configured mainly for Windows Squirrel output.

## Key conventions

- Use **CommonJS** (`require`, `module.exports`) throughout; do not introduce ESM in a single file without converting the app consistently.
- Keep Node/Electron access out of renderer code. If the UI needs new privileged behavior, add an IPC handler in `main.js`, expose it from `preload.js`, and consume it from `renderer.js`.
- Treat the service URL as a persisted setting named `serviceUrl` in the JSON config file. Existing code trims trailing slashes before saving and only accepts `http`/`https`.
- Preserve the current Spanish UX copy for user-facing text such as form labels, menu labels, and validation messages.
- The local HTML uses a restrictive CSP (`default-src 'self'; script-src 'self'`). New local UI assets should be bundled locally rather than loaded from remote CDNs.
- Returning to configuration is done by loading the local `index.html` again from the application menu (`Servicio > Reconfigurar servicio`), so changes to the setup flow should keep that round-trip working.
