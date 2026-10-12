import type { Config } from "./config";
import { activeAt, nextStart, type ScheduleEvent } from "./calendar";
import type { PresenceSignal } from "./presence";

export type BreakKind = "micro" | "long";

export interface ActiveBreak {
  kind: BreakKind;
  startedAt: number;
  endsAt: number;
}

export interface BreakRecord {
  kind: BreakKind;
  startedAt: number;
  endedAt: number;
  /** How long the break waited for a meeting/call to finish. */
  deferredMs: number;
}

/** Everything the scheduler needs to survive an app restart (quitting is not a way out of a break). */
export interface SchedulerState {
  lastMicroAt: number;
  lastLongAt: number;
  activeBreak: ActiveBreak | null;
  deferredSince: number | null;
  manualFocus: ScheduleEvent[];
  history: BreakRecord[];
}

export interface TickInput {
  now: number;
  config: Config;
  calendar: ScheduleEvent[];
  presence: PresenceSignal;
  idleSeconds: number;
}

export type TickAction =
  | { type: "none" }
  | { type: "start"; brk: ActiveBreak }
  | { type: "end"; record: BreakRecord };

export type Phase = "working" | "deferred" | "holding" | "on_break";

export interface Status {
  phase: Phase;
  reason?: string;
  activeBreak: ActiveBreak | null;
  nextMicroAt: number | null;
  nextLongAt: number | null;
  focus: ScheduleEvent | null;
  meeting: ScheduleEvent | null;
  nextMeeting: ScheduleEvent | null;
}

const MIN = 60_000;
const HISTORY_LIMIT = 500;

export function initialState(now: number): SchedulerState {
  return { lastMicroAt: now, lastLongAt: now, activeBreak: null, deferredSince: null, manualFocus: [], history: [] };
}

export function breakDurationMs(kind: BreakKind, cfg: Config): number {
  return kind === "long" ? cfg.longBreak.durationMinutes * MIN : cfg.microBreak.durationSeconds * 1000;
}

export class Scheduler {
  private lastStatus: Status | null = null;

  constructor(public state: SchedulerState) {}

  allEvents(calendar: ScheduleEvent[], now: number): ScheduleEvent[] {
    this.state.manualFocus = this.state.manualFocus.filter((e) => e.end.getTime() > now);
    return [...calendar, ...this.state.manualFocus].sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  startFocus(now: number, minutes: number, title = "Focus session", startAt = now): ScheduleEvent {
    const ev: ScheduleEvent = {
      id: `manual-${startAt}-${this.state.manualFocus.length}`,
      title,
      start: new Date(startAt),
      end: new Date(startAt + minutes * MIN),
      kind: "focus",
      source: "manual",
    };
    this.state.manualFocus.push(ev);
    return ev;
  }

  /** Ends manual focus sessions. Calendar focus blocks end when the event does. */
  endFocus(now: number): number {
    const before = this.state.manualFocus.length;
    this.state.manualFocus = this.state.manualFocus.filter((e) => e.start.getTime() > now);
    return before - this.state.manualFocus.length;
  }

  /** Time away from the computer (sleep, lock, idle) that was long enough counts as a long break. */
  markAway(from: number, to: number, cfg: Config): void {
    if (this.state.activeBreak) return;
    if (to - from >= cfg.strictness.idleResetMinutes * MIN) {
      this.state.lastLongAt = Math.max(this.state.lastLongAt, to);
      this.state.lastMicroAt = Math.max(this.state.lastMicroAt, to);
      this.state.deferredSince = null;
    }
  }

  tick(input: TickInput): TickAction {
    const { now, config: cfg, presence } = input;
    const s = this.state;
    const events = this.allEvents(input.calendar, now);
    const at = new Date(now);
    const meeting = activeAt(events, at, "meeting") ?? null;
    const focus = activeAt(events, at, "focus") ?? null;
    const nextMeeting = nextStart(events, at, "meeting") ?? null;
    const nextMicroAt = cfg.microBreak.enabled ? s.lastMicroAt + cfg.microBreak.intervalMinutes * MIN : null;
    const nextLongAt = cfg.longBreak.enabled ? s.lastLongAt + cfg.longBreak.intervalMinutes * MIN : null;
    const status = (phase: Phase, reason?: string): void => {
      this.lastStatus = { phase, reason, activeBreak: s.activeBreak, nextMicroAt, nextLongAt, focus, meeting, nextMeeting };
    };

    // 1. A running break only ends when its time is up. Nothing else can end it.
    if (s.activeBreak) {
      if (now < s.activeBreak.endsAt) {
        status("on_break");
        return { type: "none" };
      }
      const brk = s.activeBreak;
      const record: BreakRecord = {
        kind: brk.kind,
        startedAt: brk.startedAt,
        endedAt: now,
        deferredMs: s.deferredSince ? Math.max(0, brk.startedAt - s.deferredSince) : 0,
      };
      s.history = [...s.history, record].slice(-HISTORY_LIMIT);
      s.lastMicroAt = now;
      if (brk.kind === "long") s.lastLongAt = now;
      s.activeBreak = null;
      s.deferredSince = null;
      status("working");
      return { type: "end", record };
    }

    // 2. Being away long enough is a break in itself (sitting silently in a call is not).
    if (!meeting && !presence.inCall && input.idleSeconds * 1000 >= cfg.strictness.idleResetMinutes * MIN) {
      this.markAway(now - input.idleSeconds * 1000, now, cfg);
      status("working", "away from computer");
      return { type: "none" };
    }

    // 3. What is due?
    const longDue = nextLongAt !== null && now >= nextLongAt;
    const microDue = nextMicroAt !== null && now >= nextMicroAt;

    // Pull a long break forward so it ends right before a meeting instead of landing in it.
    const longMs = breakDurationMs("long", cfg);
    const pullForward =
      !longDue &&
      !meeting &&
      !presence.inCall &&
      nextLongAt !== null &&
      nextMeeting !== null &&
      nextMeeting.start.getTime() - now <= longMs + MIN &&
      nextMeeting.start.getTime() - now >= longMs &&
      nextLongAt < nextMeeting.end.getTime() &&
      now - s.lastLongAt >= (cfg.longBreak.intervalMinutes * MIN) / 2;

    let kind: BreakKind | null = longDue || pullForward ? "long" : microDue ? "micro" : null;
    if (!kind) {
      status("working");
      return { type: "none" };
    }

    // 4. Never interrupt a meeting or a call; wait until it is over.
    const durationMs = breakDurationMs(kind, cfg);
    const meetingSoon =
      !pullForward && nextMeeting !== null && nextMeeting.start.getTime() < now + durationMs;
    const busyReason = meeting
      ? `in meeting "${meeting.title}"`
      : presence.inCall
        ? presence.reasons.join(", ")
        : meetingSoon
          ? `meeting "${nextMeeting!.title}" starts before the break would end`
          : null;
    if (busyReason) {
      s.deferredSince ??= now;
      status("deferred", busyReason);
      return { type: "none" };
    }

    // 5. Focus sessions hold long breaks until they end (bounded), micro breaks still happen.
    if (kind === "long" && focus && cfg.focus.holdLongBreaksUntilEnd && !pullForward) {
      const heldFor = now - (nextLongAt ?? now);
      if (heldFor < cfg.focus.maxHoldMinutes * MIN) {
        if (!microDue) {
          status("holding", `focus session "${focus.title}" until ${focus.end.toISOString()}`);
          return { type: "none" };
        }
        kind = "micro";
      }
    }

    const brk: ActiveBreak = { kind, startedAt: now, endsAt: now + breakDurationMs(kind, cfg) };
    s.activeBreak = brk;
    status("on_break");
    return { type: "start", brk };
  }

  status(): Status | null {
    return this.lastStatus;
  }
}
