# Building Strado from source

## Requirements

- Node 20.x (the web test suite requires it; `nvm use 20`)
- git 2.40+
- macOS (Apple Silicon) or Linux x64 for desktop packaging

## Dev run

    npm install
    npm run dev        # local server on :7877 + web with HMR
    npm run desktop    # Electron shell against a dev build

## Tests

    npm test           # all packages, sequentially

Run a single package: `npm run test -w packages/server`.
The server suite is timing-sensitive under heavy parallelism; if a full run
flakes, re-run the failing file in isolation before assuming a regression.

## Packaging desktop builds (unsigned)

    node scripts/package-mac.mjs      # arm64 DMG in release/
    node scripts/package-linux.mjs    # AppImage + deb in release/

Unsigned macOS builds need a one-time `xattr -cr /Applications/Strado.app`
after install. Official signed + notarized builds are published by the
Strado team at https://strado.io.

## Packaging the runner

    node scripts/package-runner.mjs
