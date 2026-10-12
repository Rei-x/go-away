import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

/**
 * Defaults are chosen from the break research summarised in docs/SCIENCE.md:
 * - micro break: 20 s every 20 min (the "20-20-20" eye rule, AAO; Talens-Estarelles et al. 2023)
 * - long break: 5 min every hour (NIOSH supplementary-break studies, Galinsky et al. 2000, 2007)
 */
export const ConfigSchema = z.object({
  microBreak: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().min(5).max(120).default(20),
      durationSeconds: z.number().min(10).max(300).default(20),
    })
    .prefault({}),
  longBreak: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().min(15).max(240).default(60),
      durationMinutes: z.number().min(1).max(30).default(5),
    })
    .prefault({}),
  /** How the app reads your schedule. */
  calendar: z
    .object({
      /** Secret iCal addresses (Google Calendar: Settings → your calendar → "Secret address in iCal format"). */
      icsUrls: z.array(z.string().url()).default([]),
      refreshMinutes: z.number().min(1).max(60).default(5),
      /** Events whose title contains one of these words are focus sessions, not meetings. */
      focusKeywords: z.array(z.string()).default(["focus", "deep work", "no meeting", "🎯"]),
      /** Events with no other attendees count as meetings only if this is true (e.g. "Lunch" blocks). */
      soloEventsAreMeetings: z.boolean().default(false),
      /**
       * Your calendar email(s). Lets the app skip meetings you declined. When empty, Google feeds
       * are detected automatically (their calendar name is the owner's email).
       */
      ownerEmails: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Live "am I on a call?" signals. Any of them defers a due break. */
  presence: z
    .object({
      /** Slack user token (xoxp-…) with users.profile:read; used to read your huddle state. */
      slackUserToken: z.string().optional(),
      /** Treat the microphone being in use as "on a call" (catches Zoom, Meet, Huddles, …). */
      micInUseIsCall: z.boolean().default(true),
      /** Treat the camera being in use as "on a call". */
      cameraInUseIsCall: z.boolean().default(true),
      /** macOS bundle ids that hold the microphone without being a call (e.g. "Hey Siri"). */
      ignoreMicApps: z
        .array(z.string())
        .default(["com.apple.corespeechd", "com.apple.assistantd", "com.apple.SiriNCService"]),
      /** While a break runs, set your Slack status to "On a break" (token needs users.profile:write). */
      slackStatusDuringBreaks: z.boolean().default(false),
      /** Optional shell command; exit code 0 means "I'm on a call". For setups the built-in checks miss. */
      inCallCommand: z.string().optional(),
      pollSeconds: z.number().min(5).max(120).default(15),
    })
    .prefault({}),
  focus: z
    .object({
      /** During a focus session, long breaks wait for the session to end (micro breaks still happen). */
      holdLongBreaksUntilEnd: z.boolean().default(true),
      /** A focus session can hold a long break for at most this long; after that it fires anyway. */
      maxHoldMinutes: z.number().min(0).max(180).default(90),
    })
    .prefault({}),
  strictness: z
    .object({
      /**
       * Changes that make breaks rarer, shorter or disabled are queued and only applied
       * after the next completed break, so you can't talk your way out of a break that's due.
       */
      delayLooseningUntilNextBreak: z.boolean().default(true),
      /** If you were idle at least this long, it counts as a long break and the timers reset. */
      idleResetMinutes: z.number().min(1).max(60).default(5),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Partial config as accepted from users and the MCP server. */
export type ConfigPatch = {
  [K in keyof Config]?: Partial<Config[K]>;
};

export const defaultConfig = (): Config => ConfigSchema.parse({});

export function homeDir(): string {
  return process.env.GO_AWAY_HOME ?? path.join(os.homedir(), ".go-away");
}

export const configPath = () => path.join(homeDir(), "config.json");

export function loadConfig(file = configPath()): Config {
  try {
    return ConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
}

export function saveConfig(config: Config, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function mergeConfig(base: Config, patch: ConfigPatch): Config {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = { ...(base as Record<string, object>)[key], ...value };
  }
  return ConfigSchema.parse(merged);
}

/**
 * True when `next` would make you take fewer or shorter breaks than `prev`.
 * Used to delay such changes until after the next completed break.
 */
export function isLoosening(prev: Config, next: Config): boolean {
  const kinds = [
    [prev.microBreak, next.microBreak, "durationSeconds"],
    [prev.longBreak, next.longBreak, "durationMinutes"],
  ] as const;
  for (const [a, b, durationKey] of kinds) {
    if (a.enabled && !b.enabled) return true;
    if (b.intervalMinutes > a.intervalMinutes) return true;
    if ((b as Record<string, number | boolean>)[durationKey] < (a as Record<string, number | boolean>)[durationKey])
      return true;
  }
  if (next.focus.maxHoldMinutes > prev.focus.maxHoldMinutes) return true;
  if (!prev.focus.holdLongBreaksUntilEnd && next.focus.holdLongBreaksUntilEnd) return true;
  if (prev.strictness.delayLooseningUntilNextBreak && !next.strictness.delayLooseningUntilNextBreak) return true;
  if (next.strictness.idleResetMinutes < prev.strictness.idleResetMinutes) return true;
  return false;
}
