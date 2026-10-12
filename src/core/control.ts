import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { homeDir } from "./config";
import type { ConfigChangeResult, Engine } from "./engine";

/**
 * Localhost-only control API used by the MCP server. Its address and a random bearer
 * token are written to ~/.go-away/control.json (mode 0600).
 *
 * There is intentionally no endpoint to skip, shorten or postpone a break.
 */
export const controlFile = () => path.join(homeDir(), "control.json");

export interface ControlInfo {
  port: number;
  token: string;
  pid: number;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function startControlServer(engine: Engine): Promise<http.Server> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401, { error: "unauthorized" });

    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "GET /status":
          return send(200, engine.status());
        case "GET /health":
          return send(200, engine.health());
        case "GET /config":
          return send(200, { config: engine.redactedConfig(), pending: engine.redactedConfig(engine.pendingConfig) });
        case "PATCH /config":
          return send(200, redact(engine.updateConfig((await readBody(req)) as never)));
        case "POST /calendars": {
          const { url: feed } = (await readBody(req)) as { url?: string };
          if (!feed) return send(400, { error: "url is required" });
          const result = redact(engine.addCalendar(feed));
          await engine.refreshCalendar();
          return send(200, { ...result, events: engine.upcoming(24).length, error: engine.calendarError });
        }
        case "DELETE /calendars":
          return send(200, redact(engine.removeCalendar(Number(url.searchParams.get("index")))));
        case "GET /schedule":
          return send(200, engine.upcoming(Number(url.searchParams.get("hours") ?? 24)));
        case "POST /calendar/refresh":
          await engine.refreshCalendar();
          return send(200, { events: engine.upcoming(24), error: engine.calendarError });
        case "GET /history":
          return send(200, engine.history(Number(url.searchParams.get("days") ?? 7)));
        case "POST /focus": {
          const body = (await readBody(req)) as { minutes?: number; title?: string; startAt?: string };
          const minutes = Number(body.minutes);
          if (!(minutes > 0 && minutes <= 600)) return send(400, { error: "minutes must be between 1 and 600" });
          const startAt = body.startAt ? Date.parse(body.startAt) : undefined;
          if (startAt !== undefined && Number.isNaN(startAt)) return send(400, { error: "startAt is not a date" });
          return send(200, engine.startFocus(minutes, body.title, startAt));
        }
        case "DELETE /focus":
          return send(200, { ended: engine.endFocus() });
        default:
          return send(404, { error: `no route ${route}` });
      }
    } catch (err) {
      return send(400, { error: (err as Error).message });
    }
  });

  const redact = (r: ConfigChangeResult) => ({
    message: r.message,
    config: engine.redactedConfig(r.config),
    pending: engine.redactedConfig(r.pending),
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      fs.mkdirSync(homeDir(), { recursive: true });
      const info: ControlInfo = { port, token, pid: process.pid };
      fs.writeFileSync(controlFile(), JSON.stringify(info), { mode: 0o600 });
      resolve(server);
    });
  });
}
