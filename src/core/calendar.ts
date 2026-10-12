import ical, { type Attendee, type CalendarResponse, type VEvent } from "node-ical";
import type { Config } from "./config";

export type EventKind = "meeting" | "focus";

export interface ScheduleEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  kind: EventKind;
  source: "calendar" | "manual";
}

const CONFERENCE_HINT = /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|slack\.com\/huddle|webex\.com|whereby\.com)/i;

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "val" in (v as object)) return String((v as { val: unknown }).val);
  return String(v);
}

function attendees(ev: VEvent): Attendee[] {
  if (!ev.attendee) return [];
  return Array.isArray(ev.attendee) ? ev.attendee : [ev.attendee];
}

function email(a: Attendee): string {
  return text(a).replace(/^mailto:/i, "").toLowerCase();
}

export function classify(ev: VEvent, title: string, cfg: Config["calendar"]): EventKind | null {
  if (ev.transparency === "TRANSPARENT") return null; // marked "free"
  if (ev.status === "CANCELLED") return null;

  const owners = cfg.ownerEmails.map((e) => e.toLowerCase());
  const people = attendees(ev);
  const me = people.find((a) => owners.includes(email(a)));
  if (me && typeof me === "object" && me.params?.PARTSTAT === "DECLINED") return null;

  const lower = title.toLowerCase();
  if (cfg.focusKeywords.some((k) => k && lower.includes(k.toLowerCase()))) return "focus";

  const others = people.filter((a) => !owners.includes(email(a)));
  const raw = ev as unknown as Record<string, unknown>;
  const hasConference =
    CONFERENCE_HINT.test(text(ev.location)) ||
    CONFERENCE_HINT.test(text(ev.description)) ||
    // node-ical drops the "X-" prefix from extension properties.
    Object.keys(raw).some((k) => /^(X-)?GOOGLE-CONFERENCE/i.test(k));
  if (others.length > (owners.length ? 0 : 1) || hasConference) return "meeting";
  return cfg.soloEventsAreMeetings ? "meeting" : null;
}

/** Turns a parsed iCal feed into the timed meetings and focus blocks within [from, to]. */
/** Google names a primary calendar's feed after its owner's email. */
export function feedOwner(data: CalendarResponse): string | null {
  const name = text(data.vcalendar?.["WR-CALNAME"]).trim();
  return /^[^@\s]+@[^@\s]+$/.test(name) ? name.toLowerCase() : null;
}

export function eventsFromIcs(data: CalendarResponse, cfg: Config["calendar"], from: Date, to: Date): ScheduleEvent[] {
  if (!cfg.ownerEmails.length) {
    const owner = feedOwner(data);
    if (owner) cfg = { ...cfg, ownerEmails: [owner] };
  }
  const out: ScheduleEvent[] = [];
  for (const [uid, comp] of Object.entries(data)) {
    if (uid === "vcalendar" || !comp || (comp as { type?: string }).type !== "VEVENT") continue;
    const ev = comp as VEvent;
    // Overrides of a recurring series are applied by expandRecurringEvent on the base event.
    if (ev.recurrenceid) continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue;
    }
    for (const inst of instances) {
      if (inst.isFullDay) continue;
      const title = text(inst.summary);
      const kind = classify(inst.event, title, cfg);
      if (!kind) continue;
      const start = new Date(inst.start);
      const end = new Date(inst.end);
      if (end <= from || start >= to) continue;
      out.push({ id: `${uid}@${start.toISOString()}`, title, start, end, kind, source: "calendar" });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export async function fetchCalendars(cfg: Config["calendar"], now = new Date()): Promise<ScheduleEvent[]> {
  const from = new Date(now.getTime() - 12 * 3600_000);
  const to = new Date(now.getTime() + 36 * 3600_000);
  const results = await Promise.allSettled(
    cfg.icsUrls.map(async (url) => {
      const res = await fetch(url.replace(/^webcal:/i, "https:"));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for calendar feed`);
      return eventsFromIcs(ical.sync.parseICS(await res.text()), cfg, from, to);
    }),
  );
  const errors = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
  if (errors.length && errors.length === results.length) throw errors[0];
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export const activeAt = (events: ScheduleEvent[], now: Date, kind: EventKind) =>
  events.find((e) => e.kind === kind && e.start <= now && now < e.end);

export const nextStart = (events: ScheduleEvent[], now: Date, kind: EventKind) =>
  events.find((e) => e.kind === kind && e.start > now);
