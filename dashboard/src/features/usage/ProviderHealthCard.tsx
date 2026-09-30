import { HeartPulse } from "lucide-react";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { DataTable } from "../../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { useProviderHealth } from "../../hooks/system";
import type { ProviderHealthRow } from "../../data/contracts";
import { providerDisplayName } from "../../shared/provider-names";
import { formatDuration, formatNumber } from "../../shared/format";
import { formatUsd } from "./UsagePage";

function successTone(rate: number): string {
  if (rate >= 99) return "var(--success)";
  if (rate >= 95) return "var(--warning)";
  return "var(--danger)";
}

function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function HealthRow({ row }: { row: ProviderHealthRow }): React.ReactNode {
  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{providerDisplayName(row.providerId)}</td>
      <td>
        <span style={{ color: successTone(row.successRate), fontWeight: 600 }}>
          {row.successRate.toFixed(1)}%
        </span>
      </td>
      <td style={{ fontFamily: "var(--font-mono)" }}>{formatNumber(row.requests)}</td>
      <td style={{ fontFamily: "var(--font-mono)", color: row.errors > 0 ? "var(--danger)" : undefined }}>
        {formatNumber(row.errors)}
      </td>
      <td style={{ fontFamily: "var(--font-mono)" }}>{formatDuration(row.avgLatencyMs)}</td>
      <td style={{ fontFamily: "var(--font-mono)" }}>{formatDuration(row.p95LatencyMs)}</td>
      <td style={{ fontFamily: "var(--font-mono)" }}>{formatUsd(row.costUsd)}</td>
      <td style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
        {row.lastErrorAt ? (
          <span title={row.lastErrorCategory ?? undefined}>
            {formatAgo(row.lastErrorAt)}
            {row.lastErrorCategory ? ` · ${row.lastErrorCategory}` : ""}
          </span>
        ) : (
          <span style={{ color: "var(--text-tertiary)" }}>—</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Provider health: per-provider success rate, latency (avg + p95), errors,
 * and the most recent error, aggregated from telemetry for the selected
 * period. The long view next to the live activity feed.
 */
export function ProviderHealthCard({ period }: { period: string }): React.ReactNode {
  const query = useProviderHealth(period);
  const providers = query.data?.providers ?? [];
  return (
    <Card className="grid-span-full">
      <CardHeader
        title="Provider health"
        subtitle="Success rate, latency, and recent errors per provider"
        icon={<HeartPulse size={16} />}
      />
      <CardBody style={{ padding: 0 }}>
        {query.isPending ? (
          <div style={{ padding: "20px" }}>
            <LoadingState label="Loading provider health…" />
          </div>
        ) : query.isError ? (
          <div style={{ padding: "20px" }}>
            <ErrorState message="Could not load provider health." onRetry={() => void query.refetch()} />
          </div>
        ) : providers.length === 0 ? (
          <div style={{ padding: "20px" }}>
            <EmptyState
              title="No provider traffic"
              message="Providers appear here once they have served requests in the selected period."
            />
          </div>
        ) : (
          <DataTable
            headers={["Provider", "Success", "Requests", "Errors", "Avg latency", "p95 latency", "Est. cost", "Last error"]}
          >
            {providers.map((row) => (
              <HealthRow key={row.providerId} row={row} />
            ))}
          </DataTable>
        )}
      </CardBody>
    </Card>
  );
}
