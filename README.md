# bb-plugin-sidebar-sync

Keeps the bb sidebar **arrangement** the same in every UI — desktop app, browser,
phone PWA.

## Install

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-sidebar-sync@main
```

No configuration, no external service: the shared snapshot lives in your own
bb's plugin storage.

## The problem

bb stores sidebar preferences with `atomWithStorage`, i.e. browser
localStorage. The Electron app and the phone are different browsers, so each
keeps its own copy and they drift. bb's server holds no per-user UI
preferences, so nothing reconciles them.

## What syncs

The 16 **arrangement** keys: nav row order and hidden rows, section order,
organization mode, chronological sort, and every collapsed-* set (projects,
threads, sections, folders, machines, environments), plus the thread-list
provider.

**`bb.sidebar.width` and `bb.sidebar.open` deliberately do not sync.** Those are
viewport state — a phone and a laptop should disagree about sidebar width, and
syncing them makes both worse. The key list is a plugin setting if you want to
change it, but those two are refused even when listed explicitly.

## How it works

Plugin KV holds the canonical snapshot. Each UI pulls it on mount, reconciles,
then checks its own localStorage **once a minute** — and immediately when the
tab is hidden or the section unmounts — and pushes what changed.

The slow poll is deliberate. This is a usability preference, not live state:
the *receiving* side is already instant over the realtime channel, so the poll
only governs how quickly a local edit is noticed. Publishing on hide is what
makes a 60s poll feel immediate — rearrange on the laptop, pick up the phone,
and it is already there. The server merges (rather than replaces) and publishes on a realtime
channel, so other open UIs apply the change immediately.

Applying writes localStorage **and dispatches a synthetic `StorageEvent`**. bb's
storage adapter subscribes to `storage` events and checks only `storageArea`
and `key`; a real event never fires for same-document writes, so without the
synthetic one the sidebar would only rearrange on the next reload.

## Reconciling, and why it is not just "apply the server's copy"

Each device persists two things in its own localStorage: a **baseline** of the
values it last saw or wrote, and a **watermark** — the `updatedAt` of the newest
snapshot it has already applied. Both have to survive an unmount, which is the
whole trick (see the limitation below). Reconciling then follows three rules, in
order of who wins:

1. **A snapshot at or below the watermark is never re-applied.** If the local
   values differ from a snapshot this device already applied, that means the
   human changed something since — not that the device has fallen behind.
2. **A key edited locally since the baseline beats the remote value**, and is
   published instead. The arrangement someone can actually see wins.
3. Everything else in a newer snapshot is applied.

Rule 1 is also the loop guard: applied values are folded into the baseline as
they are written, so the poller cannot read a just-applied remote value as a
fresh local edit and push it straight back. A published value is only recorded
as known once the server confirms it, so a failed push retries on the next mount
instead of vanishing.

Beyond that, conflicts are last-write-wins. For one person with two devices,
anything cleverer is invented complexity.

## Known limitation

**Sync runs while the homepage is on screen.** The plugin SDK has no
always-mounted background surface — every component slot is route-scoped
(homepage, settings, a panel's own route), and the only always-visible one,
`experimental_threadList`, replaces bb's thread list outright with no fallback
to re-render. bb opens on the homepage, so in practice this covers normal use;
the gap is rearranging the sidebar deep inside a thread and closing the app
without passing through the homepage again.

This is why the baseline and watermark are persisted rather than held in React
state. The section unmounts the moment a thread is opened, so a device that kept
them in memory would forget, on every navigation, both what it last saw and what
it had already applied — and would then re-apply a stale snapshot over edits made
since. That was a real bug, and it looked like the sidebar reverting itself on a
single device with no second device involved.

## CLI

```sh
bb sidebar-sync status   # the shared snapshot, who wrote it, when
bb sidebar-sync reset    # forget it; the next UI to open reseeds it
```

## Development

```sh
npm install
npm test          # 32 tests, no network, no browser
npm run typecheck
bb plugin build .
```

The sync rules live in `lib/sync.ts` as pure functions over injected state, so
the decisions — what to apply, what to publish, what never leaves the device —
are tested without a DOM.

## Licence

MIT
