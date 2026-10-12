import { describe, expect, it } from "vitest";
import { parseMacHelper, setSlackBreakStatus, slackHuddle, windowsMicInUse } from "../src/core/presence";

describe("presence", () => {
  it("reads Slack huddle state from the user profile", async () => {
    const fake = (state: string) =>
      (async () => new Response(JSON.stringify({ ok: true, profile: { huddle_state: state } }))) as typeof fetch;
    expect(await slackHuddle("xoxp-1", fake("in_a_huddle"))).toBe(true);
    expect(await slackHuddle("xoxp-1", fake("default_unset"))).toBe(false);
  });

  it("surfaces Slack errors", async () => {
    const fake = (async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }))) as typeof fetch;
    await expect(slackHuddle("xoxp-1", fake)).rejects.toThrow("invalid_auth");
  });

  it("detects a live microphone from the Windows consent store", () => {
    const idle = `HKEY_CURRENT_USER\\...\\microphone\\NonPackaged\\C:#Zoom#Zoom.exe
    LastUsedTimeStart    REG_QWORD    0x1d9c0a1b2c3d4e5
    LastUsedTimeStop    REG_QWORD    0x1d9c0a1b2c3d4f0`;
    const live = `${idle}
HKEY_CURRENT_USER\\...\\microphone\\NonPackaged\\C:#Slack#slack.exe
    LastUsedTimeStart    REG_QWORD    0x1d9c0a1b2c3d4e5
    LastUsedTimeStop    REG_QWORD    0x0`;
    expect(windowsMicInUse(idle)).toBe(false);
    expect(windowsMicInUse(live)).toBe(true);
  });

  it("reads the macOS helper output and ignores always-listening system apps", () => {
    const ignore = ["com.apple.corespeechd"];
    expect(parseMacHelper('{"mic":true,"micApps":["com.google.Chrome"],"camera":true}', ignore)).toEqual({
      mic: true,
      camera: true,
      micApps: ["com.google.Chrome"],
    });
    expect(parseMacHelper('{"mic":true,"micApps":["com.apple.corespeechd"],"camera":false}', ignore)?.mic).toBe(false);
    // macOS 13 and older: no per-app list, trust the device flag
    expect(parseMacHelper('{"mic":true,"micApps":[],"camera":false}', ignore)?.mic).toBe(true);
    expect(parseMacHelper("garbage", ignore)).toBeNull();
  });

  it("sets a Slack break status only when no status is set", async () => {
    const calls: string[] = [];
    const fake = (status: string) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${String(url).split("/").pop()} ${init?.body ?? ""}`);
        return new Response(JSON.stringify({ ok: true, profile: { status_text: status } }));
      }) as typeof fetch;
    expect(await setSlackBreakStatus("xoxp-1", 1_800_000_000_000, fake(""))).toBe(true);
    expect(calls[1]).toContain('"status_expiration":1800000000');
    calls.length = 0;
    expect(await setSlackBreakStatus("xoxp-1", 1_800_000_000_000, fake("In a meeting"))).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
