import type { UsagePeriod as BackendUsagePeriod } from "../../../src/console/observability/usage-periods";
import generated from "./generated/usage-periods.json";

export const USAGE_PERIODS: readonly BackendUsagePeriod[] = generated as readonly BackendUsagePeriod[];
export type UsagePeriod = BackendUsagePeriod;
