import { execFile, exec } from "node:child_process";
import type { Config } from "./config";

export interface PresenceSignal {
  inCall: boolean;
  /** Human readable reasons, e.g. ["slack huddle", "microphone in use"]. */
  reasons: string[];
}

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

/**
 * Slack exposes your huddle state on your own profile (`huddle_state: "in_a_huddle"`).
 * Needs a user token with the users.profile:read scope.
 */
export async function slackHuddle(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl("https://slack.com/api/users.profile.get", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: string; profile?: { huddle_state?: string } };
  if (!body.ok) throw new Error(`Slack: ${body.error ?? "request failed"}`);
  return body.profile?.huddle_state === "in_a_huddle";
}

/** Parses `reg query …\ConsentStore\microphone /s`: an app with LastUsedTimeStop = 0 is recording now. */
export function windowsMicInUse(regOutput: string): boolean {
  let started = false;
  for (const line of regOutput.split(/\r?\n/)) {
    const m = line.trim().match(/^LastUsedTime(Start|Stop)\s+REG_QWORD\s+0x([0-9a-f]+)/i);
    if (!m) continue;
    if (m[1] === "Start") started = BigInt(`0x${m[2]}`) > 0n;
    else if (started && BigInt(`0x${m[2]}`) === 0n) return true;
  }
  return false;
}

export async function micInUse(platform = process.platform): Promise<{ inUse: boolean; detail: string } | null> {
  if (platform === "linux") {
    const out = await run("pactl", ["list", "short", "source-outputs"]);
    return { inUse: out.trim().length > 0, detail: "microphone in use" };
  }
  if (platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
    return { inUse: windowsMicInUse(await run("reg", ["query", key, "/s"])), detail: "microphone in use" };
  }
  if (platform === "darwin") {
    // macOS has no CLI for "mic is live". Zoom spawns CptHost only while in a meeting;
    // Slack huddles come from the Slack signal, and anything else from presence.inCallCommand.
    const out = await run("pgrep", ["-x", "CptHost"]);
    return { inUse: out.trim().length > 0, detail: "zoom meeting" };
  }
  return null;
}

function commandSucceeds(command: string): Promise<boolean> {
  return new Promise((resolve) => exec(command, { timeout: 5000, windowsHide: true }, (err) => resolve(!err)));
}

export async function detectPresence(cfg: Config["presence"]): Promise<PresenceSignal> {
  const reasons: string[] = [];
  const checks: Promise<void>[] = [];
  if (cfg.slackUserToken) {
    checks.push(
      slackHuddle(cfg.slackUserToken)
        .then((huddle) => void (huddle && reasons.push("slack huddle")))
        .catch(() => undefined),
    );
  }
  if (cfg.micInUseIsCall) {
    checks.push(micInUse().then((m) => void (m?.inUse && reasons.push(m.detail))));
  }
  if (cfg.inCallCommand) {
    checks.push(commandSucceeds(cfg.inCallCommand).then((ok) => void (ok && reasons.push("custom call check"))));
  }
  await Promise.all(checks);
  return { inCall: reasons.length > 0, reasons };
}
