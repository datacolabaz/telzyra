"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Link2, Loader2, Plug, RefreshCw, Search, Trash2, Unplug, X, XCircle } from "lucide-react";
import { Badge, buttonClass, Card } from "@/components/ui/primitives";
import { createTranslator } from "@/i18n/translator";
import type { Messages } from "@/i18n/messages";
import { ApiError, createApi, type ConnectionInfo, type ConnectorInfo } from "@/lib/api/client";

type AppMessages = Messages["app"];

interface Props {
  apiUrl: string;
  csrfToken: string;
  canManage: boolean;
  messages: AppMessages;
  dateLocale: string;
  /** ?status=connected|error&reason=… after an OAuth redirect */
  result?: { status?: string; reason?: string };
  workflowsHref: string;
}

const STATUS_TONE = { ACTIVE: "go", EXPIRED: "warn", REVOKED: "neutral", ERROR: "warn" } as const;

export function IntegrationsView({ apiUrl, csrfToken, canManage, messages, dateLocale, result, workflowsHref }: Props) {
  const t = useMemo(() => createTranslator(messages, "app"), [messages]);
  const api = useMemo(() => createApi(apiUrl, csrfToken), [apiUrl, csrfToken]);
  const [tab, setTab] = useState<"marketplace" | "connections">(result?.status ? "connections" : "marketplace");
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<ConnectorInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "go" | "warn"; text: string } | null>(() =>
    result?.status === "connected" ? { tone: "go", text: t("integrations.result.connected") } : result?.status === "error" ? { tone: "warn", text: t("integrations.result.error", { reason: errorText(result.reason) }) } : null,
  );

  function errorText(code: string | undefined) {
    const key = `integrations.errors.${code ?? "generic"}`;
    const text = t(key as never);
    return text === `app.${key}` ? t("integrations.errors.generic") : text;
  }
  const fail = (err: unknown) => setNotice({ tone: "warn", text: errorText(err instanceof ApiError ? err.code : undefined) });

  const load = useCallback(async () => {
    try {
      const [cs, cn] = await Promise.all([api.get<ConnectorInfo[]>("/integrations"), api.get<ConnectionInfo[]>("/connections")]);
      setConnectors(cs);
      setConnections(cn);
    } catch (err) {
      fail(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    // Initial load; setState happens asynchronously after the requests resolve.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const filtered = (connectors ?? []).filter((c) => !query || `${c.name} ${c.description}`.toLowerCase().includes(query.toLowerCase()));
  const nameOf = (provider: string) => connectors?.find((c) => c.id === provider)?.name ?? provider;
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : t("integrations.connections.never"));

  async function action(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {notice && (
        <div role="status" className={`mb-6 flex items-start gap-2 rounded-lg px-4 py-3 text-sm ring-1 ring-inset ${notice.tone === "go" ? "bg-go-50 text-go-700 ring-go-600/15" : "bg-warn-50 text-warn-700 ring-warn-700/15"}`}>
          {notice.tone === "go" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="×" className="opacity-60 hover:opacity-100">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      <div role="tablist" className="mb-6 inline-flex rounded-lg bg-ink-100/70 p-1">
        {(["marketplace", "connections"] as const).map((k) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3.5 py-1.5 text-sm font-medium ${tab === k ? "bg-white text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900"}`}>
            {t(`integrations.tabs.${k}`)}
            {k === "connections" && connections ? ` (${connections.length})` : ""}
          </button>
        ))}
      </div>

      {!connectors ? (
        <div className="flex items-center gap-2 text-sm text-ink-500" aria-busy="true">
          <Loader2 className="size-4 animate-spin" aria-hidden />
        </div>
      ) : tab === "marketplace" ? (
        <>
          <label className="relative mb-5 block max-w-sm">
            <span className="sr-only">{t("integrations.search")}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("integrations.search")} className="h-9 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-ink-400" />
          </label>
          {!canManage && <p className="mb-4 text-sm text-ink-500">{t("integrations.card.adminOnly")}</p>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((c) => (
              <Card key={c.id} className="flex flex-col">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-ink-950">{c.name}</h3>
                  <Badge tone="neutral">{t(`integrations.categories.${c.category}` as never)}</Badge>
                </div>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-500">{c.description}</p>
                <p className="mt-3 text-xs text-ink-400">
                  {t("integrations.card.actions", { count: c.actions.length })} · {t("integrations.card.triggers", { count: c.triggers.length })} · {t(`integrations.auth.${c.auth.type}`)}
                </p>
                <div className="mt-4">
                  {c.auth.type === "none" ? (
                    <Badge tone="brand">{t("integrations.card.builtIn")}</Badge>
                  ) : !c.configured ? (
                    <Badge tone="warn">{t("integrations.card.notConfigured")}</Badge>
                  ) : (
                    <button type="button" disabled={!canManage} className={buttonClass("secondary")} onClick={() => setConnecting(c)}>
                      <Plug className="size-4" aria-hidden />
                      {t("integrations.card.connect")}
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : connections && connections.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-500">{t("integrations.connections.empty")}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {connections?.map((c) => (
            <Card key={c.id} className="!p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-ink-950">{nameOf(c.provider)}</h3>
                    <Badge tone={STATUS_TONE[c.status]}>{t(`integrations.status.${c.status}`)}</Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-ink-600">{c.displayName}</p>
                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink-500 sm:grid-cols-2">
                    <div>
                      <dt className="inline">{t("integrations.connections.lastChecked")}: </dt>
                      <dd className="inline">{date(c.lastCheckedAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline">{t("integrations.connections.usedBy")}: </dt>
                      <dd className="inline">{c.usedBy?.length ? c.usedBy.map((w) => w.name).join(", ") : t("integrations.connections.notUsed")}</dd>
                    </div>
                  </dl>
                  {c.lastError && <p className="mt-2 text-xs text-warn-700">{c.lastError}</p>}
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {c.status !== "REVOKED" && (
                      <button type="button" disabled={busy === c.id} className={buttonClass("secondary")} onClick={() => action(c.id, async () => {
                        const r = await api.send<ConnectionInfo>("POST", `/connections/${c.id}/test`);
                        setNotice(r.health?.ok ? { tone: "go", text: t("integrations.connections.testOk", { ms: r.health.latencyMs ?? 0 }) } : { tone: "warn", text: t("integrations.connections.testFailed", { error: errorText((r.health as { code?: string } | null)?.code) }) });
                        await load();
                      })}>
                        {busy === c.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                        {t("integrations.connections.test")}
                      </button>
                    )}
                    {c.authType === "OAUTH2" && (
                      <button type="button" className={buttonClass("secondary")} onClick={() => action(c.id, async () => {
                        const r = await api.send<{ url: string }>("POST", `/connections/${c.id}/reauthorize`, { redirectPath: window.location.pathname });
                        window.location.assign(r.url);
                      })}>
                        <Link2 className="size-4" aria-hidden />
                        {t("integrations.connections.reauthorize")}
                      </button>
                    )}
                    {c.status !== "REVOKED" ? (
                      <button type="button" className={buttonClass("ghost")} onClick={() => window.confirm(t("integrations.connections.confirmDisconnect", { name: c.displayName })) && action(c.id, async () => {
                        await api.send("POST", `/connections/${c.id}/disconnect`);
                        await load();
                      })}>
                        <Unplug className="size-4" aria-hidden />
                        {t("integrations.connections.disconnect")}
                      </button>
                    ) : (
                      <button type="button" className={buttonClass("ghost")} onClick={() => window.confirm(t("integrations.connections.confirmDelete")) && action(c.id, async () => {
                        await api.send("DELETE", `/connections/${c.id}`);
                        await load();
                      })}>
                        <Trash2 className="size-4" aria-hidden />
                        {t("integrations.connections.delete")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Card>
          ))}
          <p className="pt-2 text-sm">
            <a href={workflowsHref} className="font-medium text-ink-900 underline underline-offset-4">{t("nav.workflows")}</a>
          </p>
        </div>
      )}

      {connecting && (
        <ConnectDialog
          connector={connecting}
          t={t}
          onClose={() => setConnecting(null)}
          onConnect={async (values) => {
            if (connecting.auth.type === "oauth2") {
              const r = await api.send<{ url: string }>("POST", `/oauth/${connecting.id}/start`, { redirectPath: window.location.pathname, shop: values.shop });
              window.location.assign(r.url);
              return;
            }
            await api.send("POST", "/connections", { connector: connecting.id, secret: values.secret });
            setConnecting(null);
            setNotice({ tone: "go", text: t("integrations.result.connected") });
            setTab("connections");
            await load();
          }}
          errorText={errorText}
        />
      )}
    </div>
  );
}

function ConnectDialog({
  connector,
  t,
  onClose,
  onConnect,
  errorText,
}: {
  connector: ConnectorInfo;
  t: ReturnType<typeof createTranslator<AppMessages>>;
  onClose: () => void;
  onConnect: (v: { secret?: string; shop?: string }) => Promise<void>;
  errorText: (code?: string) => string;
}) {
  const [secret, setSecret] = useState("");
  const [shop, setShop] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauth = connector.auth.type === "oauth2";
  const needsShop = connector.id === "shopify";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="connect-title">
      <form
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          try {
            await onConnect({ secret: secret.trim() || undefined, shop: shop.trim().toLowerCase() || undefined });
          } catch (err) {
            setError(errorText(err instanceof ApiError ? String(err.body.providerCode ?? err.code) : undefined));
            setPending(false);
          }
        }}
      >
        <h2 id="connect-title" className="text-base font-semibold text-ink-950">{t("integrations.connect.title", { name: connector.name })}</h2>
        <p className="mt-1 text-sm text-ink-500">{connector.description}</p>

        {!oauth && (
          <label className="mt-5 block">
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
              <KeyRound className="size-4 text-ink-400" aria-hidden />
              {t("integrations.connect.secretLabel", { label: connector.auth.label ?? t(`integrations.auth.${connector.auth.type}`) })}
            </span>
            <input type="password" autoComplete="off" spellCheck={false} required value={secret} onChange={(e) => setSecret(e.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-ink-200 px-3 font-mono text-sm outline-none focus:border-ink-400" />
            <span className="mt-1.5 block text-xs text-ink-500">{connector.auth.hint ?? t("integrations.connect.secretHelp", { name: connector.name })}</span>
          </label>
        )}
        {needsShop && (
          <label className="mt-5 block">
            <span className="text-sm font-medium text-ink-900">{t("integrations.connect.shopLabel")}</span>
            <input required pattern="[a-z0-9][a-z0-9\-]*\.myshopify\.com" value={shop} onChange={(e) => setShop(e.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-ink-200 px-3 text-sm outline-none focus:border-ink-400" />
            <span className="mt-1.5 block text-xs text-ink-500">{t("integrations.connect.shopHelp")}</span>
          </label>
        )}
        {error && <p role="alert" className="mt-4 text-sm text-warn-700">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className={buttonClass("ghost")} onClick={onClose}>{t("integrations.connect.cancel")}</button>
          <button type="submit" disabled={pending} className={buttonClass("primary")}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {pending ? (oauth ? t("integrations.connect.redirecting", { name: connector.name }) : t("integrations.connect.verifying")) : t("integrations.connect.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
