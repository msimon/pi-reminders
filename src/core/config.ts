// Config lives in its own file so editing it can never corrupt reminder data.
//
// Missing file means defaults. Unreadable or partly invalid means defaults for
// whatever could not be read, plus a warning the caller surfaces once.
//
// Every value is read fresh from disk and applied to derived state, so changing
// `allDayFireHour` re-derives `fireAt` for every all-day reminder on the next
// tick. Nothing is persisted on the record, so there is nothing to migrate.

import { readFile } from "node:fs/promises";
import { configFile } from "./paths.ts";
import { DEFAULT_CONFIG, type RemindersConfig, type StatuslineStyle } from "./types.ts";

export interface LoadedConfig {
  config: RemindersConfig;
  /** Set when the file existed but could not be used as-is. */
  warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

const STATUSLINE_STYLES: readonly StatuslineStyle[] = ["words", "compact"];

export function normalizeConfig(input: unknown): RemindersConfig {
  if (!isRecord(input)) return { ...DEFAULT_CONFIG };
  const style = STATUSLINE_STYLES.find((candidate) => candidate === input.statuslineStyle);
  return {
    allDayFireHour: integerIn(input.allDayFireHour, 0, 23, DEFAULT_CONFIG.allDayFireHour),
    statuslineStyle: style ?? DEFAULT_CONFIG.statuslineStyle,
    statuslinePrefix:
      typeof input.statuslinePrefix === "string" ? input.statuslinePrefix : DEFAULT_CONFIG.statuslinePrefix,
    // Floor of 5s: a tighter tick would re-read the state file pointlessly.
    tickIntervalSeconds: integerIn(input.tickIntervalSeconds, 5, 3600, DEFAULT_CONFIG.tickIntervalSeconds),
    startupReportLimit: integerIn(input.startupReportLimit, 1, 100, DEFAULT_CONFIG.startupReportLimit),
    desktopNotifications:
      typeof input.desktopNotifications === "boolean"
        ? input.desktopNotifications
        : DEFAULT_CONFIG.desktopNotifications,
  };
}

export async function readConfig(): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await readFile(configFile(), "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG } };
    }
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `Could not read ${configFile()}; using defaults.`,
    };
  }

  try {
    return { config: normalizeConfig(JSON.parse(raw)) };
  } catch {
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `${configFile()} is not valid JSON; using defaults.`,
    };
  }
}
