<!-- agents-md ceiling: 58 lines -->
# AGENTS.md — bb-plugin-sidebar-sync

Keeps the bb sidebar **arrangement** identical in every UI — desktop app, browser, phone
PWA — through a snapshot in the plugin's own KV. [`README.md`](README.md) is the
user-facing document; its "Reconciling" section states the three rules in order of who
wins, and its "Known limitation" states why the baseline and watermark are persisted
rather than held in React state. Both are load-bearing; read them before changing sync.

## Commands, all run 2026-09-09

```sh
npm install          # rc=0
npm test             # node --test over lib/*.test.ts — 32 tests, 0 fail
bb plugin build .
```

**`npm run typecheck` FAILS on a clean clone** — 7 errors, of which the first two are
`TS2307: Cannot find module '@bb/plugin-sdk'` and the rest are the implicit `any`s that
follow from them. `@get-bb/plugin-sdk` is not in `devDependencies`. Measured 2026-09-09;
the README lists the command under Development as though it passes. Fix it in its own PR,
or drop the script; do not read its red as something you broke.

The gate is `npm test` plus `.github/workflows/managed-install.yml`, which reproduces bb's
managed git install (runtime dependencies only, then `bb plugin build`). `zod` is the only
runtime dependency and must stay in `dependencies`.

## Layout

| path | what it is |
|---|---|
| `lib/sync.ts` | the reconcile rules as pure functions over injected state |
| `lib/*.test.ts` | the suite — no DOM, no network |
| `server.ts` | KV storage, the merge, the realtime publish, `bb sidebar-sync` commands |
| `app.tsx` | the homepage section that hosts the poll |

## Conventions that differ from the defaults

- **The sync decisions are pure functions over injected state**, which is what lets them
  be tested without a DOM. Keep new rules in `lib/sync.ts`, not in the component.
- **Applying a value writes localStorage AND dispatches a synthetic `StorageEvent`.** bb's
  storage adapter listens for `storage` events, and a real one never fires for
  same-document writes — without the synthetic event the sidebar only rearranges on the
  next reload.
- **`bb.sidebar.width` and `bb.sidebar.open` are refused even when explicitly listed.**
  They are viewport state: a phone and a laptop should disagree, and syncing them makes
  both worse.
- **A snapshot at or below the local watermark is never re-applied**, and applied values
  are folded into the baseline as they are written. That is the loop guard; removing it
  lets the poller read a just-applied remote value as a fresh local edit and push it back.
- **The 60s poll is deliberate.** The receiving side is already instant over the realtime
  channel, and publishing on hide is what makes the poll feel immediate.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
