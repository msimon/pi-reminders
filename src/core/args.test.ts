import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRemindArgs, parseSnoozeArgs } from "./args.ts";

describe("parseRemindArgs", () => {
  it("splits a bare date from the message", () => {
    const result = parseRemindArgs("2026-01-20 renew the domain");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.when, "2026-01-20");
    assert.equal(result.value.message, "renew the domain");
    assert.equal(result.value.recurrence, undefined);
  });

  it("keeps a date and a time together as one when", () => {
    const result = parseRemindArgs("2026-01-20 09:00 standup notes");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.when, "2026-01-20 09:00");
    assert.equal(result.value.message, "standup notes");
  });

  it("does not swallow a message that merely starts with digits", () => {
    const result = parseRemindArgs("2h 3 things to review");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.when, "2h");
    assert.equal(result.value.message, "3 things to review");
  });

  it("takes a relative offset as when", () => {
    const result = parseRemindArgs("45m take a break");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.when, "45m");
  });

  it("extracts --every between the date and the message", () => {
    const result = parseRemindArgs("2026-03-14 --every year Sarah's birthday");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.when, "2026-03-14");
    assert.equal(result.value.recurrence, "year");
    assert.equal(result.value.message, "Sarah's birthday");
  });

  it("extracts --every after a date and time", () => {
    const result = parseRemindArgs(
      "2026-01-05 09:00 --every week submit timesheet",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.when, "2026-01-05 09:00");
    assert.equal(result.value.recurrence, "week");
    assert.equal(result.value.message, "submit timesheet");
  });

  it("extracts --every from the end of the line", () => {
    const result = parseRemindArgs(
      "2026-01-31 reconcile invoices --every month",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recurrence, "month");
    assert.equal(result.value.message, "reconcile invoices");
  });

  it("collapses runs of whitespace in the message", () => {
    const result = parseRemindArgs("2026-01-20   call    the   accountant  ");
    assert.equal(result.ok && result.value.message, "call the accountant");
  });

  it("rejects an empty invocation with usage", () => {
    const result = parseRemindArgs("");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("/remind <when>"));
  });

  it("rejects a date with no message", () => {
    const result = parseRemindArgs("2026-01-20");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("needs a message"));
  });

  it("rejects an unknown recurrence unit", () => {
    const result = parseRemindArgs("2026-01-20 --every fortnight pay rent");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("day, week, month, year"));
  });

  it("rejects --every with no value", () => {
    const result = parseRemindArgs("2026-01-20 pay rent --every");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("needs a value"));
  });

  it("leaves when unresolved for parseWhen to validate", () => {
    // Nonsense dates are a parseWhen concern; this layer only splits tokens.
    const result = parseRemindArgs("someday do the thing");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.when, "someday");
  });
});

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
