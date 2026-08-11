// Which sidebar preferences travel between UIs, and the rules for moving them.
//
// bb keeps the sidebar arrangement in `atomWithStorage` — i.e. browser
// localStorage — so the desktop app and the phone PWA each hold their own copy
// and drift apart. This module is the pure half of the fix: it decides what to
// apply from the server and what to publish back, with no DOM, no clock and no
// network, so the whole thing is testable offline.

/**
 * Viewport state, not arrangement. A phone and a laptop legitimately disagree
 * about how wide the sidebar should be and whether it is open, so syncing these
 * would make both worse. Excluded from the default set on purpose.
 */
export const DEVICE_LOCAL_KEYS = ["bb.sidebar.width", "bb.sidebar.open"] as const;

/** Everything that describes the ARRANGEMENT, which should look the same everywhere. */
export const DEFAULT_SYNCED_KEYS = [
  "bb.sidebar.pluginPanelOrder",
  "bb.sidebar.hiddenPluginPanels",
  "bb.sidebar.sectionOrder",
  "bb.sidebar.manualSectionOrder",
  "bb.sidebar.machineSectionOrder",
  "bb.sidebar.folderSectionOrder",
  "bb.sidebar.organizationMode",
  "bb.sidebar.chronologicalSort",
  "bb.sidebar.collapsedSections",
  "bb.sidebar.collapsedProjects",
  "bb.sidebar.collapsedThreads",
  "bb.sidebar.collapsedThreadSections",
  "bb.sidebar.collapsedFolders",
  "bb.sidebar.collapsedMachines",
  "bb.sidebar.collapsedEnvironments",
  "bb.sidebar.threadListProvider",
] as const;

const KNOWN_KEYS: readonly string[] = [...DEFAULT_SYNCED_KEYS, ...DEVICE_LOCAL_KEYS];

/** null means "this key is absent" — distinct from an empty string. */
export type StoredValue = string | null;

export interface Snapshot {
  values: Record<string, StoredValue>;
  updatedAt: number;
  updatedBy: string;
}

/**
 * Parse the user's key list. Unknown keys are dropped rather than trusted, and
 * device-local keys are refused even if explicitly listed — syncing sidebar
 * width to a phone is never what someone means.
 */
export function parseSyncedKeys(raw: string): string[] {
  const listed = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (listed.length === 0) return [...DEFAULT_SYNCED_KEYS];
  return listed.filter(
    (k) => KNOWN_KEYS.includes(k) && !DEVICE_LOCAL_KEYS.includes(k as never),
  );
}

export interface PlanApplyArgs {
  remote: Snapshot | null;
  local: Record<string, StoredValue>;
  syncedKeys: readonly string[];
}

export interface ApplyStep {
  key: string;
  value: StoredValue;
}

/**
 * What this device must write to match the server. Returns only genuine
 * differences: rewriting an identical value would fire a storage event and
 * churn the UI for nothing.
 */
export function planApply(args: PlanApplyArgs): ApplyStep[] {
  if (args.remote === null) return [];
  const steps: ApplyStep[] = [];
  for (const key of args.syncedKeys) {
    if (!(key in args.remote.values)) continue;
    const next = args.remote.values[key] ?? null;
    const current = args.local[key] ?? null;
    if (next !== current) steps.push({ key, value: next });
  }
  return steps;
}

/**
 * What to publish when the server has nothing yet. Without this a device that
 * arranged its sidebar BEFORE the plugin was installed never seeds: mount
 * records the current values as "last known", so the poller sees no change and
 * stays silent forever, and every other device keeps its own arrangement.
 * Only keys that actually have a value are seeded — absent keys are not
 * opinions and must not be broadcast as ones.
 */
export function planSeed(
  local: Record<string, StoredValue>,
  syncedKeys: readonly string[],
): Record<string, StoredValue> | null {
  const seed: Record<string, StoredValue> = {};
  for (const key of syncedKeys) {
    const value = local[key] ?? null;
    if (value !== null) seed[key] = value;
  }
  return Object.keys(seed).length === 0 ? null : seed;
}

export interface PlanPublishArgs {
  local: Record<string, StoredValue>;
  /**
   * What this device last saw or wrote. Anything applied FROM the server must
   * be folded in here by the caller — that is the loop guard: without it, an
   * applied remote value reads as a local edit and bounces straight back.
   */
  lastKnown: Record<string, StoredValue>;
  syncedKeys: readonly string[];
}

/** The changed keys to publish, or null when nothing changed. */
export function planPublish(args: PlanPublishArgs): Record<string, StoredValue> | null {
  const changed: Record<string, StoredValue> = {};
  for (const key of args.syncedKeys) {
    const current = args.local[key] ?? null;
    const previous = args.lastKnown[key] ?? null;
    if (current !== previous) changed[key] = current;
  }
  return Object.keys(changed).length === 0 ? null : changed;
}
