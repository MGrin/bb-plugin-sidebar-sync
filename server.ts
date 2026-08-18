// bb-plugin-sidebar-sync — one sidebar arrangement across every bb UI.
//
// The sidebar's order, hidden nav rows and collapsed sections live in browser
// localStorage (bb uses `atomWithStorage`), so the desktop app and the phone
// PWA are separate browsers with separate copies and drift apart. bb's server
// stores no per-user UI preferences, so this plugin supplies the missing
// shared place: plugin KV holds the canonical snapshot, and every connected
// frontend pulls it, pushes its own edits, and gets told when it changes.
import { execFileSync } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { parseSyncedKeys, type Snapshot, type StoredValue } from "./lib/sync.ts";

const SNAPSHOT_KEY = "snapshot";
const SEEN_KEY = "devices-seen";
export const CHANGED_CHANNEL = "sidebar-sync.changed";

const storedValue = z.union([z.string(), z.null()]);

export const rpcContract = defineRpcContract({
  pull: {
    // Devices identify themselves and report how much arrangement they hold.
    // Without this there is no way to tell "no device is calling" apart from
    // "devices call but have nothing to seed" — which cost a debugging round.
    input: z
      .object({ deviceId: z.string(), localKeys: z.number() })
      .nullable(),
    output: z.object({
      snapshot: z
        .object({
          values: z.record(z.string(), storedValue),
          updatedAt: z.number(),
          updatedBy: z.string(),
        })
        .nullable(),
      syncedKeys: z.array(z.string()),
    }),
  },
  push: {
    input: z.object({
      values: z.record(z.string(), storedValue),
      deviceId: z.string(),
    }),
    output: z.object({ updatedAt: z.number() }),
  },
});

/**
 * Which commit is this PROCESS running? (MX-139/MX-141)
 *
 * bb bundles a `path:` plugin FROM SOURCE at reload, so a revision read here — at module
 * load, the same moment — is by construction the code now executing. Nothing else can say:
 * `bb plugin list` prints `running` and the source path but no revision, `bb plugin source`
 * has none to record for a path: source, and dist/ is NOT the loaded artifact (its mtime was
 * measured lying by 15 minutes). So a checkout can sit clean on main, every drift check
 * green, while the process runs something older.
 *
 * Synchronous on purpose: the value must be fixed before anything can observe it, and it is
 * one git call per load. Failure yields rev: null rather than a guess — a tarball install has
 * no git dir, and that must stay distinguishable from a real mismatch so a checker reports
 * UNKNOWN rather than OK. `dirty` rides along because a bundle built from an edited tree
 * matches NO commit, and comparing revisions alone would call that a match.
 */
const BUILD_STAMP: { rev: string | null; dirty: boolean | null; sourceDir: string; loadedAt: string; why: string | null } = (() => {
  const here = import.meta.dirname;
  const loadedAt = new Date().toISOString();
  try {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", here, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    return {
      rev: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      sourceDir: git(["rev-parse", "--show-toplevel"]),
      loadedAt,
      why: null,
    };
  } catch (e) {
    return { rev: null, dirty: null, sourceDir: here, loadedAt, why: e instanceof Error ? e.message : String(e) };
  }
})();

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    syncedKeys: {
      type: "string",
      label: "Synced keys",
      description:
        "comma-separated bb.sidebar.* keys; blank = all arrangement keys. Width and open stay per-device.",
      default: "",
    },
  });

  const loadSnapshot = async (): Promise<Snapshot | null> =>
    (await bb.storage.kv.get<Snapshot>(SNAPSHOT_KEY)) ?? null;

  bb.rpc.register(rpcContract, {
    async pull(input) {
      const cfg = await settings.get();
      if (input !== null) {
        const seen =
          (await bb.storage.kv.get<Record<string, { at: number; localKeys: number }>>(SEEN_KEY)) ??
          {};
        seen[input.deviceId] = { at: Date.now(), localKeys: input.localKeys };
        await bb.storage.kv.set(SEEN_KEY, seen);
      }
      return {
        snapshot: await loadSnapshot(),
        syncedKeys: parseSyncedKeys(cfg.syncedKeys),
      };
    },

    async push({ values, deviceId }) {
      const cfg = await settings.get();
      const allowed = new Set(parseSyncedKeys(cfg.syncedKeys));
      const current = await loadSnapshot();

      // Merge rather than replace: a device only ever sends the keys it
      // changed, so a wholesale overwrite would delete arrangement another
      // device set but this one has never seen.
      const merged: Record<string, StoredValue> = { ...(current?.values ?? {}) };
      for (const [key, value] of Object.entries(values)) {
        if (!allowed.has(key)) continue;
        merged[key] = value;
      }

      const next: Snapshot = {
        values: merged,
        updatedAt: Date.now(),
        updatedBy: deviceId,
      };
      await bb.storage.kv.set(SNAPSHOT_KEY, next);

      // Tell the other UIs. The publisher filters itself out by deviceId, so
      // it never re-applies its own write.
      bb.realtime.publish(CHANGED_CHANNEL, next);
      return { updatedAt: next.updatedAt };
    },
  });

  bb.cli.register({
    name: "sidebar-sync",
    summary: "Sidebar arrangement shared across bb UIs",
    commands: [
      { name: "status", summary: "Show the shared snapshot", usage: "bb sidebar-sync status" },
      { name: "reset", summary: "Forget it and let the next UI reseed", usage: "bb sidebar-sync reset" },
      {
        name: "build",
        summary: "Which commit this RUNNING process was loaded from (not the checkout)",
        usage: "bb sidebar-sync build [--json]",
      },
    ],
    async run(argv) {
      // Answered FIRST, ahead of `reset` (which DELETES the shared snapshot) and ahead of
      // the default path that loads it: "what is running" must stay answerable when the
      // thing running is broken, and must never have a side effect of its own.
      if (argv[0] === "build") {
        if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(BUILD_STAMP) };
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return {
          exitCode: 0,
          stdout: `loaded ${BUILD_STAMP.rev ?? "unknown"}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}`,
        };
      }

      if (argv[0] === "reset") {
        await bb.storage.kv.delete(SNAPSHOT_KEY);
        return { exitCode: 0, stdout: "snapshot cleared" };
      }
      const snap = await loadSnapshot();
      const cfg = await settings.get();
      const seen =
        (await bb.storage.kv.get<Record<string, { at: number; localKeys: number }>>(SEEN_KEY)) ?? {};
      const devices = Object.entries(seen).map(
        ([id, d]) =>
          `  ${id.slice(0, 8)}  last seen ${new Date(d.at).toISOString()}  holds ${d.localKeys} keys`,
      );
      const deviceBlock =
        devices.length === 0
          ? "devices: none have called in — no UI is running the plugin frontend"
          : `devices (${devices.length}):\n${devices.join("\n")}`;

      if (snap === null) {
        return {
          exitCode: 0,
          stdout: `no snapshot yet — open a bb UI to seed it\n${deviceBlock}`,
        };
      }
      const lines = [
        `updated: ${new Date(snap.updatedAt).toISOString()} by ${snap.updatedBy}`,
        `keys:    ${Object.keys(snap.values).length} stored / ${parseSyncedKeys(cfg.syncedKeys).length} synced`,
        deviceBlock,
        ...Object.entries(snap.values).map(
          ([k, v]) => `  ${k} = ${v === null ? "(unset)" : v.slice(0, 60)}`,
        ),
      ];
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });
}
