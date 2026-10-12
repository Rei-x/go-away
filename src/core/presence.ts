import { execFile, exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Config, homeDir } from "./config";

export interface PresenceSignal {
  inCall: boolean;
  /** Human readable reasons, e.g. ["slack huddle", "microphone in use"]. */
  reasons: string[];
  /** Diagnostics for the MCP health check. */
  device?: DeviceUse | null;
  slackError?: string | null;
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

export interface DeviceUse {
  mic: boolean;
  camera: boolean;
  /** Apps holding the microphone, when the OS tells us (macOS 14+). */
  micApps: string[];
  method: string;
}

const MAC_HELPER_SOURCE = path.join(__dirname, "..", "..", "native", "macos", "presence.swift");
const macHelperPath = () => path.join(homeDir(), "bin", "go-away-presence");
let macHelper: Promise<string | null> | null = null;
export let macHelperError: string | null = null;

/** Compiles the CoreAudio/CoreMediaIO helper once (needs Xcode Command Line Tools). */
function ensureMacHelper(): Promise<string | null> {
  macHelper ??= new Promise((resolve) => {
    const out = macHelperPath();
    try {
      if (fs.statSync(out).mtimeMs >= fs.statSync(MAC_HELPER_SOURCE).mtimeMs) return resolve(out);
    } catch {
      /* not built yet */
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFile("xcrun", ["swiftc", "-O", "-o", out, MAC_HELPER_SOURCE], { timeout: 180_000 }, (err, _o, stderr) => {
      if (err) {
        macHelperError = `could not build the mic/camera helper (install Xcode Command Line Tools: xcode-select --install): ${stderr || err.message}`.slice(0, 500);
        macHelper = null; // retry on a later poll
        return resolve(null);
      }
      macHelperError = null;
      resolve(out);
    });
  });
  return macHelper;
}

export function parseMacHelper(stdout: string, ignore: string[]): Omit<DeviceUse, "method"> | null {
  try {
    const r = JSON.parse(stdout) as { mic: boolean; micApps: string[]; camera: boolean };
    const micApps = r.micApps.filter((a) => !ignore.includes(a));
    // With an app list (macOS 14+) the ignore list decides; otherwise trust the device flag.
    const mic = r.micApps.length ? micApps.length > 0 : r.mic;
    return { mic, camera: r.camera, micApps };
  } catch {
    return null;
  }
}

export async function deviceUse(
  cfg: Pick<Config["presence"], "ignoreMicApps">,
  platform = process.platform,
): Promise<DeviceUse | null> {
  if (platform === "linux") {
    const out = await run("pactl", ["list", "short", "source-outputs"]);
    return { mic: out.trim().length > 0, camera: false, micApps: [], method: "pactl" };
  }
  if (platform === "win32") {
    const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore";
    const [mic, cam] = await Promise.all([
      run("reg", ["query", `${base}\\microphone`, "/s"]),
      run("reg", ["query", `${base}\\webcam`, "/s"]),
    ]);
    return { mic: windowsMicInUse(mic), camera: windowsMicInUse(cam), micApps: [], method: "consent store" };
  }
  if (platform === "darwin") {
    const helper = await ensureMacHelper();
    if (helper) {
      const parsed = parseMacHelper(await run(helper, []), cfg.ignoreMicApps);
      if (parsed) return { ...parsed, method: "coreaudio" };
    }
    // Fallback without the helper: Zoom spawns CptHost only while in a meeting.
    const zoom = (await run("pgrep", ["-x", "CptHost"])).trim().length > 0;
    return { mic: zoom, camera: false, micApps: zoom ? ["zoom"] : [], method: "zoom process only" };
  }
  return null;
}

function commandSucceeds(command: string): Promise<boolean> {
  return new Promise((resolve) => exec(command, { timeout: 5000, windowsHide: true }, (err) => resolve(!err)));
}

export async function detectPresence(cfg: Config["presence"]): Promise<PresenceSignal> {
  const reasons: string[] = [];
  const checks: Promise<void>[] = [];
  let slackError: string | null = null;
  if (cfg.slackUserToken) {
    checks.push(
      slackHuddle(cfg.slackUserToken)
        .then((huddle) => void (huddle && reasons.push("slack huddle")))
        .catch((err: Error) => void (slackError = err.message)),
    );
  }
  let device: DeviceUse | null = null;
  if (cfg.micInUseIsCall || cfg.cameraInUseIsCall) {
    checks.push(
      deviceUse(cfg).then((d) => {
        device = d;
        if (!d) return;
        if (cfg.micInUseIsCall && d.mic) reasons.push(`microphone in use${d.micApps.length ? ` (${d.micApps.join(", ")})` : ""}`);
        if (cfg.cameraInUseIsCall && d.camera) reasons.push("camera in use");
      }),
    );
  }
  if (cfg.inCallCommand) {
    checks.push(commandSucceeds(cfg.inCallCommand).then((ok) => void (ok && reasons.push("custom call check"))));
  }
  await Promise.all(checks);
  return { inCall: reasons.length > 0, reasons, device, slackError };
}

/**
 * Shows "On a break" in Slack until the break ends (Slack clears it at `status_expiration`).
 * Leaves an existing status alone. Needs users.profile:read and users.profile:write.
 */
export async function setSlackBreakStatus(
  token: string,
  endsAt: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" };
  const current = (await (await fetchImpl("https://slack.com/api/users.profile.get", { headers })).json()) as {
    ok: boolean;
    error?: string;
    profile?: { status_text?: string; status_emoji?: string };
  };
  if (!current.ok) throw new Error(`Slack: ${current.error ?? "request failed"}`);
  if (current.profile?.status_text || current.profile?.status_emoji) return false;
  const res = (await (
    await fetchImpl("https://slack.com/api/users.profile.set", {
      method: "POST",
      headers,
      body: JSON.stringify({
        profile: {
          status_text: "On a break, back soon",
          status_emoji: ":coffee:",
          status_expiration: Math.ceil(endsAt / 1000),
        },
      }),
    })
  ).json()) as { ok: boolean; error?: string };
  if (!res.ok) throw new Error(`Slack: ${res.error ?? "request failed"}`);
  return true;
}
