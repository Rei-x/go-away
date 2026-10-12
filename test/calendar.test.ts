import ical from "node-ical";
import { describe, expect, it } from "vitest";
import { eventsFromIcs, feedOwner } from "../src/core/calendar";
import { defaultConfig, mergeConfig } from "../src/core/config";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
X-WR-CALNAME:me@example.com
BEGIN:VEVENT
UID:standup
DTSTART:20261012T090000Z
DTEND:20261012T091500Z
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:Standup
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:ana@example.com
END:VEVENT
BEGIN:VEVENT
UID:focus
DTSTART:20261012T100000Z
DTEND:20261012T113000Z
SUMMARY:🎯 Deep work on parser
END:VEVENT
BEGIN:VEVENT
UID:lunch
DTSTART:20261012T120000Z
DTEND:20261012T130000Z
SUMMARY:Lunch
END:VEVENT
BEGIN:VEVENT
UID:free
DTSTART:20261012T140000Z
DTEND:20261012T150000Z
SUMMARY:Optional talk
TRANSP:TRANSPARENT
ATTENDEE:mailto:me@example.com
ATTENDEE:mailto:bo@example.com
END:VEVENT
BEGIN:VEVENT
UID:declined
DTSTART:20261012T150000Z
DTEND:20261012T160000Z
SUMMARY:Sync I declined
ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@example.com
END:VEVENT
BEGIN:VEVENT
UID:call
DTSTART:20261012T160000Z
DTEND:20261012T163000Z
SUMMARY:1:1
LOCATION:https://meet.google.com/abc-defg-hij
END:VEVENT
BEGIN:VEVENT
UID:allday
DTSTART;VALUE=DATE:20261012
DTEND;VALUE=DATE:20261013
SUMMARY:Conference
END:VEVENT
BEGIN:VEVENT
UID:locked
DTSTART:20261012T103000Z
DTEND:20261012T143000Z
SUMMARY:NO MEETING ZONE!!! Locked-in
END:VEVENT
END:VCALENDAR`;

describe("calendar", () => {
  const from = new Date("2026-10-12T00:00:00Z");
  const to = new Date("2026-10-13T23:59:00Z");
  const cfg = mergeConfig(defaultConfig(), { calendar: { ownerEmails: ["me@example.com"] } }).calendar;
  const events = eventsFromIcs(ical.sync.parseICS(ICS), cfg, from, to);
  const titles = events.map((e) => `${e.kind}:${e.title}@${e.start.toISOString().slice(5, 16)}`);

  it("expands recurring meetings", () => {
    expect(titles).toContain("meeting:Standup@10-12T09:00");
    expect(titles).toContain("meeting:Standup@10-13T09:00");
  });

  it("treats focus-keyword events as focus sessions", () => {
    expect(titles).toContain("focus:🎯 Deep work on parser@10-12T10:00");
  });

  it("counts video-call links as meetings", () => {
    expect(titles).toContain("meeting:1:1@10-12T16:00");
  });

  it("skips solo blocks, free time, declined meetings and all-day events", () => {
    expect(titles.join()).not.toMatch(/Lunch|Optional|declined|Conference/);
  });

  it("can treat solo blocks as meetings", () => {
    const strict = { ...cfg, soloEventsAreMeetings: true };
    const all = eventsFromIcs(ical.sync.parseICS(ICS), strict, from, to);
    expect(all.map((e) => e.title)).toContain("Lunch");
  });

  it("treats Google 'no meeting' focus blocks as focus sessions", () => {
    expect(titles).toContain("focus:NO MEETING ZONE!!! Locked-in@10-12T10:30");
  });

  it("detects the owner of a Google feed, so declined meetings are skipped without setup", () => {
    const data = ical.sync.parseICS(ICS);
    expect(feedOwner(data)).toBe("me@example.com");
    const auto = eventsFromIcs(data, defaultConfig().calendar, from, to).map((e) => e.title);
    expect(auto).not.toContain("Sync I declined");
    expect(auto).toContain("Standup");
  });
});
