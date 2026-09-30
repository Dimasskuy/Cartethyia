import { ArrowRight, Copy, Layers, Pencil, Plus, Route, Search, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Input, Textarea } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { ModelPickerModal } from "../components/ModelPicker";
import { useTrackedTimeout } from "../hooks/use-timeout";
import { useClipboard } from "../hooks/use-clipboard";
import { toast } from "../shared/toast";
import type { ComboStrategy, ModelAliasRow, ModelComboRow } from "../data/contracts";
import { COMBO_STRATEGY_OPTIONS } from "../shared/combo-strategy";
import {
  useCreateModelAlias,
  useCreateModelCombo,
  useDeleteModelAlias,
  useDeleteModelCombo,
  useModelAliases,
  useModelCombos,
  useUpdateModelAlias,
  useUpdateModelCombo,
} from "../hooks/routing";

// ── Aliases Section ──────────────────────────────────────────────────────────

function AliasesSection(): ReactNode {
  const aliasesQuery = useModelAliases();
  const createMutation = useCreateModelAlias();
  const updateMutation = useUpdateModelAlias();
  const deleteMutation = useDeleteModelAlias();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<ModelAliasRow | null>(null);
  const [aliasName, setAliasName] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelAliasRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const aliases = useMemo(() => aliasesQuery.data ?? [], [aliasesQuery.data]);

  const openCreate = () => {
    setEditingAlias(null);
    setAliasName("");
    setTargetModel("");
    setDialogOpen(true);
  };

  const openEdit = (a: ModelAliasRow) => {
    setEditingAlias(a);
    setAliasName(a.alias);
    setTargetModel(a.targetModel);
    setDialogOpen(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aliasName.trim() || !targetModel.trim()) return;

    if (editingAlias) {
      updateMutation.mutate(
        { id: editingAlias.id, request: { targetModel: targetModel.trim() } },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingAlias(null);
          },
        },
      );
    } else {
      createMutation.mutate(
        { alias: aliasName.trim(), targetModel: targetModel.trim() },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setAliasName("");
            setTargetModel("");
          },
        },
      );
    }
  };

  const handleCopy = (text: string, id: string) => {
    void copy(text).then((ok) => {
      if (!ok) {
        toast.error("Copy failed");
        return;
      }
      setCopiedKey(id);
      scheduleCopyReset(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <Card>
      <CardHeader
        title="Model Aliases"
        subtitle="Map readable names to real models (e.g. claude-mythos-5 → claude-opus-5)"
        icon={<Route size={16} />}
        action={
          <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openCreate}>
            New Alias
          </Button>
        }
      />
      <CardBody>
        {aliasesQuery.isPending ? (
          <LoadingState label="Loading aliases..." />
        ) : aliasesQuery.isError ? (
          <ErrorState message="Failed to load aliases" onRetry={() => aliasesQuery.refetch()} />
        ) : aliases.length === 0 ? (
          <EmptyState
            title="No aliases defined"
            message="Create an alias to route short or friendly names to real provider model IDs."
          />
        ) : (
          <Stack gap="8px">
            {aliases.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "10px 14px",
                  borderRadius: "10px",
                  border: "1px solid var(--inner-border)",
                  background: "var(--surface-2)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                    minWidth: 0,
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "var(--accent)",
                      background: "var(--accent-soft)",
                      padding: "3px 8px",
                      borderRadius: "6px",
                    }}
                  >
                    {a.alias}
                  </code>
                  <ArrowRight size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {a.targetModel}
                  </code>
                </div>

                <Inline gap="4px" style={{ flexShrink: 0 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Copy size={13} />}
                    onClick={() => handleCopy(a.alias, a.id)}
                    title={copiedKey === a.id ? "Copied!" : "Copy alias"}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Pencil size={13} />}
                    onClick={() => openEdit(a)}
                    title="Edit target model"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={() => setDeleteConfirm(a)}
                    title="Delete alias"
                    style={{ color: "var(--red)" }}
                  />
                </Inline>
              </div>
            ))}
          </Stack>
        )}
      </CardBody>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingAlias ? "Edit Model Alias" : "New Model Alias"}
      >
        <form
          onSubmit={handleSave}
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Input
            label="Alias name"
            id="alias-name-input"
            value={aliasName}
            onChange={(e) => setAliasName(e.target.value)}
            placeholder="e.g. fast, sonnet, smart"
            disabled={Boolean(editingAlias)}
            required
          />
          <Inline gap="8px" align="flex-end">
            <div style={{ flex: 1 }}>
              <Input
                label="Target model"
                id="target-model-input"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
                placeholder="e.g. codex/gpt-5.5, claude/claude-sonnet-5"
                required
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setPickerOpen(true)}
              icon={<Search size={13} />}
            >
              Browse
            </Button>
          </Inline>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={targetModel ? [targetModel] : []}
            onToggle={() => {}}
            onSelectOne={(v) => setTargetModel(v)}
            title="Select target model"
            multi={false}
          />
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" type="button" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                createMutation.isPending ||
                updateMutation.isPending ||
                !aliasName.trim() ||
                !targetModel.trim()
              }
            >
              {editingAlias ? "Save Changes" : "Create Alias"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Model Alias"
      >
        <Stack gap="12px">
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Are you sure you want to delete alias <strong>{deleteConfirm?.alias}</strong>? Clients
            requesting this name will need their full model path.
          </p>
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              style={{ background: "var(--red)", borderColor: "var(--red)" }}
              onClick={() => {
                if (deleteConfirm) {
                  deleteMutation.mutate(deleteConfirm.id, {
                    onSuccess: () => setDeleteConfirm(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Alias"}
            </Button>
          </div>
        </Stack>
      </Dialog>
    </Card>
  );
}

// ── Combos Section ───────────────────────────────────────────────────────────

function CombosSection(): ReactNode {
  const combosQuery = useModelCombos();
  const createMutation = useCreateModelCombo();
  const updateMutation = useUpdateModelCombo();
  const deleteMutation = useDeleteModelCombo();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ModelComboRow | null>(null);
  const [comboName, setComboName] = useState("");
  const [membersText, setMembersText] = useState("");
  const [strategy, setStrategy] = useState<ComboStrategy>("fallback");
  const [cascadeThreshold, setCascadeThreshold] = useState("70");
  const [cascadeMaxStages, setCascadeMaxStages] = useState("3");
  const [fusionJudgeModel, setFusionJudgeModel] = useState("");
  const [fusionMinPanel, setFusionMinPanel] = useState("2");
  const [fusionPanelTimeoutMs, setFusionPanelTimeoutMs] = useState("90000");
  const [fusionStragglerGraceMs, setFusionStragglerGraceMs] = useState("8000");
  const [smartToolMembers, setSmartToolMembers] = useState("");
  const [smartNoToolMembers, setSmartNoToolMembers] = useState("");
  const [smartResearchMembers, setSmartResearchMembers] = useState("");
  const [smartClassifierModel, setSmartClassifierModel] = useState("");
  const [swarmManagerModel, setSwarmManagerModel] = useState("");
  const [swarmStaffModel, setSwarmStaffModel] = useState("");
  const [swarmWorkerModels, setSwarmWorkerModels] = useState("");
  const [swarmWorkerCount, setSwarmWorkerCount] = useState("8");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelComboRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const selectedMembers = useMemo(
    () =>
      membersText
        .split("\n")
        .map((m) => m.trim())
        .filter((m) => m.length > 0),
    [membersText],
  );
  const handlePickerToggle = (q: string) => {
    if (selectedMembers.includes(q))
      setMembersText(selectedMembers.filter((m) => m !== q).join("\n"));
    else setMembersText([...selectedMembers, q].join("\n"));
  };

  const combos = combosQuery.data ?? [];

  const openCreate = () => {
    setEditingCombo(null);
    setComboName("");
    setMembersText("");
    setStrategy("fallback");
    setCascadeThreshold("70");
    setCascadeMaxStages("3");
    setFusionJudgeModel("");
    setFusionMinPanel("2");
    setFusionPanelTimeoutMs("90000");
    setFusionStragglerGraceMs("8000");
    setSmartToolMembers("");
    setSmartNoToolMembers("");
    setSmartResearchMembers("");
    setSmartClassifierModel("");
    setSwarmManagerModel("");
    setSwarmStaffModel("");
    setSwarmWorkerModels("");
    setSwarmWorkerCount("8");
    setDialogOpen(true);
  };

  const openEdit = (c: ModelComboRow) => {
    setEditingCombo(c);
    setComboName(c.name);
    setMembersText(c.members.join("\n"));
    setStrategy(c.strategy);
    const cascade = c.config?.cascade;
    setCascadeThreshold(
      typeof cascade?.confidenceThreshold === "number" ? String(cascade.confidenceThreshold) : "70",
    );
    setCascadeMaxStages(typeof cascade?.maxStages === "number" ? String(cascade.maxStages) : "3");
    const fusion = c.config?.fusion;
    setFusionJudgeModel(typeof fusion?.judgeModel === "string" ? fusion.judgeModel : "");
    setFusionMinPanel(typeof fusion?.minPanel === "number" ? String(fusion.minPanel) : "2");
    setFusionPanelTimeoutMs(
      typeof fusion?.panelTimeoutMs === "number" ? String(fusion.panelTimeoutMs) : "90000",
    );
    setFusionStragglerGraceMs(
      typeof fusion?.stragglerGraceMs === "number" ? String(fusion.stragglerGraceMs) : "8000",
    );
    const smart = c.config?.smartRouting;
    const listToText = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : "");
    setSmartToolMembers(listToText(smart?.toolCallingMembers));
    setSmartNoToolMembers(listToText(smart?.noToolMembers));
    setSmartResearchMembers(listToText(smart?.researchMembers));
    setSmartClassifierModel(
      typeof smart?.intentDetection?.llmClassifierFallback?.model === "string"
        ? smart.intentDetection.llmClassifierFallback.model
        : "",
    );
    const swarm = c.config?.swarm;
    setSwarmManagerModel(typeof swarm?.managerModel === "string" ? swarm.managerModel : "");
    setSwarmStaffModel(typeof swarm?.staffModel === "string" ? swarm.staffModel : "");
    setSwarmWorkerModels(listToText(swarm?.workerModels));
    setSwarmWorkerCount(typeof swarm?.workerCount === "number" ? String(swarm.workerCount) : "8");
    setDialogOpen(true);
  };

  const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const parseMemberList = (raw: string): string[] =>
    raw
      .split("\n")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const members = membersText
      .split("\n")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    if (!comboName.trim() || members.length === 0) return;

    // Per-strategy tuning; cleared when the strategy changes so stale
    // knobs never linger on a repurposed combo.
    const config =
      strategy === "cascade"
        ? {
            cascade: {
              confidenceThreshold: clampInt(cascadeThreshold, 0, 100, 70),
              maxStages: clampInt(cascadeMaxStages, 1, 8, 3),
            },
          }
        : strategy === "fusion"
          ? {
              fusion: {
                ...(fusionJudgeModel.trim() ? { judgeModel: fusionJudgeModel.trim() } : {}),
                minPanel: clampInt(fusionMinPanel, 1, 8, 2),
                panelTimeoutMs: clampInt(fusionPanelTimeoutMs, 1000, 600000, 90000),
                stragglerGraceMs: clampInt(fusionStragglerGraceMs, 0, 60000, 8000),
              },
            }
          : strategy === "smart_routing"
            ? {
                smartRouting: {
                  ...(parseMemberList(smartToolMembers).length > 0
                    ? { toolCallingMembers: parseMemberList(smartToolMembers) }
                    : {}),
                  ...(parseMemberList(smartNoToolMembers).length > 0
                    ? { noToolMembers: parseMemberList(smartNoToolMembers) }
                    : {}),
                  ...(parseMemberList(smartResearchMembers).length > 0
                    ? { researchMembers: parseMemberList(smartResearchMembers) }
                    : {}),
                  ...(smartClassifierModel.trim()
                    ? {
                        intentDetection: {
                          llmClassifierFallback: { enabled: true, model: smartClassifierModel.trim() },
                        },
                      }
                    : {}),
                },
              }
            : strategy === "swarm"
              ? {
                  swarm: {
                    ...(swarmManagerModel.trim() ? { managerModel: swarmManagerModel.trim() } : {}),
                    ...(swarmStaffModel.trim() ? { staffModel: swarmStaffModel.trim() } : {}),
                    ...(parseMemberList(swarmWorkerModels).length > 0
                      ? { workerModels: parseMemberList(swarmWorkerModels) }
                      : {}),
                    workerCount: clampInt(swarmWorkerCount, 1, 16, 8),
                  },
                }
              : null;

    if (editingCombo) {
      updateMutation.mutate(
        { id: editingCombo.id, request: { members, strategy, config } },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingCombo(null);
          },
        },
      );
    } else {
      createMutation.mutate(
        { name: comboName.trim(), members, strategy, config },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setComboName("");
            setMembersText("");
          },
        },
      );
    }
  };

  const handleStrategyChange = (combo: ModelComboRow, nextStrategy: ComboStrategy) => {
    updateMutation.mutate({
      id: combo.id,
      request: { strategy: nextStrategy },
    });
  };

  const handleCopy = (text: string, id: string) => {
    void copy(text).then((ok) => {
      if (!ok) {
        toast.error("Copy failed");
        return;
      }
      setCopiedKey(id);
      scheduleCopyReset(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <Card>
      <CardHeader
        title="Combos"
        subtitle="Combine multiple models with fallback or round-robin rotation"
        icon={<Layers size={16} />}
        action={
          <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openCreate}>
            New Combo
          </Button>
        }
      />
      <CardBody>
        {combosQuery.isPending ? (
          <LoadingState label="Loading combos..." />
        ) : combosQuery.isError ? (
          <ErrorState message="Failed to load combos" onRetry={() => combosQuery.refetch()} />
        ) : combos.length === 0 ? (
          <EmptyState
            title="No combos defined"
            message="Create a model combo to distribute requests across multiple models."
          />
        ) : (
          <Stack gap="10px">
            {combos.map((c) => (
              <div
                key={c.id}
                style={{
                  padding: "14px 16px",
                  borderRadius: "12px",
                  border: "1px solid var(--inner-border)",
                  background: "var(--surface-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flexWrap: "wrap",
                  }}
                >
                  <Inline gap="8px">
                    <strong style={{ fontSize: "14px" }}>{c.name}</strong>
                    <Badge tone="accent">
                      {c.strategy === "round_robin" ? "round-robin" : c.strategy}
                    </Badge>
                  </Inline>

                  <Inline gap="8px">
                    <Select
                      value={c.strategy}
                      onValueChange={(v) => handleStrategyChange(c, v as ComboStrategy)}
                      options={COMBO_STRATEGY_OPTIONS}
                    />
                    <Inline gap="4px">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Copy size={13} />}
                        onClick={() => handleCopy(c.name, c.id)}
                        title={copiedKey === c.id ? "Copied!" : "Copy combo name"}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil size={13} />}
                        onClick={() => openEdit(c)}
                        title="Edit combo"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 size={13} />}
                        onClick={() => setDeleteConfirm(c)}
                        title="Delete combo"
                        style={{ color: "var(--red)" }}
                      />
                    </Inline>
                  </Inline>
                </div>

                <Inline gap="6px" style={{ flexWrap: "wrap" }}>
                  {c.members.map((m) => (
                    <code
                      key={m}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        background: "var(--surface-3)",
                        border: "1px solid var(--inner-border)",
                        padding: "2px 8px",
                        borderRadius: "6px",
                      }}
                    >
                      {m}
                    </code>
                  ))}
                </Inline>
              </div>
            ))}
          </Stack>
        )}
      </CardBody>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingCombo ? "Edit Model Combo" : "New Model Combo"}
      >
        <form
          onSubmit={handleSave}
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Input
            label="Combo name"
            id="combo-name-input"
            value={comboName}
            onChange={(e) => setComboName(e.target.value)}
            placeholder="e.g. smart-combo, fast-pool"
            disabled={Boolean(editingCombo)}
            required
          />
          <Select
            label="Strategy"
            id="combo-strategy-select"
            value={strategy}
            onValueChange={(v) => setStrategy(v as ComboStrategy)}
            options={COMBO_STRATEGY_OPTIONS}
          />
          {strategy === "cascade" && (
            <div style={{ display: "flex", gap: "12px" }}>
              <Input
                label="Confidence threshold (0-100)"
                id="combo-cascade-threshold"
                type="number"
                min={0}
                max={100}
                value={cascadeThreshold}
                onChange={(e) => setCascadeThreshold(e.target.value)}
                style={{ flex: 1 }}
              />
              <Input
                label="Max stages (1-8)"
                id="combo-cascade-stages"
                type="number"
                min={1}
                max={8}
                value={cascadeMaxStages}
                onChange={(e) => setCascadeMaxStages(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          )}
          {strategy === "fusion" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <Input
                label="Judge model (optional, default: first panel member)"
                id="combo-fusion-judge"
                type="text"
                placeholder="e.g. provider/model-name"
                value={fusionJudgeModel}
                onChange={(e) => setFusionJudgeModel(e.target.value)}
              />
              <div style={{ display: "flex", gap: "12px" }}>
                <Input
                  label="Min panel answers (1-8)"
                  id="combo-fusion-minpanel"
                  type="number"
                  min={1}
                  max={8}
                  value={fusionMinPanel}
                  onChange={(e) => setFusionMinPanel(e.target.value)}
                  style={{ flex: 1 }}
                />
                <Input
                  label="Panel timeout (ms)"
                  id="combo-fusion-timeout"
                  type="number"
                  min={1000}
                  max={600000}
                  value={fusionPanelTimeoutMs}
                  onChange={(e) => setFusionPanelTimeoutMs(e.target.value)}
                  style={{ flex: 1 }}
                />
                <Input
                  label="Straggler grace (ms)"
                  id="combo-fusion-grace"
                  type="number"
                  min={0}
                  max={60000}
                  value={fusionStragglerGraceMs}
                  onChange={(e) => setFusionStragglerGraceMs(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
            </div>
          )}
          {strategy === "smart_routing" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <Textarea
                label="Tool-capable members (one per line, optional — default: all members)"
                id="combo-smart-tool-members"
                rows={3}
                placeholder="provider/model"
                value={smartToolMembers}
                onChange={(e) => setSmartToolMembers(e.target.value)}
              />
              <Textarea
                label="Members without tool support (excluded for tool requests)"
                id="combo-smart-no-tool-members"
                rows={2}
                placeholder="provider/model"
                value={smartNoToolMembers}
                onChange={(e) => setSmartNoToolMembers(e.target.value)}
              />
              <Textarea
                label="Research-preferred members (tried first for research intent)"
                id="combo-smart-research-members"
                rows={2}
                placeholder="provider/model"
                value={smartResearchMembers}
                onChange={(e) => setSmartResearchMembers(e.target.value)}
              />
              <Input
                label="Intent classifier model (optional — enables LLM fallback)"
                id="combo-smart-classifier"
                type="text"
                placeholder="e.g. provider/cheap-model"
                value={smartClassifierModel}
                onChange={(e) => setSmartClassifierModel(e.target.value)}
              />
            </div>
          )}
          {strategy === "swarm" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <Input
                label="Manager model (optional — default: first combo member)"
                id="combo-swarm-manager"
                type="text"
                placeholder="e.g. provider/strong-model"
                value={swarmManagerModel}
                onChange={(e) => setSwarmManagerModel(e.target.value)}
              />
              <Input
                label="Staff/audit model (optional — skips audit when empty)"
                id="combo-swarm-staff"
                type="text"
                placeholder="e.g. provider/strong-model"
                value={swarmStaffModel}
                onChange={(e) => setSwarmStaffModel(e.target.value)}
              />
              <Textarea
                label="Worker models (one per line, optional — default: all members)"
                id="combo-swarm-workers"
                rows={3}
                placeholder="provider/model"
                value={swarmWorkerModels}
                onChange={(e) => setSwarmWorkerModels(e.target.value)}
              />
              <Input
                label="Max subtasks dispatched per request"
                id="combo-swarm-worker-count"
                type="number"
                min={1}
                max={16}
                value={swarmWorkerCount}
                onChange={(e) => setSwarmWorkerCount(e.target.value)}
              />
            </div>
          )}
          <Stack gap="4px">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
                Member models (one per line, e.g. codex/gpt-5.5)
              </label>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                icon={<Search size={12} />}
                onClick={() => setPickerOpen(true)}
              >
                Browse models
              </Button>
            </div>
            <textarea
              value={membersText}
              onChange={(e) => setMembersText(e.target.value)}
              placeholder="codex/gpt-5.5&#10;openai/gpt-4o&#10;cerebras/llama3.3-70b"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid var(--inner-border)",
                background: "var(--input-bg)",
                color: "var(--text-primary)",
                resize: "vertical",
              }}
              required
            />
            {selectedMembers.length > 0 && (
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                {selectedMembers.map((m) => (
                  <span
                    key={m}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      padding: "2px 8px",
                      borderRadius: "6px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => handlePickerToggle(m)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Stack>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={selectedMembers}
            onToggle={handlePickerToggle}
            title="Select combo members"
            multi
          />
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" type="button" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                createMutation.isPending ||
                updateMutation.isPending ||
                !comboName.trim() ||
                !membersText.trim()
              }
            >
              {editingCombo ? "Save Changes" : "Create Combo"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Model Combo"
      >
        <Stack gap="12px">
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Are you sure you want to delete combo <strong>{deleteConfirm?.name}</strong>? Any
            aliases pointing to it will fail to resolve.
          </p>
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              style={{ background: "var(--red)", borderColor: "var(--red)" }}
              onClick={() => {
                if (deleteConfirm) {
                  deleteMutation.mutate(deleteConfirm.id, {
                    onSuccess: () => setDeleteConfirm(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Combo"}
            </Button>
          </div>
        </Stack>
      </Dialog>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function Combos(): ReactNode {
  return (
    <Stack gap="16px">
      <CombosSection />
      <AliasesSection />
    </Stack>
  );
}
