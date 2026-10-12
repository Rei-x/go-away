import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Config,
  type ConfigPatch,
  ConfigSchema,
  configPath,
  homeDir,
  isLoosening,
  loadConfig,
  mergeConfig,
  saveConfig,
} from "./config";
import { fetchCalendars, type ScheduleEvent } from "./calendar";
import { detectPresence, type PresenceSignal } from "./presence";
import {
  type ActiveBreak,
  type BreakRecord,
  Scheduler,
  type SchedulerState,
  type Status,
  initialState,
} from "./scheduler";

export interface EngineOptions {
  idleSeconds: () => number;
  now?: () => number;
  /** Swappable for tests. */
  fetchCalendar?: (cfg: Config["calendar"]) => Promise<ScheduleEvent[]>;
  detectPresence?: (cfg: Config["presence"]) => Promise<PresenceSignal>;
}

export interface ConfigChangeResult {
  config: Config;
  /** Set when the change makes breaks weaker and is waiting for the next completed break. */
  pending: Config | null;
  message: string;
}

interface PersistedState extends SchedulerState {
  pendingConfig: Config | null;
}

const statePath = () => path.join(homeDir(), "state.json");
const WARNING_MS = 30_000;

function reviveEvents(events: ScheduleEvent[]): ScheduleEvent[] {
  return events.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
}

export class Engine extends EventEmitter {
  config: Config;
  pendingConfig: Config | null = null;
  readonly scheduler: Scheduler;
  calendar: ScheduleEvent[] = [];
  calendarError: string | null = null;
  calendarFetchedAt: number | null = null;
  presence: PresenceSignal = { inCall: false, reasons: [] };
  private timers: NodeJS.Timeout[] = [];
  private warnedFor: number | null = null;
  private now: () => number;
  private watcher: fs.FSWatcher | null = null;

  constructor(private opts: EngineOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.config = loadConfig();
    const persisted = this.loadState();
    this.pendingConfig = persisted?.pendingConfig ?? null;
    this.scheduler = new Scheduler(persisted ?? initialState(this.now()));
  }

  private loadState(): PersistedState | null {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) as PersistedState;
      raw.manualFocus = reviveEvents(raw.manualFocus ?? []);
      raw.history ??= [];
      raw.pendingConfig = raw.pendingConfig ? ConfigSchema.parse(raw.pendingConfig) : null;
      return raw;
    } catch {
      return null;
    }
  }

  saveState(): void {
    const data: PersistedState = { ...this.scheduler.state, pendingConfig: this.pendingConfig };
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  start(): void {
    // A break that was running when the app was killed is shown again until its original end time.
    const brk = this.scheduler.state.activeBreak;
    if (brk && this.now() < brk.endsAt) this.emit("break-start", brk);
    void this.refreshCalendar();
    void this.refreshPresence();
    this.schedule();
    this.watchConfigFile();
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.watcher?.close();
    this.saveState();
  }

  private schedule(): void {
    this.timers.forEach(clearInterval);
    this.timers = [
      setInterval(() => this.tick(), 1000),
      setInterval(() => void this.refreshPresence(), this.config.presence.pollSeconds * 1000),
      setInterval(() => void this.refreshCalendar(), this.config.calendar.refreshMinutes * 60_000),
    ];
  }

  async refreshCalendar(): Promise<void> {
    if (!this.config.calendar.icsUrls.length) {
      this.calendar = [];
      this.calendarError = null;
      return;
    }
    try {
      this.calendar = await (this.opts.fetchCalendar ?? fetchCalendars)(this.config.calendar);
      this.calendarError = null;
      this.calendarFetchedAt = this.now();
    } catch (err) {
      // Keep the last good copy: a flaky network must not make meetings disappear.
      this.calendarError = (err as Error).message;
    }
  }

  async refreshPresence(): Promise<void> {
    try {
      this.presence = await (this.opts.detectPresence ?? detectPresence)(this.config.presence);
    } catch {
      this.presence = { inCall: false, reasons: [] };
    }
  }

  tick(): void {
    const now = this.now();
    const action = this.scheduler.tick({
      now,
      config: this.config,
      calendar: this.calendar,
      presence: this.presence,
      idleSeconds: this.opts.idleSeconds(),
    });
    if (action.type === "start") {
      this.saveState();
      this.emit("break-start", action.brk);
    } else if (action.type === "end") {
      this.applyPendingConfig();
      this.saveState();
      this.emit("break-end", action.record);
    }
    this.maybeWarn(now);
    this.emit("status", this.status());
  }

  private maybeWarn(now: number): void {
    const st = this.scheduler.status();
    if (!st || st.phase !== "working") return;
    const candidates = [st.nextMicroAt, st.nextLongAt].filter((t): t is number => t !== null);
    if (!candidates.length) return;
    const next = Math.min(...candidates);
    if (next - now <= WARNING_MS && next > now && this.warnedFor !== next) {
      this.warnedFor = next;
      const kind = next === st.nextLongAt ? "long" : "micro";
      this.emit("break-warning", { kind, at: next });
    }
  }

  /** Away time reported by the OS (sleep, screen lock). */
  markAway(from: number, to: number): void {
    this.scheduler.markAway(from, to, this.config);
    this.saveState();
  }

  status(): Status & {
    pendingConfig: boolean;
    calendarError: string | null;
    calendarFetchedAt: number | null;
    presence: PresenceSignal;
  } {
    const st = this.scheduler.status() ?? {
      phase: "working" as const,
      activeBreak: this.scheduler.state.activeBreak,
      nextMicroAt: null,
      nextLongAt: null,
      focus: null,
      meeting: null,
      nextMeeting: null,
    };
    return {
      ...st,
      pendingConfig: this.pendingConfig !== null,
      calendarError: this.calendarError,
      calendarFetchedAt: this.calendarFetchedAt,
      presence: this.presence,
    };
  }

  upcoming(hours = 24): ScheduleEvent[] {
    const now = this.now();
    return this.scheduler
      .allEvents(this.calendar, now)
      .filter((e) => e.end.getTime() > now && e.start.getTime() < now + hours * 3600_000);
  }

  history(days = 7): BreakRecord[] {
    const since = this.now() - days * 86_400_000;
    return this.scheduler.state.history.filter((r) => r.endedAt >= since);
  }

  activeBreak(): ActiveBreak | null {
    return this.scheduler.state.activeBreak;
  }

  startFocus(minutes: number, title?: string, startAt?: number): ScheduleEvent {
    const ev = this.scheduler.startFocus(this.now(), minutes, title, startAt);
    this.saveState();
    return ev;
  }

  endFocus(): number {
    const n = this.scheduler.endFocus(this.now());
    this.saveState();
    return n;
  }

  updateConfig(patch: ConfigPatch): ConfigChangeResult {
    const base = this.pendingConfig ?? this.config;
    return this.setConfig(mergeConfig(base, patch));
  }

  setConfig(next: Config): ConfigChangeResult {
    const strict = this.config.strictness.delayLooseningUntilNextBreak;
    if ((strict && isLoosening(this.config, next)) || this.scheduler.state.activeBreak) {
      this.pendingConfig = next;
      this.saveState();
      return {
        config: this.config,
        pending: next,
        message: this.scheduler.state.activeBreak
          ? "A break is running; the change applies when it ends."
          : "This change makes breaks weaker, so it applies after your next completed break.",
      };
    }
    this.pendingConfig = null;
    this.commitConfig(next);
    return { config: this.config, pending: null, message: "Applied." };
  }

  private applyPendingConfig(): void {
    if (!this.pendingConfig) return;
    const next = this.pendingConfig;
    this.pendingConfig = null;
    this.commitConfig(next);
  }

  private commitConfig(next: Config): void {
    const calendarChanged = JSON.stringify(next.calendar) !== JSON.stringify(this.config.calendar);
    const presenceChanged = JSON.stringify(next.presence) !== JSON.stringify(this.config.presence);
    this.config = next;
    saveConfig(next);
    this.saveState();
    if (this.timers.length) this.schedule();
    if (calendarChanged) void this.refreshCalendar();
    if (presenceChanged) void this.refreshPresence();
    this.emit("config", next);
  }

  /** Hand edits to config.json go through the same rules as MCP changes. */
  private watchConfigFile(): void {
    try {
      fs.mkdirSync(homeDir(), { recursive: true });
      if (!fs.existsSync(configPath())) saveConfig(this.config);
      // Watch the directory: saveConfig() replaces the file, which would orphan a file watch.
      this.watcher = fs.watch(homeDir(), (_event, filename) => {
        if (filename !== path.basename(configPath())) return;
        let next: Config;
        try {
          next = loadConfig();
        } catch {
          return; // half-written or invalid; wait for the next save
        }
        if (JSON.stringify(next) === JSON.stringify(this.config)) return;
        const result = this.setConfig(next);
        if (result.pending) saveConfig(this.config); // keep the file showing what is in effect
      });
    } catch {
      // Watching is best effort (some network filesystems don't support it).
    }
  }
}
