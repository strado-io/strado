# Contributing to Strado

## Setup

Node 20 is the supported and CI version (`nvm use 20`).

    npm install
    npm run dev

See [BUILDING.md](BUILDING.md) for packaging and full test instructions.

## Before you open a PR

- `npm test` green (packages run sequentially; if the server suite flakes
  under load, re-run the failing file in isolation — flaky-in-parallel is a
  known trait, red-in-isolation is a real failure).
- New behavior comes with a test.
- Sign off your commits (DCO): `git commit -s`. By signing off you certify
  the Developer Certificate of Origin (developercertificate.org).

## What's in this repo / what isn't

This repo is the full Strado app: desktop shell, local server, web UI, ptyd,
runner, and relay. The hosted Strado Cloud service (accounts, orgs, billing)
lives in a private repo; the app talks to it over HTTP and works fully
without an account.

## Good first contributions

Agent adapters, git-provider integrations, Linux platform fixes, docs.
