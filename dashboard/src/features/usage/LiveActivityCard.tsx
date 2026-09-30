import { useEffect, useState } from "react";
import { ChevronDown, Radio } from "lucide-react";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/state";
import { Inline } from "../../components/ui/inline";
import { useInFlight, type LiveFlight } from "../../hooks/live";
import { providerDisplayName } from "../../shared/provider-names";

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
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
    <span style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.6 }}>
      {hops.map((hop, index) => (
        <span key={index}>
          {index > 0 && <span style={{ margin: "0 6px", color: "var(--text-tertiary)" }}>→</span>}
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

function PreviewBlock({ label, text }: { label: string; text: string }): React.ReactNode {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: "10.5px",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--text-tertiary)",
          marginBottom: "6px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          lineHeight: 1.6,
          color: "var(--text-secondary)",
          background: "var(--surface-2)",
          border: "1px solid var(--inner-border)",
          borderRadius: "8px",
          padding: "10px 12px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: "160px",
          overflowY: "auto",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function FlightDetail({ flight, now }: { flight: LiveFlight; now: number }): React.ReactNode {
  const elapsedSec = Math.max(0.1, (now - flight.startedAt) / 1000);
  const tokPerSec =
    flight.status === "streaming" && flight.outputTokens !== null
      ? Math.round(flight.outputTokens / elapsedSec)
      : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "4px 2px" }}>
      <Inline gap="16px" align="center" wrap>
        <Inline gap="6px" align="center">
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              padding: "3px 10px",
              borderRadius: "999px",
              background:
                flight.status === "streaming"
                  ? "color-mix(in srgb, var(--status-success) 16%, transparent)"
                  : "var(--surface-muted)",
              color: flight.status === "streaming" ? "var(--status-success)" : "var(--text-secondary)",
            }}
          >
            {flight.status === "streaming" ? "● Streaming" : "○ Waiting for first token"}
          </span>
        </Inline>
        {flight.stage && (
          <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            Stage: <strong style={{ color: "var(--text-primary)" }}>{flight.stage}</strong>
          </span>
        )}
        {flight.route && (
          <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            Route: <strong style={{ color: "var(--text-primary)" }}>{flight.route}</strong>
          </span>
        )}
        <span style={{ fontSize: "12px", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          {flight.inputTokens !== null ? `in ${formatTokens(flight.inputTokens)}` : "in —"}
          {" → "}
          {flight.outputTokens !== null ? `out ${formatTokens(flight.outputTokens)}` : "out —"}
          {tokPerSec !== null && <span style={{ color: "var(--text-tertiary)" }}> · {tokPerSec} tok/s</span>}
        </span>
        {flight.tokenSavers.length > 0 && (
          <Inline gap="6px" align="center">
            <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>Savers:</span>
            {flight.tokenSavers.map((saver) => (
              <span
                key={saver}
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: "var(--surface-muted)",
                  color: "var(--text-secondary)",
                }}
              >
                {saver}
              </span>
            ))}
          </Inline>
        )}
      </Inline>
      {(flight.promptPreview || flight.responsePreview) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "12px",
          }}
        >
          {flight.promptPreview && <PreviewBlock label="Prompt" text={flight.promptPreview} />}
          {flight.responsePreview && <PreviewBlock label="Response so far" text={flight.responsePreview} />}
        </div>
      )}
    </div>
  );
}

/**
 * Live activity: every request executing right now, which provider/model is
 * serving it, and the failover hops it took to get there. Rows expand to a
 * live detail panel (status, stage, tokens, savers, prompt/response preview).
 * Fed by the console SSE in-flight stream, so it updates without polling.
 */
export function LiveActivityCard(): React.ReactNode {
  const { flights, live } = useInFlight();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rows = flights ?? [];
  return (
    <Card className="grid-span-full">
      <CardHeader
        title="Live activity"
        subtitle={
          live
            ? `${rows.length} ${rows.length === 1 ? "request" : "requests"} executing right now — click a row for detail`
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
          <div className="data-table-container">
            <table className="data-table" style={{ tableLayout: "fixed", fontSize: "13px" }}>
              <colgroup>
                <col style={{ width: "36px" }} />
                <col style={{ width: "150px" }} />
                <col style={{ width: "190px" }} />
                <col style={{ width: "210px" }} />
                <col style={{ width: "110px" }} />
                <col />
                <col style={{ width: "100px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th>Request</th>
                  <th>Route</th>
                  <th>Serving now</th>
                  <th>Attempt</th>
                  <th>Failover path</th>
                  <th>Elapsed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((flight) => {
                  const isOpen = expanded.has(flight.id);
                  return [
                    <tr
                      key={flight.id}
                      onClick={() => toggle(flight.id)}
                      style={{ cursor: "pointer" }}
                      aria-expanded={isOpen}
                    >
                      <td>
                        <ChevronDown
                          size={15}
                          style={{
                            color: "var(--text-tertiary)",
                            transform: isOpen ? "rotate(180deg)" : "none",
                            transition: "transform 0.15s",
                            display: "block",
                          }}
                        />
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>#{flight.id}</td>
                      <td
                        style={{
                          fontSize: "12px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={flight.route ?? undefined}
                      >
                        {flight.route ?? <span style={{ color: "var(--text-tertiary)" }}>—</span>}
                      </td>
                      <td
                        style={{
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={servingLabel(flight)}
                      >
                        {servingLabel(flight)}
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>
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
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                        {formatElapsed(now - flight.startedAt)}
                      </td>
                    </tr>,
                    isOpen && (
                      <tr key={`${flight.id}-detail`}>
                        <td colSpan={7} style={{ background: "var(--surface-1)", padding: "14px 16px" }}>
                          <FlightDetail flight={flight} now={now} />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
