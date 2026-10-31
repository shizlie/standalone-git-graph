import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_SYNC_SETTINGS, sanitizeSyncSettings, StandaloneState } from "@/standalone/state";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sync settings", () => {
  test("default: repo on screen every minute, other repos off", () => {
    expect(DEFAULT_SYNC_SETTINGS).toEqual({ focusedSec: 60, othersMin: 0 });
  });

  test("clamps to off or a safe minimum", () => {
    expect(sanitizeSyncSettings({ focusedSec: 1, othersMin: -3 })).toEqual({
      focusedSec: 15,
      othersMin: 0
    });
    expect(sanitizeSyncSettings({ focusedSec: 0, othersMin: 0.2 })).toEqual({
      focusedSec: 0,
      othersMin: 0
    });
    expect(sanitizeSyncSettings(undefined)).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  test("persists across restarts and notifies listeners", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngg-state-"));
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    const a = new StandaloneState(file);
    const seen: unknown[] = [];
    a.onSyncSettings((s) => seen.push(s));
    a.setSyncSettings({ focusedSec: 120, othersMin: 15 });
    expect(seen).toEqual([{ focusedSec: 120, othersMin: 15 }]);
    expect(new StandaloneState(file).getSyncSettings()).toEqual({ focusedSec: 120, othersMin: 15 });
  });
});
