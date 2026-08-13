# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Treat the security contracts in `README.md` and `SECURITY.md` as release invariants; their regression coverage is concentrated in `test/bridge.test.js`, `test/desktop-mirror.test.js`, `test/config.test.js`, `test/grok-client.test.js`, and `test/state.test.js`.
- Validate with `npm test` and `npm run check` on the minimum runtime declared in `package.json` before release changes.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
