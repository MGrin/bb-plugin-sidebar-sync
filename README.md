# bb-plugin-sidebar-sync

Keeps the bb sidebar **arrangement** the same in every UI — desktop app, browser,
phone PWA.

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

Plugin KV holds the canonical snapshot. Each UI pulls it on mount, applies any
differing key, then polls its own localStorage once a second and pushes what
changed. The server merges (rather than replaces) and publishes on a realtime
channel, so other open UIs apply the change immediately.

Applying writes localStorage **and dispatches a synthetic `StorageEvent`**. bb's
storage adapter subscribes to `storage` events and checks only `storageArea`
and `key`; a real event never fires for same-document writes, so without the
synthetic one the sidebar would only rearrange on the next reload.

The **loop guard** is the part worth understanding: every applied value is
folded into the device's `lastKnown` map at the moment it is written. Without
that, the poller reads a just-applied remote value as a fresh local edit and
pushes it straight back, and two UIs ping-pong forever.

Conflicts are last-write-wins. For one person with two devices, anything
cleverer is invented complexity.

## Known limitation

**Sync runs while the homepage is on screen.** The plugin SDK has no
always-mounted background surface — every component slot is route-scoped
(homepage, settings, a panel's own route), and the only always-visible one,
`experimental_threadList`, replaces bb's thread list outright with no fallback
to re-render. bb opens on the homepage, so in practice this covers normal use;
the gap is rearranging the sidebar deep inside a thread and closing the app
without passing through the homepage again.

## CLI

```sh
bb sidebar-sync status   # the shared snapshot, who wrote it, when
bb sidebar-sync reset    # forget it; the next UI to open reseeds it
```

## Development

```sh
npm install
npm test          # 15 tests, no network, no browser
bb plugin build .
```

The sync rules live in `lib/sync.ts` as pure functions over injected state, so
the decisions — what to apply, what to publish, what never leaves the device —
are tested without a DOM.

## Licence

MIT
