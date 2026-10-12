#!/usr/bin/env node
import * as fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { controlFile, type ControlInfo } from "../core/control";
import { SCIENCE } from "../core/science";

/**
 * MCP server for Go Away. Run it as a stdio server from any MCP client:
 *
 *   { "command": "node", "args": ["/path/to/go-away/dist/mcp/server.js"] }
 *
 * It talks to the running desktop app over its localhost control API. By design it
 * cannot skip, shorten or postpone a break that is due.
 */

async function call(method: string, route: string, body?: unknown): Promise<unknown> {
  let info: ControlInfo;
  try {
    info = JSON.parse(fs.readFileSync(controlFile(), "utf8")) as ControlInfo;
  } catch {
    throw new Error("Go Away is not running (no control file). Start the desktop app first.");
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Go Away is not running (control API unreachable). Start the desktop app first.");
  }
  const json = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: (err as Error).message }],
});
const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

type Config = {
  calendar: { icsUrls: string[]; focusKeywords: string[] };
};

const server = new McpServer({ name: "go-away", version: "0.1.0" });

server.registerTool(
  "get_status",
  {
    description:
      "What Go Away is doing now: working / on_break / deferred (waiting for a meeting or call to end) / holding (focus session), when the next micro and long breaks are due, the current meeting or focus session, and live call signals.",
  },
  wrap(async () => call("GET", "/status")),
);

server.registerTool(
  "get_config",
  { description: "Current break configuration, plus any weaker change still waiting for the next completed break." },
  wrap(async () => call("GET", "/config")),
);

const section = z.record(z.string(), z.unknown());
server.registerTool(
  "update_config",
  {
    description: [
      "Change settings with a partial patch, e.g. {\"longBreak\": {\"intervalMinutes\": 50}}.",
      "Sections: microBreak {enabled, intervalMinutes, durationSeconds}; longBreak {enabled, intervalMinutes, durationMinutes};",
      "calendar {icsUrls, refreshMinutes, focusKeywords, soloEventsAreMeetings, ownerEmails};",
      "presence {slackUserToken, micInUseIsCall, inCallCommand, pollSeconds}; focus {holdLongBreaksUntilEnd, maxHoldMinutes};",
      "strictness {delayLooseningUntilNextBreak, idleResetMinutes}.",
      "Changes that make breaks rarer, shorter or disabled are queued until after the next completed break.",
    ].join(" "),
    inputSchema: {
      microBreak: section.optional(),
      longBreak: section.optional(),
      calendar: section.optional(),
      presence: section.optional(),
      focus: section.optional(),
      strictness: section.optional(),
    },
  },
  wrap(async (patch) => call("PATCH", "/config", patch)),
);

server.registerTool(
  "add_calendar",
  {
    description:
      "Connect a calendar by its secret iCal address. In Google Calendar: Settings → (your calendar) → Integrate calendar → 'Secret address in iCal format'. Meetings in it will never be interrupted by a break; events with a focus keyword in the title become focus sessions.",
    inputSchema: { icsUrl: z.string().url() },
  },
  wrap(async ({ icsUrl }) => {
    const { config } = (await call("GET", "/config")) as { config: Config };
    const icsUrls = [...new Set([...config.calendar.icsUrls, icsUrl])];
    await call("PATCH", "/config", { calendar: { icsUrls } });
    return call("POST", "/calendar/refresh");
  }),
);

server.registerTool(
  "remove_calendar",
  { description: "Disconnect a calendar feed.", inputSchema: { icsUrl: z.string() } },
  wrap(async ({ icsUrl }) => {
    const { config } = (await call("GET", "/config")) as { config: Config };
    return call("PATCH", "/config", { calendar: { icsUrls: config.calendar.icsUrls.filter((u) => u !== icsUrl) } });
  }),
);

server.registerTool(
  "get_schedule",
  {
    description:
      "Meetings and focus sessions Go Away knows about for the next N hours (from calendars and manually started sessions).",
    inputSchema: { hours: z.number().min(1).max(72).default(24) },
  },
  wrap(async ({ hours }) => call("GET", `/schedule?hours=${hours}`)),
);

server.registerTool(
  "start_focus_session",
  {
    description: [
      "Start (or schedule) a focus session. During it, long breaks wait for the session to end (bounded by focus.maxHoldMinutes); short eye breaks still happen.",
      "For recurring or shared focus time, prefer creating a calendar event whose title contains a focus keyword (default: 'Focus', 'Deep work', '🎯') — Go Away picks those up automatically.",
    ].join(" "),
    inputSchema: {
      minutes: z.number().min(1).max(600),
      title: z.string().optional(),
      startAt: z.string().optional().describe("ISO 8601 start time; omit to start now"),
    },
  },
  wrap(async (args) => call("POST", "/focus", args)),
);

server.registerTool(
  "end_focus_session",
  { description: "End the manually started focus session(s) running now. Does not skip any break." },
  wrap(async () => call("DELETE", "/focus")),
);

server.registerTool(
  "set_slack_token",
  {
    description:
      "Let Go Away see when you're in a Slack huddle, so a break never lands in the middle of one. Needs a Slack user token (xoxp-…) with the users.profile:read scope.",
    inputSchema: { token: z.string().regex(/^xox[pe]-/, "expected a Slack user token (xoxp-…)") },
  },
  wrap(async ({ token }) => call("PATCH", "/config", { presence: { slackUserToken: token } })),
);

server.registerTool(
  "get_break_history",
  {
    description: "Completed breaks over the last N days, with how long each one waited for a meeting or call.",
    inputSchema: { days: z.number().min(1).max(90).default(7) },
  },
  wrap(async ({ days }) => {
    const records = (await call("GET", `/history?days=${days}`)) as {
      kind: string;
      startedAt: number;
      endedAt: number;
      deferredMs: number;
    }[];
    const by = (k: string) => records.filter((r) => r.kind === k).length;
    return {
      days,
      microBreaks: by("micro"),
      longBreaks: by("long"),
      averageDeferralMinutes: records.length
        ? Math.round(records.reduce((a, r) => a + r.deferredMs, 0) / records.length / 6000) / 10
        : 0,
      records: records.map((r) => ({ ...r, startedAt: new Date(r.startedAt).toISOString() })),
    };
  }),
);

server.registerTool(
  "explain_break_science",
  { description: "The research behind Go Away's default break timings, with sources." },
  async () => ok(SCIENCE),
);

server.registerTool(
  "skip_break",
  {
    description:
      "There is no way to skip, shorten or postpone a break. Calling this only explains why, so the agent can tell the user.",
  },
  async () =>
    ok({
      skipped: false,
      message:
        "Breaks can't be skipped. They already wait for meetings and calls to end; once they start, they run to the end. Weaker settings apply only after the next completed break.",
    }),
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
