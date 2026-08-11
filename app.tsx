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
  DEFAULT_SYNCED_KEYS,
  DEVICE_STATE_KEY,
  parseDeviceState,
  planPublish,
  planSync,
  serializeDeviceState,
  type DeviceState,
  type Snapshot,
  type StoredValue,
} from "./lib/sync.ts";
import type { rpcContract } from "./server";

// Once a minute. This is a usability preference, not live state: the receiving
// side is already instant via the realtime channel, so the poll only governs
// how quickly a local edit is NOTICED. A 1s timer on a phone that is already
// struggling costs more than it buys.
const POLL_MS = 60_000;
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

/**
 * What this device knows, kept in localStorage rather than in a ref, because
 * this component unmounts every time a thread is opened. See DeviceState.
 */
function readState(): DeviceState | null {
  return parseDeviceState(localStorage.getItem(DEVICE_STATE_KEY));
}

function writeState(state: DeviceState): void {
  localStorage.setItem(DEVICE_STATE_KEY, serializeDeviceState(state));
}

function SidebarSync() {
  const rpc = useRpc<typeof rpcContract>();
  const [syncedKeys, setSyncedKeys] = useState<readonly string[]>([]);
  const me = useRef<string>("");
  // useRpc() hands back a new object every render, so depending on it in the
  // effect would re-run the whole setup on each render. Hold it in a ref.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const keysRef = useRef<readonly string[]>([]);

  if (me.current === "") me.current = deviceId();

  /**
   * The one path that touches localStorage. Applies what is genuinely new,
   * publishes what this device changed, and records both — but only records a
   * published value AFTER the server has it, so a failed push retries on the
   * next mount instead of being silently forgotten.
   */
  const reconcile = async (snapshot: Snapshot | null, keys: readonly string[]) => {
    const before = readState();
    const plan = planSync({
      remote: snapshot,
      local: readLocal(keys),
      state: before,
      syncedKeys: keys,
      me: me.current,
    });

    for (const step of plan.apply) writeLocal(step.key, step.value);

    // Persist the applied half immediately. Keys still in flight keep their old
    // baseline, which is what makes an unlanded push retry rather than vanish.
    const pending: Record<string, StoredValue> = { ...plan.nextKnown };
    if (plan.publish !== null) {
      for (const key of Object.keys(plan.publish)) {
        if (before !== null && key in before.lastKnown) pending[key] = before.lastKnown[key];
        else delete pending[key];
      }
    }
    writeState({ lastKnown: pending, lastAppliedAt: plan.nextAppliedAt });

    if (plan.publish === null) return;
    const { updatedAt } = await rpcRef.current.call("push", {
      values: plan.publish,
      deviceId: me.current,
    });
    writeState({
      lastKnown: plan.nextKnown,
      lastAppliedAt: Math.max(plan.nextAppliedAt, updatedAt),
    });
  };

  // Initial pull, then a poll that publishes local edits.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let publishOnHide: (() => void) | undefined;
    let onHideCleanup: (() => void) | undefined;
    let ready = false;

    /**
     * Send up whatever changed here since the persisted baseline. Used by the
     * poll, by page-hide, and by unmount — the last one matters most, because
     * opening a thread unmounts this component and used to drop the edit.
     */
    const publishIfChanged = () => {
      if (!ready) return;
      const keys = keysRef.current;
      const state = readState();
      if (state === null || keys.length === 0) return;
      const changed = planPublish({
        local: readLocal(keys),
        lastKnown: state.lastKnown,
        syncedKeys: keys,
      });
      if (changed === null) return;
      void rpcRef.current
        .call("push", { values: changed, deviceId: me.current })
        .then(({ updatedAt }) => {
          const current = readState() ?? state;
          writeState({
            lastKnown: { ...current.lastKnown, ...changed },
            lastAppliedAt: Math.max(current.lastAppliedAt, updatedAt),
          });
        })
        .catch(() => {
          // Left unrecorded on purpose: the next mount will try again.
        });
    };

    void (async () => {
      const probe = readLocal(DEFAULT_SYNCED_KEYS);
      const held = Object.values(probe).filter((v) => v !== null).length;
      const { snapshot, syncedKeys: keys } = await rpcRef.current.call("pull", {
        deviceId: me.current,
        localKeys: held,
      });
      if (cancelled) return;
      setSyncedKeys(keys);
      keysRef.current = keys;

      await reconcile(snapshot as Snapshot | null, keys);
      if (cancelled) return;
      ready = true;

      timer = setInterval(publishIfChanged, POLL_MS);

      publishOnHide = () => {
        if (document.visibilityState === "hidden") publishIfChanged();
      };
      document.addEventListener("visibilitychange", publishOnHide);
      window.addEventListener("pagehide", publishIfChanged);
      onHideCleanup = () => {
        document.removeEventListener("visibilitychange", publishOnHide as () => void);
        window.removeEventListener("pagehide", publishIfChanged);
      };
    })();

    return () => {
      cancelled = true;
      // Flush before going away. Leaving the homepage for a thread is the
      // common exit, and the 60s timer will usually never have fired.
      publishIfChanged();
      if (timer !== undefined) clearInterval(timer);
      onHideCleanup?.();
    };
    // Deliberately empty: this must run once for the lifetime of the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another UI changed the arrangement — fold it in now rather than on reload.
  // Same path as mount, so a local edit still beats an incoming remote one.
  useRealtime("sidebar-sync.changed", (payload) => {
    const snapshot = payload as Snapshot;
    if (keysRef.current.length === 0) return;
    void reconcile(snapshot, keysRef.current);
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
