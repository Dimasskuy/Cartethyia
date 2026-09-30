import { useEffect, useRef, useState } from "react";
import { ChevronDown, Radio } from "lucide-react";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/state";
import { Inline } from "../../components/ui/inline";
import { useInFlight, type LiveFlight } from "../../hooks/live";
import { providerDisplayName } from "../../shared/provider-names";
import { consoleRequest } from "../../data/api";

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

function PreviewBlock({
  label,
  text,
  muted = false,
}: {
  label: string;
  text: string;
  muted?: boolean;
}): React.ReactNode {
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
          color: muted ? "var(--text-tertiary)" : "var(--text-secondary)",
          fontStyle: muted ? "italic" : "normal",
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

/** Small status dot for collapsed rows: green = streaming, gray = waiting/done. */
function StatusDot({ flight, done = false }: { flight: LiveFlight; done?: boolean }): React.ReactNode {
  const streaming = !done && flight.status === "streaming";
  const label = done ? "Done" : streaming ? "Streaming" : "Waiting for first token";
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        flexShrink: 0,
        background: streaming ? "var(--status-success)" : "var(--text-tertiary)",
        boxShadow: streaming ? "0 0 6px var(--status-success)" : "none",
      }}
    />
  );
}

function FlightDetail({
  flight,
  now,
  done = false,
}: {
  flight: LiveFlight;
  now: number;
  done?: boolean;
}): React.ReactNode {
  const elapsedSec = Math.max(0.1, (now - flight.startedAt) / 1000);
  const tokPerSec =
    !done && flight.status === "streaming" && flight.outputTokens !== null
      ? Math.round(flight.outputTokens / elapsedSec)
      : null;
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancelRequest = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await consoleRequest<{ ok?: boolean; cancelled?: boolean }>(
        `/live/in-flight/${flight.id}/cancel`,
        { method: "POST" },
      );
      // The backend reports whether anything was actually stopped. A 200
      // with cancelled:false means the request was already gone — say so
      // instead of looking like a successful kill.
      if (result && result.cancelled === false) {
        setCancelError("Request already finished — nothing to cancel.");
      }
      // The row disappears on the next SSE snapshot — no local state to clear.
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "Cancel failed");
    } finally {
      setCancelling(false);
    }
  };

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
              background: done
                ? "var(--surface-muted)"
                : flight.status === "streaming"
                  ? "color-mix(in srgb, var(--status-success) 16%, transparent)"
                  : "var(--surface-muted)",
              color: done
                ? "var(--text-tertiary)"
                : flight.status === "streaming"
                  ? "var(--status-success)"
                  : "var(--text-secondary)",
            }}
          >
            {done ? "✓ Done" : flight.status === "streaming" ? "● Streaming" : "○ Waiting for first token"}
          </span>
        </Inline>
        {!done && (
          <Inline gap="8px" align="center">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void cancelRequest();
              }}
              disabled={cancelling}
              title="Abort this request immediately — stops the upstream call and any combo stage"
              style={{
                fontSize: "11px",
                fontWeight: 700,
                padding: "4px 12px",
                borderRadius: "999px",
                border: "1px solid var(--status-danger)",
                background: "transparent",
                color: "var(--status-danger)",
                cursor: cancelling ? "wait" : "pointer",
                opacity: cancelling ? 0.6 : 1,
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel request"}
            </button>
            {cancelError && (
              <span style={{ fontSize: "11px", color: "var(--status-danger)" }}>{cancelError}</span>
            )}
          </Inline>
        )}
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
            <span
              style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
              title="Token-saving transforms applied to this request (RTK, Headroom, Caveman, Ponytail)"
            >
              Savers:
            </span>
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
      {(flight.promptPreview || flight.responsePreview || done) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "12px",
          }}
        >
          {flight.promptPreview && <PreviewBlock label="Prompt" text={flight.promptPreview} />}
          {flight.responsePreview ? (
            <PreviewBlock label="Response so far" text={flight.responsePreview} />
          ) : (
            !done && (
              <PreviewBlock
                label="Response so far"
                text="Waiting for the first token…"
                muted
              />
            )
          )}
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
 * Recently finished requests linger ~6s in a faded "done" state so they can
 * still be inspected right after they complete.
 */
export function LiveActivityCard(): React.ReactNode {
  const { flights, live } = useInFlight();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<readonly { flight: LiveFlight; endedAt: number }[]>([]);
  const prevFlightsRef = useRef<readonly LiveFlight[]>([]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Track flights that vanished (finished) so they linger briefly as "done".
  useEffect(() => {
    const current = flights ?? [];
    const activeIds = new Set(current.map((f) => f.id));
    const at = Date.now();
    setDone((prev) => {
      const kept = prev.filter((d) => !activeIds.has(d.flight.id) && at - d.endedAt < 6000);
      const keptIds = new Set(kept.map((d) => d.flight.id));
      const added = prevFlightsRef.current
        .filter((f) => !activeIds.has(f.id) && !keptIds.has(f.id))
        .map((f) => ({ flight: f, endedAt: at }));
      return [...kept, ...added];
    });
    prevFlightsRef.current = current;
  }, [flights, now]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rows = flights ?? [];
  const subtitle = !live
    ? "Live feed disconnected — last seen state"
    : rows.length === 0
      ? "No requests executing right now"
      : `${rows.length} ${rows.length === 1 ? "request" : "requests"} executing right now — click a row for detail`;

  const rowPair = (flight: LiveFlight, doneEntry: { endedAt: number } | null) => {
    const isDone = doneEntry !== null;
    const isOpen = expanded.has(flight.id);
    const elapsed = isDone ? doneEntry.endedAt - flight.startedAt : now - flight.startedAt;
    return [
      <tr
        key={flight.id}
        onClick={() => toggle(flight.id)}
        style={{ cursor: "pointer", opacity: isDone ? 0.55 : 1 }}
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
        <td style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>
          <Inline gap="8px" align="center">
            <StatusDot flight={flight} done={isDone} />
            <span>#{flight.id}</span>
            {isDone && (
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: "var(--surface-muted)",
                  color: "var(--text-tertiary)",
                }}
              >
                Done
              </span>
            )}
          </Inline>
        </td>
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
          {formatElapsed(elapsed)}
        </td>
      </tr>,
      isOpen && (
        <tr key={`${flight.id}-detail`}>
          <td colSpan={7} style={{ background: "var(--surface-1)", padding: "14px 16px" }}>
            <FlightDetail
              flight={flight}
              now={isDone ? doneEntry.endedAt : now}
              done={isDone}
            />
          </td>
        </tr>
      ),
    ];
  };

  const hasRows = rows.length > 0 || done.length > 0;
  return (
    <Card className="grid-span-full">
      <CardHeader
        title="Live activity"
        subtitle={subtitle}
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
              {live ? `Live · ${rows.length} in flight` : "Offline"}
            </span>
          </Inline>
        }
      />
      <CardBody style={{ padding: 0 }}>
        {!hasRows ? (
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
                  <th title="Short request id — click a row to expand its live detail">Request</th>
                  <th title="Combo name or direct provider/model route for this request">Route</th>
                  <th title="Provider/model currently serving this request">Serving now</th>
                  <th title="Dispatch attempt number — above 1 means a failover happened">Attempt</th>
                  <th title="Providers/models tried before the current one, in order">Failover path</th>
                  <th title="Time since the request started">Elapsed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((flight) => rowPair(flight, null))}
                {done.map((d) => rowPair(d.flight, { endedAt: d.endedAt }))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
