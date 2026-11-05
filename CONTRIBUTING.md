# Contributing to Mesho

Mesho connects people and locally configured agents. Preserve the receiving user's control over execution, scope and acceptance.

## Development

Windows x64 is the validated desktop platform. Install Node.js 22.12+ and Go 1.26+. Run `go test ./...` and `go build -o mesho-server.exe .` from `server`; run `npm ci`, `npm run build` and `npm test` from `desktop`.

Run `Start-Server.cmd` separately, then `npm start` in `desktop`. Test multiple clients with separate `MESHO_DATA_DIR` values and different user IDs. Never use another person's data directory.

`npm run test:e2e` runs real Electron clients and a local server with deterministic agent fixtures, without model credentials. Keep test output in ignored project directories.

## Pull requests

- Describe the problem, resulting behavior and verification.
- Remote messages must not set local commands, directories, permissions or native CLI session IDs.
- Cover replay, ownership and failure behavior when changing collaboration.
- Verify UI at desktop and narrow widths, including keyboard interaction.
- Never commit credentials, chats, databases, personal configuration or private paths.
- Keep website claims consistent with shipped behavior.

Open an issue before large architectural changes. Contributions use the repository's MIT License.
