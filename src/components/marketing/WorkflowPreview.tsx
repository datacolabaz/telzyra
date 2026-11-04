import { getNode, type NodeId } from "@/engine/nodes";
import { getTranslations } from "@/i18n/server";
import { Badge } from "@/components/ui/primitives";
import { KIND_STYLES, NodeIcon } from "./NodeIcon";

async function NodeCard({ id }: { id: NodeId }) {
  const t = await getTranslations("nodes");
  const node = getNode(id);
  return (
    <div className="w-full rounded-xl border border-ink-100 bg-white p-3 shadow-[var(--shadow-card)] sm:w-44">
      <div className="flex items-center gap-2.5">
        <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${KIND_STYLES[node.kind]}`}>
          <NodeIcon node={node} />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{t(`kinds.${node.kind}`)}</p>
          <p className="truncate text-sm font-medium text-ink-950">{t(`${id}.label`)}</p>
        </div>
      </div>
      {/* Technical identifier: identical in every language */}
      <p className="mt-2.5 truncate font-mono text-[10.5px] text-ink-400" translate="no">{node.id}</p>
    </div>
  );
}

function Connector() {
  return (
    <div aria-hidden className="flex shrink-0 items-center justify-center sm:w-8">
      <div className="h-5 w-px bg-ink-300 sm:h-px sm:w-full" />
    </div>
  );
}

/** Static illustration of the editor. Clearly labelled as a preview; not interactive. */
export async function WorkflowPreview() {
  const t = await getTranslations("home");
  const c = await getTranslations("common");

  return (
    <figure
      aria-label={t("preview.ariaLabel")}
      className="overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-[var(--shadow-float)]"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 px-4 py-3">
        <div className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-ink-200" />
          <span className="size-2.5 rounded-full bg-ink-200" />
          <span className="size-2.5 rounded-full bg-ink-200" />
        </div>
        <p className="text-sm font-medium text-ink-900">{t("preview.workflowName")}</p>
        <Badge tone="go">
          <span className="size-1.5 rounded-full bg-go-600" aria-hidden />
          {t("preview.statusActive")}
        </Badge>
        <span className="ml-auto">
          <Badge>{c("labels.preview")}</Badge>
        </span>
      </div>

      <div className="bg-grid bg-ink-50/50 px-5 py-8 sm:px-8 sm:py-12">
        <div className="flex flex-col items-stretch sm:flex-row sm:items-center sm:justify-center">
          <NodeCard id="trigger.webhook" />
          <Connector />
          <NodeCard id="ai.text_extract" />
          <Connector />
          <NodeCard id="logic.condition" />
          <div aria-hidden className="hidden w-8 shrink-0 self-stretch sm:flex sm:items-center">
            <svg viewBox="0 0 32 120" preserveAspectRatio="none" className="h-[150px] w-full text-ink-300">
              <path d="M0 60 H12 C18 60 18 22 24 22 H32 M12 60 C18 60 18 98 24 98 H32" fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
          <Connector />
          <div className="flex flex-col gap-4 sm:gap-6">
            <NodeCard id="action.http_request" />
            <NodeCard id="action.send_email" />
          </div>
        </div>
      </div>

    </figure>
  );
}
