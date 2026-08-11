import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planSeed,
  DEFAULT_SYNCED_KEYS,
  DEVICE_LOCAL_KEYS,
  parseSyncedKeys,
  planApply,
  planPublish,
  type Snapshot,
} from "./sync.ts";

test("width and open are device-local and never synced by default", () => {
  for (const key of DEVICE_LOCAL_KEYS) {
    assert.ok(!DEFAULT_SYNCED_KEYS.includes(key), `${key} must not sync`);
  }
  assert.ok(DEVICE_LOCAL_KEYS.includes("bb.sidebar.width"));
  assert.ok(DEVICE_LOCAL_KEYS.includes("bb.sidebar.open"));
});

test("the default set covers the arrangement keys", () => {
  for (const key of [
    "bb.sidebar.pluginPanelOrder",
    "bb.sidebar.hiddenPluginPanels",
    "bb.sidebar.sectionOrder",
    "bb.sidebar.collapsedProjects",
    "bb.sidebar.organizationMode",
  ]) {
    assert.ok(DEFAULT_SYNCED_KEYS.includes(key), `${key} should sync`);
  }
});

test("parseSyncedKeys ignores unknown keys and device-local ones", () => {
  const parsed = parseSyncedKeys(
    "bb.sidebar.sectionOrder, bb.sidebar.width, not.a.key, bb.sidebar.collapsedProjects",
  );
  assert.deepEqual(parsed, ["bb.sidebar.sectionOrder", "bb.sidebar.collapsedProjects"]);
});

test("parseSyncedKeys falls back to the default set when blank", () => {
  assert.deepEqual(parseSyncedKeys(""), DEFAULT_SYNCED_KEYS);
  assert.deepEqual(parseSyncedKeys("   "), DEFAULT_SYNCED_KEYS);
});

// ---------------------------------------------------------------- applying ---

const snap = (values: Record<string, string>, updatedAt = 100): Snapshot => ({
  values,
  updatedAt,
  updatedBy: "other-device",
});

test("a remote key the device lacks is applied", () => {
  const plan = planApply({
    remote: snap({ "bb.sidebar.sectionOrder": '["a"]' }),
    local: {},
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, [{ key: "bb.sidebar.sectionOrder", value: '["a"]' }]);
});

test("a key that already matches is NOT reapplied", () => {
  const plan = planApply({
    remote: snap({ "bb.sidebar.sectionOrder": '["a"]' }),
    local: { "bb.sidebar.sectionOrder": '["a"]' },
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, []);
});

test("a remote key outside the synced set is ignored", () => {
  const plan = planApply({
    remote: snap({ "bb.sidebar.width": "420" }),
    local: {},
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, []);
});

test("no remote snapshot means nothing to apply", () => {
  assert.deepEqual(
    planApply({ remote: null, local: { "bb.sidebar.sectionOrder": '["a"]' }, syncedKeys: DEFAULT_SYNCED_KEYS }),
    [],
  );
});

// -------------------------------------------------------------- publishing ---

test("a locally changed key is published", () => {
  const plan = planPublish({
    local: { "bb.sidebar.sectionOrder": '["b"]' },
    lastKnown: { "bb.sidebar.sectionOrder": '["a"]' },
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, { "bb.sidebar.sectionOrder": '["b"]' });
});

test("an unchanged key is not published", () => {
  assert.equal(
    planPublish({
      local: { "bb.sidebar.sectionOrder": '["a"]' },
      lastKnown: { "bb.sidebar.sectionOrder": '["a"]' },
      syncedKeys: DEFAULT_SYNCED_KEYS,
    }),
    null,
  );
});

test("THE LOOP GUARD: a value we just applied is not republished", () => {
  // planApply hands back what it wrote; the caller folds it into lastKnown.
  const applied = planApply({
    remote: snap({ "bb.sidebar.sectionOrder": '["remote"]' }),
    local: {},
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  const lastKnown = Object.fromEntries(applied.map((a) => [a.key, a.value]));
  const local = { ...lastKnown };
  assert.equal(planPublish({ local, lastKnown, syncedKeys: DEFAULT_SYNCED_KEYS }), null);
});

test("a device-local key is never published even if it changed", () => {
  assert.equal(
    planPublish({
      local: { "bb.sidebar.width": "500" },
      lastKnown: { "bb.sidebar.width": "300" },
      syncedKeys: DEFAULT_SYNCED_KEYS,
    }),
    null,
  );
});

test("a key cleared locally is published as an explicit removal", () => {
  const plan = planPublish({
    local: {},
    lastKnown: { "bb.sidebar.hiddenPluginPanels": "[]" },
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, { "bb.sidebar.hiddenPluginPanels": null });
});

test("a removal is applied as a removal, not skipped", () => {
  const plan = planApply({
    remote: { values: { "bb.sidebar.hiddenPluginPanels": null }, updatedAt: 1, updatedBy: "x" },
    local: { "bb.sidebar.hiddenPluginPanels": '["a"]' },
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, [{ key: "bb.sidebar.hiddenPluginPanels", value: null }]);
});

test("several changed keys publish together in one write", () => {
  const plan = planPublish({
    local: { "bb.sidebar.sectionOrder": '["b"]', "bb.sidebar.collapsedProjects": '["p"]' },
    lastKnown: { "bb.sidebar.sectionOrder": '["a"]' },
    syncedKeys: DEFAULT_SYNCED_KEYS,
  });
  assert.deepEqual(plan, {
    "bb.sidebar.sectionOrder": '["b"]',
    "bb.sidebar.collapsedProjects": '["p"]',
  });
});

// ------------------------------------------------------------- seeding ---

test("SEEDING: a device with an existing arrangement seeds an empty server", () => {
  const seed = planSeed(
    { "bb.sidebar.hiddenPluginPanels": '["a"]', "bb.sidebar.sectionOrder": '["s"]' },
    DEFAULT_SYNCED_KEYS,
  );
  assert.deepEqual(seed, {
    "bb.sidebar.hiddenPluginPanels": '["a"]',
    "bb.sidebar.sectionOrder": '["s"]',
  });
});

test("seeding skips keys the device has no value for", () => {
  const seed = planSeed({ "bb.sidebar.sectionOrder": '["s"]' }, DEFAULT_SYNCED_KEYS);
  assert.deepEqual(Object.keys(seed ?? {}), ["bb.sidebar.sectionOrder"]);
});

test("a device with nothing set seeds nothing", () => {
  assert.equal(planSeed({}, DEFAULT_SYNCED_KEYS), null);
});

test("seeding never includes device-local keys", () => {
  const seed = planSeed(
    { "bb.sidebar.width": "500", "bb.sidebar.sectionOrder": '["s"]' },
    DEFAULT_SYNCED_KEYS,
  );
  assert.deepEqual(Object.keys(seed ?? {}), ["bb.sidebar.sectionOrder"]);
});
