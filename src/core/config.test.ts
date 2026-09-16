// Config: a missing or partly invalid file must degrade to defaults rather
// than taking the session down.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { normalizeConfig, readConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { configFile } from "./paths.ts";

let previousDir: string | undefined;

beforeEach(async () => {
  previousDir = process.env.PI_REMINDERS_DIR;
  process.env.PI_REMINDERS_DIR = await mkdtemp(join(tmpdir(), "pi-reminders-config-"));
});

afterEach(() => {
  if (previousDir === undefined) {
    delete process.env.PI_REMINDERS_DIR;
  } else {
    process.env.PI_REMINDERS_DIR = previousDir;
  }
});

describe("normalizeConfig", () => {
  it("returns defaults for a non-object", () => {
    for (const input of [null, undefined, 42, "nope", []]) {
      assert.deepEqual(normalizeConfig(input), DEFAULT_CONFIG);
    }
  });

  it("accepts a full valid config", () => {
    const input = {
      allDayFireHour: 7,
      statuslineStyle: "compact",
      statuslinePrefix: "rem",
      tickIntervalSeconds: 120,
      startupReportLimit: 10,
      desktopNotifications: false,
    };
    assert.deepEqual(normalizeConfig(input), input);
  });

  it("falls back per-key on invalid values", () => {
    const config = normalizeConfig({
      allDayFireHour: 99,
      statuslineStyle: "interpretive-dance",
      statuslinePrefix: 42,
      tickIntervalSeconds: 0,
      startupReportLimit: -1,
      desktopNotifications: "yes",
    });
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("keeps valid keys when others are invalid", () => {
    const config = normalizeConfig({ allDayFireHour: 6, statuslineStyle: "bogus" });
    assert.equal(config.allDayFireHour, 6);
    assert.equal(config.statuslineStyle, DEFAULT_CONFIG.statuslineStyle);
  });

  it("accepts the boundary fire hours and rejects what is outside", () => {
    assert.equal(normalizeConfig({ allDayFireHour: 0 }).allDayFireHour, 0);
    assert.equal(normalizeConfig({ allDayFireHour: 23 }).allDayFireHour, 23);
    assert.equal(normalizeConfig({ allDayFireHour: 24 }).allDayFireHour, DEFAULT_CONFIG.allDayFireHour);
    assert.equal(normalizeConfig({ allDayFireHour: 9.5 }).allDayFireHour, DEFAULT_CONFIG.allDayFireHour);
  });

  it("allows an empty statusline prefix", () => {
    assert.equal(normalizeConfig({ statuslinePrefix: "" }).statuslinePrefix, "");
  });
});

describe("readConfig", () => {
  it("uses defaults with no warning when the file is absent", async () => {
    const loaded = await readConfig();
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.equal(loaded.warning, undefined);
  });

  it("warns once and uses defaults when the file is not JSON", async () => {
    await writeFile(configFile(), "{ nope", "utf-8");
    const loaded = await readConfig();
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.match(loaded.warning as string, /not valid JSON/);
  });

  it("reads a valid file", async () => {
    await writeFile(configFile(), JSON.stringify({ allDayFireHour: 6, statuslineStyle: "compact" }), "utf-8");
    const loaded = await readConfig();
    assert.equal(loaded.config.allDayFireHour, 6);
    assert.equal(loaded.config.statuslineStyle, "compact");
    assert.equal(loaded.warning, undefined);
  });
});
