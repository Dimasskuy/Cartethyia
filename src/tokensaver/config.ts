/**
 * Token-saver configuration: normalized view over the combo's
 * `tokenSavers` JSONB section. Adapted from ExtremeRouter's token savers
 * (RTK / Headroom / Ponytail / Caveman).
 */
import type { TokenSaverConfig, TokenSaverIntensity } from "../persistence/schema";

export type { TokenSaverIntensity };
export type { TokenSaverConfig };

export interface NormalizedTokenSaverConfig {
  /** RTK tool-output compression. Default ON (matches upstream). */
  readonly rtk: boolean;
  readonly caveman: TokenSaverIntensity;
  readonly ponytail: TokenSaverIntensity;
  readonly headroomEnabled: boolean;
  readonly headroomUrl: string | undefined;
}

const INTENSITIES: readonly TokenSaverIntensity[] = ["off", "lite", "full", "ultra"];

function normalizeIntensity(value: unknown): TokenSaverIntensity {
  return typeof value === "string" && (INTENSITIES as readonly string[]).includes(value)
    ? (value as TokenSaverIntensity)
    : "off";
}

export const DEFAULT_TOKEN_SAVER_CONFIG: NormalizedTokenSaverConfig = {
  rtk: true,
  caveman: "off",
  ponytail: "off",
  headroomEnabled: false,
  headroomUrl: undefined,
};

/** Defensive normalization: unknown/malformed input falls back to defaults. */
export function normalizeTokenSaverConfig(raw: unknown): NormalizedTokenSaverConfig {
  if (raw === null || raw === undefined || typeof raw !== "object") return DEFAULT_TOKEN_SAVER_CONFIG;
  const config = raw as Record<string, unknown>;
  const headroom = (
    config.headroom !== null && typeof config.headroom === "object"
      ? (config.headroom as Record<string, unknown>)
      : {}
  );
  const headroomUrl = typeof headroom.url === "string" && headroom.url.trim().length > 0
    ? headroom.url.trim()
    : undefined;
  return {
    rtk: typeof config.rtk === "boolean" ? config.rtk : true,
    caveman: normalizeIntensity(config.caveman),
    ponytail: normalizeIntensity(config.ponytail),
    headroomEnabled: headroom.enabled === true && headroomUrl !== undefined,
    headroomUrl,
  };
}

/** True when at least one saver would change the request. */
export function tokenSaversActive(config: NormalizedTokenSaverConfig): boolean {
  return (
    config.rtk ||
    config.caveman !== "off" ||
    config.ponytail !== "off" ||
    config.headroomEnabled
  );
}
