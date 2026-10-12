import { describe, expect, it } from "vitest";
import { defaultConfig, isLoosening, mergeConfig } from "../src/core/config";

describe("config", () => {
  it("merges partial patches per section", () => {
    const c = mergeConfig(defaultConfig(), { longBreak: { intervalMinutes: 50 } });
    expect(c.longBreak).toEqual({ enabled: true, intervalMinutes: 50, durationMinutes: 5 });
    expect(c.microBreak.intervalMinutes).toBe(20);
  });

  it("rejects out-of-range values", () => {
    expect(() => mergeConfig(defaultConfig(), { microBreak: { durationSeconds: 1 } })).toThrow();
  });

  it.each([
    [{ longBreak: { enabled: false } }, true],
    [{ longBreak: { intervalMinutes: 90 } }, true],
    [{ microBreak: { durationSeconds: 10 } }, true],
    [{ focus: { maxHoldMinutes: 180 } }, true],
    [{ strictness: { delayLooseningUntilNextBreak: false } }, true],
    [{ longBreak: { intervalMinutes: 45 } }, false],
    [{ longBreak: { durationMinutes: 10 } }, false],
    [{ calendar: { icsUrls: ["https://example.com/a.ics"] } }, false],
  ])("isLoosening(%j) = %s", (patch, expected) => {
    expect(isLoosening(defaultConfig(), mergeConfig(defaultConfig(), patch))).toBe(expected);
  });
});
