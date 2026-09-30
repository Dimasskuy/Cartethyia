import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { DataTable } from "../../components/ui/layout";
import { EmptyState } from "../../components/ui/state";
import { Inline } from "../../components/ui/inline";
import { useInFlight, type LiveFlight } from "../../hooks/live";
import { providerDisplayName } from "../../shared/provider-names";

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function servingLabel(flight: LiveFlight): string {
  if (flight.providerId && flight.modelId) return `${providerDisplayName(flight.providerId)}/${flight.modelId}`;
  if (flight.modelId) return flight.modelId;
  return "Routing…";
}

function FailoverPath({ flight }: { flight: LiveFlight }): React.ReactNode {
  const hops = [
    ...flight.failovers.map((f) => `${providerDisplayName(f.providerId)}/${f.modelId}`),
    servingLabel(flight),
  ];
  if (hops.length <= 1) return <span style={{ color: "var(--text-tertiary)" }}>—</span>;
  return (
    <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
      {hops.map((hop, index) => (
        <span key={index}>
          {index > 0 && <span style={{ margin: "0 4px", color: "var(--text-tertiary)" }}>→</span>}
          <span
            style={{
              textDecoration: index < hops.length - 1 ? "line-through" : "none",
              opacity: index < hops.length - 1 ? 0.6 : 1,
              fontWeight: index === hops.length - 1 ? 600 : 400,
              color: index === hops.length - 1 ? "var(--text-primary)" : undefined,
            }}
          >
            {hop}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * Live activity: every request executing right now, which provider/model is
 * serving it, and the failover hops it took to get there. Fed by the console
 * SSE in-flight stream, so it updates without polling.
 */
export function LiveActivityCard(): React.ReactNode {
  const { flights, live } = useInFlight();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const rows = flights ?? [];
  return (
    <Card className="grid-span-full">
      <CardHeader
        title="Live activity"
        subtitle={
          live
            ? `${rows.length} ${rows.length === 1 ? "request" : "requests"} executing right now`
            : "Live feed disconnected — last seen state"
        }
        icon={<Radio size={16} />}
        action={
          <Inline gap="6px" align="center">
            <span
              aria-hidden="true"
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: live ? "var(--success)" : "var(--text-tertiary)",
                boxShadow: live ? "0 0 6px var(--success)" : "none",
                flexShrink: 0,
                animation: live ? "pulse-subtle 1.8s infinite" : "none",
              }}
            />
            <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
              {live ? "Live" : "Offline"}
            </span>
          </Inline>
        }
      />
      <CardBody style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div style={{ padding: "20px" }}>
            <EmptyState
              title="No active requests"
              message="Requests appear here the moment they start executing, with the model serving them."
            />
          </div>
        ) : (
          <DataTable headers={["Request", "Serving now", "Attempt", "Failover path", "Elapsed"]}>
            {rows.map((flight) => (
              <tr key={flight.id}>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>#{flight.id}</td>
                <td style={{ fontWeight: 600 }}>{servingLabel(flight)}</td>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                  {flight.attempt + 1}
                  {flight.attempt > 0 && (
                    <span style={{ color: "var(--warning)", marginLeft: "6px" }}>
                      failover ×{flight.attempt}
                    </span>
                  )}
                </td>
                <td>
                  <FailoverPath flight={flight} />
                </td>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                  {formatElapsed(now - flight.startedAt)}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </CardBody>
    </Card>
  );
}
