import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSnoozeArgs } from "./args.ts";

describe("parseSnoozeArgs", () => {
  it("splits an id and a duration", () => {
    const result = parseSnoozeArgs("a3f 45m");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.id, "a3f");
    assert.equal(result.value.target, "45m");
  });

  it("handles --until with a bare date", () => {
    const result = parseSnoozeArgs("a3f --until 2026-01-20");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.target, "2026-01-20");
  });

  it("rejoins --until with a date and time", () => {
    const result = parseSnoozeArgs("a3f --until 2026-01-20 09:00");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.id, "a3f");
    assert.equal(result.value.target, "2026-01-20 09:00");
  });

  it("rejects a missing id", () => {
    assert.equal(parseSnoozeArgs("").ok, false);
  });

  it("rejects a missing duration", () => {
    const result = parseSnoozeArgs("a3f");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("needs a duration"));
  });

  it("rejects --until with no value", () => {
    assert.equal(parseSnoozeArgs("a3f --until").ok, false);
  });
});
