import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../src/core/config";
import type { ScheduleEvent } from "../src/core/calendar";
import { Scheduler, initialState, type TickInput } from "../src/core/scheduler";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 9, 0);
const free = { inCall: false, reasons: [] };

function ev(kind: "meeting" | "focus", startMin: number, endMin: number, title = kind): ScheduleEvent {
  return { id: `${kind}${startMin}`, title, kind, source: "calendar", start: new Date(T0 + startMin * MIN), end: new Date(T0 + endMin * MIN) };
}

function run(s: Scheduler, fromMin: number, toMin: number, input: Partial<TickInput> = {}, stepSec = 5) {
  const actions: { at: number; type: string; kind?: string }[] = [];
  for (let t = T0 + fromMin * MIN; t <= T0 + toMin * MIN; t += stepSec * 1000) {
    const a = s.tick({ now: t, config: defaultConfig(), calendar: [], presence: free, idleSeconds: 0, ...input });
    if (a.type === "start") actions.push({ at: (t - T0) / MIN, type: "start", kind: a.brk.kind });
    if (a.type === "end") actions.push({ at: (t - T0) / MIN, type: "end", kind: a.record.kind });
  }
  return actions;
}

describe("Scheduler", () => {
  it("fires a 20 s eye break every 20 minutes and a 5 min break every hour", () => {
    const s = new Scheduler(initialState(T0));
    const starts = run(s, 0, 61).filter((a) => a.type === "start");
    expect(starts.map((a) => [Math.round(a.at), a.kind])).toEqual([
      [20, "micro"],
      [40, "micro"],
      [60, "long"],
    ]);
  });

  it("never starts a break during a meeting and fires it the moment the meeting ends", () => {
    const s = new Scheduler(initialState(T0));
    const actions = run(s, 0, 50, { calendar: [ev("meeting", 15, 45)] });
    expect(actions.find((a) => a.type === "start")?.at).toBe(45);
    expect(s.status()?.phase).toBe("working");
  });

  it("reports the deferral reason while waiting", () => {
    const s = new Scheduler(initialState(T0));
    run(s, 0, 30, { calendar: [ev("meeting", 15, 45, "Standup")] });
    expect(s.status()).toMatchObject({ phase: "deferred", reason: 'in meeting "Standup"' });
  });

  it("defers for a Slack huddle or live microphone", () => {
    const s = new Scheduler(initialState(T0));
    const actions = run(s, 0, 25, { presence: { inCall: true, reasons: ["slack huddle"] } });
    expect(actions).toEqual([]);
    expect(s.status()?.reason).toBe("slack huddle");
  });

  it("does not start a break that would run into a meeting", () => {
    const s = new Scheduler(initialState(T0));
    // eye break due at 20:00, meeting at 20:10 → 20 s break would overlap
    const actions = run(s, 0, 21, { calendar: [ev("meeting", 20 + 1 / 6, 50)] });
    expect(actions.filter((a) => a.type === "start")).toEqual([]);
  });

  it("once started, a break runs to its end no matter what happens", () => {
    const s = new Scheduler(initialState(T0));
    run(s, 0, 20);
    expect(s.state.activeBreak?.kind).toBe("micro");
    // a call starts mid-break: the break still ends on time, not earlier
    const actions = run(s, 20, 21, { presence: { inCall: true, reasons: ["microphone in use"] } });
    expect(actions[0]).toMatchObject({ type: "end" });
    expect(actions[0].at).toBeGreaterThanOrEqual(20 + 20 / 60);
  });

  it("holds long breaks during a focus session but still gives eye breaks", () => {
    const s = new Scheduler(initialState(T0));
    const actions = run(s, 0, 95, { calendar: [ev("focus", 0, 90)] });
    const starts = actions.filter((a) => a.type === "start").map((a) => [Math.round(a.at), a.kind]);
    expect(starts).toContainEqual([61, "micro"]); // intervals count from the end of the previous break
    expect(starts).toContainEqual([90, "long"]);
    expect(starts.filter(([, k]) => k === "long")).toHaveLength(1);
  });

  it("caps how long a focus session can hold a long break", () => {
    const s = new Scheduler(initialState(T0));
    const config = mergeConfig(defaultConfig(), { focus: { maxHoldMinutes: 10 } });
    const actions = run(s, 0, 75, { calendar: [ev("focus", 0, 240)], config });
    expect(actions.find((a) => a.kind === "long" && a.type === "start")?.at).toBe(70);
  });

  it("pulls a long break forward so it ends before a meeting", () => {
    const s = new Scheduler(initialState(T0));
    const actions = run(s, 0, 60, { calendar: [ev("meeting", 50, 110)] });
    const long = actions.find((a) => a.kind === "long" && a.type === "start");
    expect(long!.at).toBeGreaterThanOrEqual(44);
    expect(long!.at).toBeLessThanOrEqual(45);
  });

  it("counts 5 idle minutes as a break, but not while on a call", () => {
    const s = new Scheduler(initialState(T0));
    run(s, 0, 59, { idleSeconds: 0 });
    run(s, 59, 59, { idleSeconds: 6 * 60 });
    expect(s.state.lastLongAt).toBe(T0 + 59 * MIN);

    const s2 = new Scheduler(initialState(T0));
    run(s2, 0, 59, { idleSeconds: 6 * 60, presence: { inCall: true, reasons: ["microphone in use"] } });
    expect(s2.state.lastLongAt).toBe(T0);
  });
});
