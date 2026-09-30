import { Scissors } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { Switch } from "../components/ui/switch";
import { Select } from "../components/ui/select";
import { Input } from "../components/ui/input";
import { toast } from "../shared/toast";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../hooks/settings";
import { getErrorMessage } from "../shared/helpers";
import type { RuntimeTokenSaverSettings } from "../data/contracts";

const INTENSITY_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "lite", label: "Lite — gentle nudge" },
  { value: "full", label: "Full — firm discipline" },
  { value: "ultra", label: "Ultra — maximum terseness" },
] as const;

type Intensity = (typeof INTENSITY_OPTIONS)[number]["value"];

function isIntensity(v: unknown): v is Intensity {
  return typeof v === "string" && (INTENSITY_OPTIONS as readonly { value: string }[]).some((o) => o.value === v);
}

function SaverRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "16px",
        padding: "14px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "13.5px", fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: "12px", color: "var(--text-tertiary)", marginTop: "3px", lineHeight: 1.5 }}>
          {description}
        </div>
      </div>
      <div style={{ flexShrink: 0, minWidth: "180px" }}>{control}</div>
    </div>
  );
}

function TokenSaverPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data?.tokenSavers;

  const [headroomUrl, setHeadroomUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);

  useEffect(() => {
    if (settings && !urlTouched) setHeadroomUrl(settings.headroomUrl ?? "");
  }, [settings, urlTouched]);

  if (query.isPending) return <LoadingState label="Loading token saver settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(query.error, "Failed to load token saver settings")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const save = (patch: Partial<RuntimeTokenSaverSettings> & { headroomUrl?: string | null }) => {
    const body: Record<string, unknown> = {};
    const tokenSavers: Record<string, unknown> = {};
    if (patch.rtk !== undefined) tokenSavers.rtk = patch.rtk;
    if (patch.caveman !== undefined) tokenSavers.caveman = patch.caveman;
    if (patch.ponytail !== undefined) tokenSavers.ponytail = patch.ponytail;
    if (patch.headroomEnabled !== undefined || patch.headroomUrl !== undefined) {
      tokenSavers.headroom = {
        ...(patch.headroomEnabled !== undefined ? { enabled: patch.headroomEnabled } : {}),
        ...(patch.headroomUrl !== undefined ? { url: patch.headroomUrl } : {}),
      };
    }
    body.tokenSavers = tokenSavers;
    mutation.mutate(body as never, {
      onError: (error) => toast.error(getErrorMessage(error, "Could not update token saver settings.")),
    });
  };

  const commitHeadroomUrl = () => {
    const trimmed = headroomUrl.trim();
    if ((settings.headroomUrl ?? "") !== trimmed) {
      save({ headroomUrl: trimmed === "" ? null : trimmed });
    }
    setUrlTouched(false);
  };

  const saving = mutation.isPending;

  return (
    <Card>
      <CardHeader
        title="Token savers"
        subtitle="Applies to every request — direct models and combos alike"
        icon={<Scissors size={16} />}
      />
      <CardBody>
        <Stack gap="0">
          <SaverRow
            title="RTK"
            description="Compress tool-result outputs (diff/grep/ls/tree patterns, dedup repeated lines, smart truncate). Default ON."
            control={
              <Switch
                id="tokensaver-rtk"
                label={settings.rtk ? "On" : "Off"}
                checked={settings.rtk}
                disabled={saving}
                onChange={(checked) => save({ rtk: checked })}
              />
            }
          />
          <SaverRow
            title="Caveman"
            description="Terse response style — governs how the model talks. Code, commands, paths and exact errors are never shortened."
            control={
              <Select
                id="tokensaver-caveman"
                label="Caveman level"
                value={settings.caveman}
                onValueChange={(v) => isIntensity(v) && save({ caveman: v })}
                options={INTENSITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            }
          />
          <SaverRow
            title="Ponytail"
            description="Lazy-senior-dev discipline (YAGNI-first) — governs what the model builds. Lite nudges, ultra enforces."
            control={
              <Select
                id="tokensaver-ponytail"
                label="Ponytail level"
                value={settings.ponytail}
                onValueChange={(v) => isIntensity(v) && save({ ponytail: v })}
                options={INTENSITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            }
          />
          <div style={{ padding: "14px 0" }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "16px",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "13.5px", fontWeight: 600 }}>Headroom</div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-tertiary)",
                    marginTop: "3px",
                    lineHeight: 1.5,
                  }}
                >
                  External /v1/compress proxy. Fails open when the service is down or the
                  response is malformed.
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                <Switch
                  id="tokensaver-headroom"
                  label={settings.headroomEnabled ? "On" : "Off"}
                  checked={settings.headroomEnabled}
                  disabled={saving}
                  onChange={(checked) => save({ headroomEnabled: checked })}
                />
              </div>
            </div>
            {settings.headroomEnabled && (
              <div style={{ marginTop: "10px", maxWidth: "420px" }}>
                <Input
                  label="Headroom base URL"
                  id="tokensaver-headroom-url"
                  type="text"
                  placeholder="https://headroom.example.com"
                  value={headroomUrl}
                  onChange={(e) => {
                    setHeadroomUrl(e.target.value);
                    setUrlTouched(true);
                  }}
                  onBlur={commitHeadroomUrl}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </div>
            )}
          </div>
        </Stack>
        <Inline gap="8px" style={{ marginTop: "12px" }}>
          <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
            Order per request: RTK → Headroom → Caveman → Ponytail. Changes apply instantly —
            no redeploy needed.
          </span>
        </Inline>
      </CardBody>
    </Card>
  );
}

export default function TokenSaver(): ReactNode {
  return (
    <Stack gap="16px">
      <PageHeader
        title="Token Saver"
        description="Trim tokens before they reach the provider"
      />
      <TokenSaverPanel />
    </Stack>
  );
}
