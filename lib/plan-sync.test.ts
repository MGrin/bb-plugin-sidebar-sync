// The mount reconciliation, which is where the plugin used to eat local edits.
//
// The bug these cover: a homepage visit re-applied a snapshot the device had
// already applied hours earlier, because "what we last knew" lived in a React
// ref that died with the unmount. Unhiding a nav row from inside a thread was
// therefore undone by the next trip through the homepage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SYNCED_KEYS, planSync, type DeviceState, type Snapshot } from "./sync.ts";

const HIDDEN = "bb.sidebar.hiddenPluginPanels";
const COLLAPSED = "bb.sidebar.collapsedProjects";
const ME = "this-device";

const snap = (values: Record<string, string | null>, updatedAt: number, by = "other"): Snapshot => ({
  values,
  updatedAt,
  updatedBy: by,
});

const state = (lastKnown: Record<string, string | null>, lastAppliedAt: number): DeviceState => ({
  lastKnown,
  lastAppliedAt,
});

test("THE BUG: a snapshot already applied is never applied again", () => {
  // Server holds memory hidden, pushed at t=100 and applied then. The user has
  // since unhidden it locally. A later homepage visit must not re-hide it.
  const plan = planSync({
    remote: snap({ [HIDDEN]: '["memory-ui/memory"]' }, 100),
    local: { [HIDDEN]: "[]" },
    state: state({ [HIDDEN]: '["memory-ui/memory"]' }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, [], "must not rewrite localStorage from a known snapshot");
  assert.deepEqual(plan.publish, { [HIDDEN]: "[]" }, "the local edit must go up instead");
});

test("an edit made while unmounted is published on the next mount", () => {
  const plan = planSync({
    remote: snap({ [COLLAPSED]: '["proj_a"]' }, 100),
    local: { [COLLAPSED]: "[]" },
    state: state({ [COLLAPSED]: '["proj_a"]' }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.publish, { [COLLAPSED]: "[]" });
});

test("a genuinely newer snapshot from another device IS applied", () => {
  const plan = planSync({
    remote: snap({ [HIDDEN]: '["github/github"]' }, 200),
    local: { [HIDDEN]: "[]" },
    state: state({ [HIDDEN]: "[]" }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, [{ key: HIDDEN, value: '["github/github"]' }]);
  assert.equal(plan.publish, null);
});

test("a local edit beats a newer remote value for the same key", () => {
  // Both changed. The edit the human just made on THIS device is the one they
  // can see, so it wins and is published; the remote value is not written back.
  const plan = planSync({
    remote: snap({ [HIDDEN]: '["github/github"]', [COLLAPSED]: '["proj_a"]' }, 200),
    local: { [HIDDEN]: "[]", [COLLAPSED]: "[]" },
    state: state({ [HIDDEN]: '["memory-ui/memory"]', [COLLAPSED]: "[]" }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, [{ key: COLLAPSED, value: '["proj_a"]' }], "only the unedited key");
  assert.deepEqual(plan.publish, { [HIDDEN]: "[]" });
});

test("the device's own snapshot is not re-applied but is recorded as seen", () => {
  const plan = planSync({
    remote: snap({ [HIDDEN]: "[]" }, 300, ME),
    local: { [HIDDEN]: "[]" },
    state: state({ [HIDDEN]: "[]" }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.nextAppliedAt, 300, "so the next mount does not reconsider it");
});

test("first run on a device: nothing known, so nothing is a local edit", () => {
  const plan = planSync({
    remote: snap({ [HIDDEN]: '["github/github"]' }, 100),
    local: { [HIDDEN]: '["memory-ui/memory"]' },
    state: null,
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, [{ key: HIDDEN, value: '["github/github"]' }]);
  assert.equal(plan.publish, null, "a device with no history has no edits to claim");
});

test("first run with an empty server still seeds from this device", () => {
  const plan = planSync({
    remote: null,
    local: { [HIDDEN]: '["memory-ui/memory"]' },
    state: null,
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.publish, { [HIDDEN]: '["memory-ui/memory"]' });
});

test("an empty server plus a known local edit publishes the edit, not a reseed", () => {
  const plan = planSync({
    remote: null,
    local: { [HIDDEN]: "[]", [COLLAPSED]: '["proj_a"]' },
    state: state({ [HIDDEN]: '["memory-ui/memory"]', [COLLAPSED]: '["proj_a"]' }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.publish, { [HIDDEN]: "[]" });
});

test("nothing changed anywhere means no writes and no traffic", () => {
  const plan = planSync({
    remote: snap({ [HIDDEN]: "[]" }, 100),
    local: { [HIDDEN]: "[]" },
    state: state({ [HIDDEN]: "[]" }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.publish, null);
});

test("applied values are folded into what the device now knows", () => {
  const plan = planSync({
    remote: snap({ [HIDDEN]: '["github/github"]' }, 200),
    local: { [HIDDEN]: "[]", [COLLAPSED]: '["proj_a"]' },
    state: state({ [HIDDEN]: "[]", [COLLAPSED]: '["proj_a"]' }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  // Without this the applied value reads as a local edit next mount and bounces
  // back to the server — the loop the ref-based version guarded by accident.
  assert.equal(plan.nextKnown[HIDDEN], '["github/github"]');
  assert.equal(plan.nextKnown[COLLAPSED], '["proj_a"]');
  assert.equal(plan.nextAppliedAt, 200);
});

test("a device-local key is neither applied nor published", () => {
  const plan = planSync({
    remote: snap({ "bb.sidebar.width": "500" }, 200),
    local: { "bb.sidebar.width": "300" },
    state: state({ "bb.sidebar.width": "200" }, 100),
    syncedKeys: DEFAULT_SYNCED_KEYS,
    me: ME,
  });
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.publish, null);
});

// ------------------------------------------------------- persisted state ---

test("device state survives a round trip through localStorage", async () => {
  const { parseDeviceState, serializeDeviceState } = await import("./sync.ts");
  const original = state({ [HIDDEN]: '["a"]', [COLLAPSED]: null }, 12345);
  assert.deepEqual(parseDeviceState(serializeDeviceState(original)), original);
});

test("unreadable or absent device state reads as a first run", async () => {
  const { parseDeviceState } = await import("./sync.ts");
  assert.equal(parseDeviceState(null), null);
  assert.equal(parseDeviceState("not json"), null);
  assert.equal(parseDeviceState('{"lastKnown":"wrong shape"}'), null);
  assert.equal(parseDeviceState("[]"), null);
});
