"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronDown, Loader2, Pause, Play, Plus, Save, Trash2, Webhook, Clock, XCircle, FlaskConical } from "lucide-react";
import { Badge, buttonClass, Card } from "@/components/ui/primitives";
import { createTranslator } from "@/i18n/translator";
import type { Messages } from "@/i18n/messages";
import { ApiError, createApi, type ConnectionInfo, type ConnectorInfo, type JsonSchema } from "@/lib/api/client";

type T = ReturnType<typeof createTranslator<Messages["app"]>>;

interface Step {
  id: string;
  connector: string;
  action: string;
  connectionId?: string | null;
  input: Record<string, unknown>;
}
interface Definition {
  trigger: { connector: string; trigger: string; connectionId?: string | null; config: Record<string, unknown> };
  steps: Step[];
}
interface WorkflowSummary {
  id: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  steps: number;
  trigger: Definition["trigger"];
  updatedAt: string;
}
interface Workflow {
  id: string;
  name: string;
  status: WorkflowSummary["status"];
  definition: Definition;
}
interface StepRecord {
  stepId: string;
  status: "succeeded" | "failed" | "skipped";
  output?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
}
interface Execution {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  source: "manual" | "test" | "webhook" | "poll";
  triggerData: unknown;
  steps: StepRecord[];
  error: string | null;
  createdAt: string;
}

const MANUAL = { connector: "manual", trigger: "manual" };
const STATUS_TONE = { DRAFT: "neutral", ACTIVE: "go", PAUSED: "warn" } as const;
const RUN_TONE = { QUEUED: "neutral", RUNNING: "brand", SUCCEEDED: "go", FAILED: "warn" } as const;

interface Props {
  apiUrl: string;
  csrfToken: string;
  messages: Messages["app"];
  dateLocale: string;
  integrationsHref: string;
  /** Workflow to open from the URL (?id=…), so a reload keeps the builder open. */
  initialOpenId?: string;
}

export function WorkflowsView({ apiUrl, csrfToken, messages, dateLocale, integrationsHref, initialOpenId }: Props) {
  const t = useMemo(() => createTranslator(messages, "app"), [messages]);
  const api = useMemo(() => createApi(apiUrl, csrfToken), [apiUrl, csrfToken]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | "new" | null>(initialOpenId ?? null);
  // Remount the builder only when the user opens a workflow, not when a new one gets its id on first save.
  const [openKey, setOpenKey] = useState(0);
  const syncUrl = (id: string | null) => {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("id", id);
    else u.searchParams.delete("id");
    window.history.replaceState(null, "", u);
  };
  const open = (id: string | "new") => {
    setOpenId(id);
    setOpenKey((k) => k + 1);
    syncUrl(id === "new" ? null : id);
  };
  const [error, setError] = useState<string | null>(null);

  const errorText = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.code === "workflow.invalid") {
          const issues = (err.body.issues as Array<{ path: string; message: string }> | undefined)?.map((i) => `${i.path}: ${i.message}`).join("; ") ?? "";
          return t("workflows.errors.workflow.invalid", { issues });
        }
        const wk = `workflows.errors.${err.code}`;
        const w = t(wk as never);
        if (w !== `app.${wk}`) return w;
        const ik = `integrations.errors.${err.code}`;
        const i = t(ik as never);
        if (i !== `app.${ik}`) return i;
      }
      return t("integrations.errors.generic");
    },
    [t],
  );

  const load = useCallback(async () => {
    try {
      const [cs, cn, wf] = await Promise.all([api.get<ConnectorInfo[]>("/integrations"), api.get<ConnectionInfo[]>("/connections"), api.get<WorkflowSummary[]>("/workflows")]);
      setConnectors(cs);
      setConnections(cn.filter((c) => c.status === "ACTIVE"));
      setList(wf);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, errorText]);

  useEffect(() => {
    // Initial load; setState happens asynchronously after the requests resolve.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (openId) {
    return (
      <Builder
        key={openKey}
        id={openId === "new" ? null : openId}
        api={api}
        t={t}
        connectors={connectors}
        connections={connections}
        dateLocale={dateLocale}
        integrationsHref={integrationsHref}
        errorText={errorText}
        onBack={() => {
          setOpenId(null);
          syncUrl(null);
          void load();
        }}
        onCreated={(id) => {
          setOpenId(id);
          syncUrl(id);
        }}
      />
    );
  }

  const nameOf = (id: string) => (id === "manual" ? t("workflows.builder.manual") : (connectors.find((c) => c.id === id)?.name ?? id));
  return (
    <div>
      <div className="mb-6 flex justify-end">
        <button type="button" className={buttonClass("primary")} onClick={() => open("new")}>
          <Plus className="size-4" aria-hidden />
          {t("workflows.new")}
        </button>
      </div>
      {error && <p role="alert" className="mb-4 text-sm text-warn-700">{error}</p>}
      {!list ? (
        <Loader2 className="size-4 animate-spin text-ink-400" aria-label="…" />
      ) : list.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-500">{t("workflows.empty")}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((w) => (
            <button key={w.id} type="button" onClick={() => open(w.id)} className="block w-full text-left">
              <Card className="!p-5 transition-colors hover:border-ink-200">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-ink-950">{w.name}</h3>
                      <Badge tone={STATUS_TONE[w.status]}>{t(`workflows.status.${w.status}`)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {nameOf(w.trigger.connector)} → {t("workflows.list.steps", { count: w.steps })}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-ink-700">{t("workflows.list.open")}</span>
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Builder ──────────────────────────────────────────────────────────────────

const emptyDefinition = (): Definition => ({ trigger: { ...MANUAL, connectionId: null, config: {} }, steps: [] });

function Builder({
  id: initialId,
  api,
  t,
  connectors,
  connections,
  dateLocale,
  integrationsHref,
  errorText,
  onBack,
  onCreated,
}: {
  id: string | null;
  api: ReturnType<typeof createApi>;
  t: T;
  connectors: ConnectorInfo[];
  connections: ConnectionInfo[];
  dateLocale: string;
  integrationsHref: string;
  errorText: (err: unknown) => string;
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const [id, setId] = useState(initialId);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Workflow["status"]>("DRAFT");
  const [def, setDef] = useState<Definition>(emptyDefinition);
  const [runs, setRuns] = useState<Execution[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "go" | "warn"; text: string } | null>(null);
  const [stepTests, setStepTests] = useState<Record<number, { ok: boolean; output?: unknown; error?: { code: string; message: string } }>>({});
  const [loading, setLoading] = useState(!!id);

  const loadRuns = useCallback(async () => {
    if (id) setRuns(await api.get<Execution[]>(`/workflows/${id}/executions`));
  }, [api, id]);

  // Load once for an existing workflow (a newly created one already has its state in memory).
  useEffect(() => {
    if (!initialId) return;
    void (async () => {
      try {
        const w = await api.get<Workflow>(`/workflows/${initialId}`);
        setName(w.name);
        setStatus(w.status);
        setDef(w.definition);
        setRuns(await api.get<Execution[]>(`/workflows/${initialId}/executions`));
      } catch (err) {
        setMessage({ tone: "warn", text: errorText(err) });
      } finally {
        setLoading(false);
      }
    })();
  }, [api, initialId, errorText]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: "warn", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    withBusy("save", async () => {
      const body = { name: name.trim() || t("workflows.untitled"), definition: def };
      if (id) {
        const w = await api.send<Workflow>("PATCH", `/workflows/${id}`, body);
        setStatus(w.status);
      } else {
        const w = await api.send<Workflow>("POST", "/workflows", body);
        setId(w.id);
        setStatus(w.status);
        onCreated(w.id);
      }
      setMessage({ tone: "go", text: t("workflows.builder.saved") });
    });

  const triggerConnector = connectors.find((c) => c.id === def.trigger.connector);
  const trigger = triggerConnector?.triggers.find((tr) => tr.key === def.trigger.trigger);
  const appsWithTriggers = connectors.filter((c) => c.triggers.length > 0);

  if (loading) return <Loader2 className="size-4 animate-spin text-ink-400" aria-label="…" />;

  /** Pre-selects the connection when the app has exactly one. */
  const onlyConnection = (provider: string) => {
    const list = connections.filter((c) => c.provider === provider);
    return list.length === 1 ? list[0]!.id : null;
  };
  const setTrigger = (patch: Partial<Definition["trigger"]>) => setDef((d) => ({ ...d, trigger: { ...d.trigger, ...patch } }));
  const setStep = (i: number, patch: Partial<Step>) => setDef((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  return (
    <div>
      <button type="button" onClick={onBack} className={`${buttonClass("ghost")} -ml-3 mb-4`}>
        <ArrowLeft className="size-4" aria-hidden />
        {t("workflows.builder.back")}
      </button>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="block min-w-64 flex-1">
          <span className="text-sm font-medium text-ink-900">{t("workflows.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("workflows.untitled")} maxLength={200} className="mt-1.5 h-10 w-full max-w-md rounded-lg border border-ink-200 bg-white px-3 text-sm outline-none focus:border-ink-400" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {id && <Badge tone={STATUS_TONE[status]}>{t(`workflows.status.${status}`)}</Badge>}
          <button type="button" disabled={!!busy} className={buttonClass("secondary")} onClick={save}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
            {t("workflows.builder.save")}
          </button>
          {id && (
            <>
              <button type="button" disabled={!!busy} className={buttonClass("secondary")} onClick={() => withBusy("run", async () => {
                await api.send("POST", `/workflows/${id}/run`, { wait: true });
                await loadRuns();
              })}>
                {busy === "run" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FlaskConical className="size-4" aria-hidden />}
                {t("workflows.builder.run")}
              </button>
              {status === "ACTIVE" ? (
                <button type="button" disabled={!!busy} className={buttonClass("secondary")} onClick={() => withBusy("pause", async () => setStatus((await api.send<Workflow>("POST", `/workflows/${id}/pause`)).status))}>
                  <Pause className="size-4" aria-hidden />
                  {t("workflows.builder.pause")}
                </button>
              ) : (
                <button type="button" disabled={!!busy} className={buttonClass("primary")} onClick={() => withBusy("activate", async () => setStatus((await api.send<Workflow>("POST", `/workflows/${id}/activate`)).status))}>
                  {busy === "activate" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
                  {t("workflows.builder.activate")}
                </button>
              )}
              <button type="button" disabled={!!busy} className={buttonClass("ghost")} aria-label={t("workflows.builder.delete")} onClick={() => window.confirm(t("workflows.builder.confirmDelete")) && withBusy("delete", async () => {
                await api.send("DELETE", `/workflows/${id}`);
                onBack();
              })}>
                <Trash2 className="size-4" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>

      {message && (
        <p role="status" className={`mt-4 flex items-start gap-2 text-sm ${message.tone === "go" ? "text-go-700" : "text-warn-700"}`}>
          {message.tone === "go" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {message.text}
        </p>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-4">
          {/* Trigger */}
          <Card testId="trigger-card">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t("workflows.builder.when")}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Select label={t("workflows.builder.app")} value={def.trigger.connector} onChange={(v) => setTrigger(v === "manual" ? { ...MANUAL, connectionId: null, config: {} } : { connector: v, trigger: connectors.find((c) => c.id === v)!.triggers[0]!.key, connectionId: onlyConnection(v), config: {} })} options={[{ value: "manual", label: t("workflows.builder.manual") }, ...appsWithTriggers.map((c) => ({ value: c.id, label: c.name }))]} />
              {triggerConnector && (
                <Select label={t("workflows.builder.event")} value={def.trigger.trigger} onChange={(v) => setTrigger({ trigger: v, config: {} })} options={triggerConnector.triggers.map((tr) => ({ value: tr.key, label: tr.name }))} />
              )}
            </div>
            {trigger && (
              <>
                <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-500">
                  {trigger.mode === "webhook" ? <Webhook className="size-3.5" aria-hidden /> : <Clock className="size-3.5" aria-hidden />}
                  {trigger.description} {trigger.mode === "webhook" ? t("workflows.builder.webhookNote") : t("workflows.builder.pollingNote", { minutes: trigger.pollIntervalMinutes ?? 5 })}
                </p>
                <ConnectionSelect t={t} provider={def.trigger.connector} connections={connections} value={def.trigger.connectionId ?? ""} onChange={(v) => setTrigger({ connectionId: v || null })} integrationsHref={integrationsHref} />
                <SchemaFields t={t} schema={trigger.configSchema} value={def.trigger.config} onChange={(config) => setTrigger({ config })} />
              </>
            )}
          </Card>

          {/* Steps */}
          {def.steps.map((step, i) => {
            const connector = connectors.find((c) => c.id === step.connector);
            const action = connector?.actions.find((a) => a.key === step.action);
            const test = stepTests[i];
            return (
              <Card key={i} testId={`step-card-${i}`}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                    {i + 1}. {t("workflows.builder.steps")}
                  </p>
                  <button type="button" className="text-xs font-medium text-ink-500 hover:text-warn-700" onClick={() => setDef((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}>
                    {t("workflows.builder.removeStep")}
                  </button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <TextField label={t("workflows.builder.stepId")} value={step.id} onChange={(v) => setStep(i, { id: v.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) })} mono />
                  <Select label={t("workflows.builder.app")} value={step.connector} onChange={(v) => setStep(i, { connector: v, action: connectors.find((c) => c.id === v)!.actions[0]!.key, connectionId: onlyConnection(v), input: {} })} options={connectors.filter((c) => c.actions.length).map((c) => ({ value: c.id, label: c.name }))} />
                  {connector && <Select label={t("workflows.builder.action")} value={step.action} onChange={(v) => setStep(i, { action: v, input: {} })} options={connector.actions.map((a) => ({ value: a.key, label: a.name }))} />}
                </div>
                {action && <p className="mt-2 text-xs text-ink-500">{action.description}</p>}
                {connector && connector.auth.type !== "none" && <ConnectionSelect t={t} provider={step.connector} connections={connections} value={step.connectionId ?? ""} onChange={(v) => setStep(i, { connectionId: v || null })} integrationsHref={integrationsHref} />}
                {action && <SchemaFields t={t} schema={action.inputSchema} value={step.input} onChange={(input) => setStep(i, { input })} />}
                <div className="mt-4 flex items-center gap-3">
                  <button type="button" disabled={busy === `step-${i}`} className={buttonClass("secondary")} onClick={() => withBusy(`step-${i}`, async () => {
                    // Earlier steps' test outputs and the trigger's sample data fill {{…}} templates, as in a real run.
                    const steps = Object.fromEntries(def.steps.slice(0, i).map((s, j) => [s.id, stepTests[j]?.ok ? stepTests[j]!.output : undefined]));
                    const r = await api.send<{ ok: boolean; output?: unknown; error?: { code: string; message: string } }>("POST", "/workflows/test-step", { connector: step.connector, action: step.action, connectionId: step.connectionId, input: step.input, triggerData: trigger?.sample ?? {}, steps });
                    setStepTests((s) => ({ ...s, [i]: r }));
                  })}>
                    {busy === `step-${i}` ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FlaskConical className="size-4" aria-hidden />}
                    {t("workflows.builder.testStep")}
                  </button>
                  {test && <Badge tone={test.ok ? "go" : "warn"}>{test.ok ? t("workflows.runs.status.SUCCEEDED") : t("workflows.runs.status.FAILED")}</Badge>}
                </div>
                {test && <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-ink-50 p-3 text-xs text-ink-800">{JSON.stringify(test.ok ? test.output : test.error, null, 2)}</pre>}
              </Card>
            );
          })}

          <button
            type="button"
            className={buttonClass("secondary")}
            onClick={() => {
              const first = connectors.find((c) => c.actions.length > 0);
              if (!first) return;
              setDef((d) => ({ ...d, steps: [...d.steps, { id: `step_${d.steps.length + 1}`, connector: first.id, action: first.actions[0]!.key, connectionId: onlyConnection(first.id), input: {} }] }));
            }}
          >
            <Plus className="size-4" aria-hidden />
            {t("workflows.builder.addStep")}
          </button>
          <p className="text-xs text-ink-500">{t("workflows.builder.templatesHint")}</p>
        </div>

        {/* Runs */}
        <div>
          <Card className="!p-5" testId="runs-card">
            <h2 className="text-sm font-semibold text-ink-950">{t("workflows.runs.title")}</h2>
            {runs.length === 0 ? (
              <p className="mt-3 text-sm text-ink-500">{t("workflows.runs.empty")}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {runs.map((r) => (
                  <li key={r.id}>
                    <details className="group rounded-lg border border-ink-100 p-3">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2">
                          <Badge tone={RUN_TONE[r.status]}>{t(`workflows.runs.status.${r.status}`)}</Badge>
                          <span className="text-xs text-ink-500">{t(`workflows.runs.source.${r.source}`)}</span>
                        </span>
                        <span className="flex items-center gap-1 text-xs text-ink-400">
                          {new Intl.DateTimeFormat(dateLocale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(r.createdAt))}
                          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
                        </span>
                      </summary>
                      <div className="mt-3 space-y-2 text-xs">
                        <p className="font-medium text-ink-700">{t("workflows.runs.input")}</p>
                        <pre className="max-h-40 overflow-auto rounded bg-ink-50 p-2 text-ink-800">{JSON.stringify(r.triggerData, null, 2)}</pre>
                        {r.steps.map((s) => (
                          <div key={s.stepId}>
                            <p className="flex items-center justify-between font-medium text-ink-700">
                              <span>{s.stepId}</span>
                              <span className="text-ink-400">{s.status === "skipped" ? t("workflows.runs.skipped") : t("workflows.runs.duration", { ms: s.durationMs })}</span>
                            </p>
                            {s.status !== "skipped" && <pre className={`mt-1 max-h-40 overflow-auto rounded p-2 ${s.status === "failed" ? "bg-warn-50 text-warn-700" : "bg-ink-50 text-ink-800"}`}>{JSON.stringify(s.status === "failed" ? s.error : s.output, null, 2)}</pre>}
                          </div>
                        ))}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Form helpers ─────────────────────────────────────────────────────────────

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-sm outline-none focus:border-ink-400">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({ label, value, onChange, mono, multiline, hint }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; multiline?: boolean; hint?: string }) {
  const cls = `mt-1 w-full rounded-lg border border-ink-200 bg-white px-2.5 text-sm outline-none focus:border-ink-400 ${mono ? "font-mono" : ""}`;
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {multiline ? <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} className={`${cls} py-2`} spellCheck={false} /> : <input value={value} onChange={(e) => onChange(e.target.value)} className={`${cls} h-9`} />}
      {hint && <span className="mt-0.5 block text-[11px] text-ink-400">{hint}</span>}
    </label>
  );
}

function ConnectionSelect({ t, provider, connections, value, onChange, integrationsHref }: { t: T; provider: string; connections: ConnectionInfo[]; value: string; onChange: (v: string) => void; integrationsHref: string }) {
  const options = connections.filter((c) => c.provider === provider);
  if (options.length === 0) {
    return (
      <p className="mt-3 text-xs text-warn-700">
        <a href={integrationsHref} className="underline underline-offset-2">{t("workflows.builder.noConnection")}</a>
      </p>
    );
  }
  return (
    <div className="mt-3 max-w-sm">
      <Select label={t("workflows.builder.connection")} value={value} onChange={onChange} options={[{ value: "", label: t("workflows.builder.selectConnection") }, ...options.map((c) => ({ value: c.id, label: c.displayName }))]} />
    </div>
  );
}

const typeOf = (s: JsonSchema): string => {
  if (s.enum) return "enum";
  const ty = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (ty) return ty;
  if (s.anyOf) {
    const kinds = s.anyOf.map(typeOf);
    return kinds.every((k) => ["string", "number", "integer"].includes(k)) ? "string" : "json";
  }
  return "json";
};

/**
 * Renders inputs from a JSON Schema (generated by the API from the connector's validation schema).
 * Scalars are text inputs (templates like {{trigger.x}} are allowed everywhere); objects and
 * arrays are JSON text areas.
 */
function SchemaFields({ t, schema, value, onChange }: { t: T; schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const props = Object.entries(schema.properties ?? {});
  if (!props.length) return null;
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === "" || v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {props.map(([key, s]) => {
        const kind = typeOf(s);
        const label = `${key}${schema.required?.includes(key) && s.default === undefined ? ` (${t("workflows.builder.required")})` : ""}`;
        const current = value[key];
        if (kind === "enum") {
          return <Select key={key} label={label} value={String(current ?? s.default ?? "")} onChange={(v) => set(key, v)} options={[{ value: "", label: "—" }, ...(s.enum ?? []).map((e) => ({ value: String(e), label: String(e) }))]} />;
        }
        if (kind === "boolean") {
          return <Select key={key} label={label} value={current === undefined ? "" : String(current)} onChange={(v) => set(key, v === "" ? undefined : v === "true")} options={[{ value: "", label: "—" }, { value: "true", label: "true" }, { value: "false", label: "false" }]} />;
        }
        if (kind === "object" || kind === "array" || kind === "json") {
          const text = drafts[key] ?? (current === undefined ? "" : JSON.stringify(current, null, 2));
          return (
            <div key={key} className="sm:col-span-2">
              <TextField
                label={label}
                value={text}
                mono
                multiline
                hint={t("workflows.builder.json")}
                onChange={(v) => {
                  setDrafts((d) => ({ ...d, [key]: v }));
                  if (!v.trim()) return set(key, undefined);
                  try {
                    set(key, JSON.parse(v));
                  } catch {
                    // keep the draft until it is valid JSON
                  }
                }}
              />
            </div>
          );
        }
        return (
          <TextField
            key={key}
            label={label}
            value={current === undefined ? "" : String(current)}
            hint={s.description}
            multiline={key === "text" || key === "html"}
            onChange={(v) => set(key, (kind === "number" || kind === "integer") && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)}
          />
        );
      })}
    </div>
  );
}
