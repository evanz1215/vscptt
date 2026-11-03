# vscptt

PTT BBS browser for VS Code.

## Development

```bash
pnpm install
pnpm run build       # bundle to out/extension.js
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest
pnpm run watch       # rebuild on change
```

Press F5 in VS Code to launch the Extension Development Host.

## Packaging

```bash
pnpm run package     # produces a .vsix
```

Set `publisher` in `package.json` before packaging.
