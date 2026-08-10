// The half that runs inside every bb UI: pull the shared arrangement, apply it
// live, and publish this device's edits.
//
// Applying is the interesting part. bb reads these preferences through
// `atomWithStorage`, whose localStorage adapter subscribes to the window
// `storage` event and checks only `event.storageArea` and `event.key`. A real
// storage event never fires for writes made by the same document, so after
// writing we dispatch a synthetic one — which makes the sidebar rearrange
// immediately instead of on the next reload. Verified live on bb 0.36.0.
import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc, useRealtime } from "@bb/plugin-sdk/app";
import {
  planApply,
  planPublish,
  type Snapshot,
  type StoredValue,
} from "./lib/sync.ts";
import type { rpcContract } from "./server";

const POLL_MS = 1000;
const DEVICE_ID_KEY = "bb.sidebar-sync.deviceId";

/** Stable per-browser id, so a device can ignore the echo of its own push. */
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (id === null) {
    id = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function readLocal(keys: readonly string[]): Record<string, StoredValue> {
  const out: Record<string, StoredValue> = {};
  for (const key of keys) out[key] = localStorage.getItem(key);
  return out;
}

/** Write and tell bb about it, so the sidebar updates without a reload. */
function writeLocal(key: string, value: StoredValue): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  window.dispatchEvent(
    new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }),
  );
}

function SidebarSync() {
  const rpc = useRpc<typeof rpcContract>();
  const [syncedKeys, setSyncedKeys] = useState<readonly string[]>([]);
  // Values this device has last seen or written. Applying a remote value folds
  // it in here so the poller does not read it back as a local edit and bounce
  // it to the server — the loop guard.
  const lastKnown = useRef<Record<string, StoredValue>>({});
  const me = useRef<string>("");
  const ready = useRef(false);
  // useRpc() hands back a new object every render. Depending on it in the
  // effect re-ran the whole setup on each render, which re-seeded lastKnown
  // from current localStorage — quietly absorbing every local edit before the
  // poller could notice it. Hold it in a ref and run the effect exactly once.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const keysRef = useRef<readonly string[]>([]);

  if (me.current === "") me.current = deviceId();

  const apply = (snapshot: Snapshot | null, keys: readonly string[]) => {
    const steps = planApply({ remote: snapshot, local: readLocal(keys), syncedKeys: keys });
    for (const step of steps) {
      writeLocal(step.key, step.value);
      lastKnown.current[step.key] = step.value;
    }
    return steps.length;
  };

  // Initial pull, then a poll that publishes local edits.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    void (async () => {
      const { snapshot, syncedKeys: keys } = await rpcRef.current.call("pull", null);
      if (cancelled) return;
      setSyncedKeys(keys);
      keysRef.current = keys;

      // Seed lastKnown from what is already here BEFORE applying, so keys the
      // server does not carry are not mistaken for fresh local edits later.
      lastKnown.current = readLocal(keys);
      apply(snapshot as Snapshot | null, keys);
      ready.current = true;

      timer = setInterval(() => {
        if (!ready.current) return;
        const local = readLocal(keys);
        const changed = planPublish({ local, lastKnown: lastKnown.current, syncedKeys: keys });
        if (changed === null) return;
        lastKnown.current = { ...lastKnown.current, ...changed };
        void rpcRef.current.call("push", { values: changed, deviceId: me.current });
      }, POLL_MS);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
    // Deliberately empty: this must run once for the lifetime of the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another UI changed the arrangement — apply it now rather than on reload.
  useRealtime("sidebar-sync.changed", (payload) => {
    const snapshot = payload as Snapshot;
    if (snapshot?.updatedBy === me.current) return;
    if (keysRef.current.length === 0) return;
    apply(snapshot, keysRef.current);
  });

  // A visible line, deliberately: the slot only mounts when it renders, and a
  // silent sync is one you cannot tell has stopped working.
  return (
    <div className="text-xs text-muted-foreground">
      {syncedKeys.length === 0
        ? "Sidebar sync — connecting…"
        : `Sidebar arrangement synced across your bb UIs (${syncedKeys.length} settings)`}
    </div>
  );
}

export default definePluginApp((app) => {
  // Homepage only, and that is a real limitation rather than a choice: the
  // plugin SDK has no always-mounted background surface. Every component slot
  // is route-scoped (homepage, settings, a panel's own route), and the one that
  // is always on screen — experimental_threadList — replaces bb's thread list
  // outright with no fallback to re-render. So the sync runs whenever the
  // homepage is on screen, which is where bb opens. Rearranging deep inside a
  // thread and closing the app without passing through the homepage is the gap.
  app.slots.homepageSection({
    id: "sidebar-sync",
    title: "Sidebar sync",
    component: SidebarSync,
  });
});
