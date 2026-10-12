import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startControlServer } from "../src/core/control";
import { Engine } from "../src/core/engine";

// End to end: MCP client → stdio MCP server (dist/) → control API → engine.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "go-away-"));
process.env.GO_AWAY_HOME = home;

let engine: Engine;
let server: Server;
let client: Client;

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const json = (r: unknown) => JSON.parse(text(r));

beforeAll(async () => {
  engine = new Engine({
    idleSeconds: () => 0,
    fetchCalendar: async () => [],
    detectPresence: async () => ({ inCall: false, reasons: [] }),
  });
  server = await startControlServer(engine);
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "dist", "mcp", "server.js")],
      env: { ...process.env, GO_AWAY_HOME: home } as Record<string, string>,
    }),
  );
});

afterAll(async () => {
  await client?.close();
  server?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("lists the tools, and none of them can skip a break", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["get_status", "update_config", "add_calendar", "start_focus_session", "set_slack_token"]),
    );
    const skip = json(await client.callTool({ name: "skip_break", arguments: {} }));
    expect(skip.skipped).toBe(false);
  });

  it("applies stricter settings right away", async () => {
    const r = json(await client.callTool({ name: "update_config", arguments: { longBreak: { intervalMinutes: 45 } } }));
    expect(r.pending).toBeNull();
    expect(engine.config.longBreak.intervalMinutes).toBe(45);
    expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).longBreak.intervalMinutes).toBe(45);
  });

  it("queues weaker settings until the next completed break", async () => {
    const r = json(await client.callTool({ name: "update_config", arguments: { longBreak: { enabled: false } } }));
    expect(r.pending.longBreak.enabled).toBe(false);
    expect(engine.config.longBreak.enabled).toBe(true);
  });

  it("starts and ends a focus session", async () => {
    const ev = json(await client.callTool({ name: "start_focus_session", arguments: { minutes: 50, title: "Write spec" } }));
    expect(ev.title).toBe("Write spec");
    const schedule = json(await client.callTool({ name: "get_schedule", arguments: {} }));
    expect(schedule.map((e: { title: string }) => e.title)).toContain("Write spec");
    expect(json(await client.callTool({ name: "end_focus_session", arguments: {} })).ended).toBe(1);
  });

  it("rejects a non-Slack token", async () => {
    const r = await client.callTool({ name: "set_slack_token", arguments: { token: "hunter2" } });
    expect(r.isError).toBe(true);
  });

  it("never echoes secrets back to the assistant", async () => {
    await client.callTool({ name: "set_slack_token", arguments: { token: "xoxp-secret-123" } });
    await client.callTool({ name: "add_calendar", arguments: { icsUrl: "https://calendar.google.com/calendar/ical/me/private-abc123/basic.ics" } });
    const out = text(await client.callTool({ name: "get_config", arguments: {} }));
    expect(out).not.toContain("xoxp-secret-123");
    expect(out).not.toContain("private-abc123");
    expect(out).toContain("#0: calendar.google.com");
  });

  it("reports setup health", async () => {
    const health = json(await client.callTool({ name: "check_setup", arguments: {} }));
    expect(health.checks.map((c: { check: string }) => c.check)).toEqual(["calendar", "call detection", "slack huddles"]);
  });

  it("explains the science", async () => {
    expect(text(await client.callTool({ name: "explain_break_science", arguments: {} }))).toContain("20-20-20");
  });
});
