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

// -------------------------------------------------------- device state ---

/**
 * What this device carries BETWEEN mounts. It has to outlive the React tree:
 * the frontend is a route-scoped homepage section, so it unmounts the moment a
 * thread is opened. When this lived in a `useRef` the plugin forgot, on every
 * unmount, both which values it had already seen and which snapshot it had
 * already applied — so the next homepage visit re-applied an old snapshot over
 * edits made in between. That is the revert bug; persistence is the fix.
 */
export interface DeviceState {
  /** Values this device has last seen or written; the baseline for "what changed here". */
  lastKnown: Record<string, StoredValue>;
  /** `updatedAt` of the newest snapshot already folded in. Never re-apply at or below it. */
  lastAppliedAt: number;
}

export const DEVICE_STATE_KEY = "bb.sidebar-sync.state";

export function serializeDeviceState(state: DeviceState): string {
  return JSON.stringify(state);
}

/** Tolerant on purpose: a corrupt blob must degrade to "first run", never throw. */
export function parseDeviceState(raw: StoredValue): DeviceState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { lastKnown, lastAppliedAt } = parsed as Partial<DeviceState>;
  if (typeof lastKnown !== "object" || lastKnown === null || Array.isArray(lastKnown)) return null;
  if (typeof lastAppliedAt !== "number" || !Number.isFinite(lastAppliedAt)) return null;
  return { lastKnown, lastAppliedAt };
}

export interface PlanSyncArgs {
  remote: Snapshot | null;
  local: Record<string, StoredValue>;
  /** null on the very first run of this device — it then has no edits to claim. */
  state: DeviceState | null;
  syncedKeys: readonly string[];
  me: string;
}

export interface SyncPlan {
  /** localStorage writes to make. */
  apply: ApplyStep[];
  /** Keys to send up, or null. */
  publish: Record<string, StoredValue> | null;
  /** The baseline to persist once the writes land. */
  nextKnown: Record<string, StoredValue>;
  /** The `lastAppliedAt` to persist. */
  nextAppliedAt: number;
}

/**
 * Reconcile this device against the server, once per mount.
 *
 * Three rules, in order of who wins:
 *
 * 1. A snapshot at or below `lastAppliedAt` is old news and is NEVER re-applied,
 *    however much the local values differ from it. Differing means the human
 *    changed something since — not that this device has fallen behind.
 * 2. A key edited locally since `lastKnown` beats the remote value for that key,
 *    and is published instead. The arrangement the human can see wins.
 * 3. Everything else in a newer snapshot is applied.
 */
export function planSync(args: PlanSyncArgs): SyncPlan {
  const { remote, local, state, syncedKeys, me } = args;
  const lastAppliedAt = state?.lastAppliedAt ?? 0;

  // Rule 2 — what changed HERE since we last looked. A first run has no
  // baseline, so it claims no edits: everything present is just what it found.
  const edits =
    state === null ? null : planPublish({ local, lastKnown: state.lastKnown, syncedKeys });

  // Rule 1 — only a snapshot we have not already folded in is worth reading.
  const isNews = remote !== null && remote.updatedAt > lastAppliedAt;
  // Our own echo carries no information we do not already have locally, but it
  // must still advance the watermark or every later mount reconsiders it.
  const readable = isNews && remote.updatedBy !== me ? remote : null;

  // Rule 3 — apply the newer snapshot, minus the keys we are about to publish.
  const apply = planApply({ remote: readable, local, syncedKeys }).filter(
    (step) => edits === null || !(step.key in edits),
  );

  // An empty server needs seeding, but only from a device with no edits to
  // send: with edits, publishing those is both smaller and more current.
  const publish =
    edits ?? (remote === null ? planSeed(local, syncedKeys) : null);

  const nextKnown: Record<string, StoredValue> = {};
  for (const key of syncedKeys) nextKnown[key] = local[key] ?? null;
  for (const step of apply) nextKnown[step.key] = step.value;
  if (publish !== null) for (const [key, value] of Object.entries(publish)) nextKnown[key] = value;

  return {
    apply,
    publish,
    nextKnown,
    nextAppliedAt: isNews ? (remote as Snapshot).updatedAt : lastAppliedAt,
  };
}
