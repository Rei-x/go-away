import { describe, expect, it } from "vitest";
import { slackHuddle, windowsMicInUse } from "../src/core/presence";

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
});
