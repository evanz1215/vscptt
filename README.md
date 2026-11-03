# vscptt

PTT BBS browser for VS Code.

## Development

```bash
pnpm install
pnpm run build       # bundle to out/extension.js
pnpm run typecheck   # tsc --noEmit
pnpm run lint        # oxlint
pnpm run format:check
pnpm run test        # vitest (never touches the network)
pnpm run watch       # rebuild on change
```

Press F5 in VS Code to launch the Extension Development Host.

### Live smoke test (optional)

`test/smoke/live.test.ts` logs in to the real PTT, checks the main menu, and logs out. It is skipped unless
you opt in, and it is never part of CI. Pass credentials through environment variables only; never commit
or paste them anywhere.

```bash
# bash
PTT_LIVE=1 PTT_USER=<id> PTT_PASS=<password> pnpm exec vitest run test/smoke
```

```powershell
# PowerShell
$env:PTT_LIVE='1'; $env:PTT_USER='<id>'; $env:PTT_PASS='<password>'; pnpm exec vitest run test/smoke
```

Avoid running it repeatedly in a short time: PTT limits frequent logins.

## Packaging

```bash
pnpm run package     # produces a .vsix
```

Set `publisher` in `package.json` before packaging.
