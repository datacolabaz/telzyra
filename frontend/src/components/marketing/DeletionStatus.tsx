"use client";

import { useEffect, useState, type FormEvent } from "react";
import { buttonClass } from "@/components/ui/primitives";
import { interpolate } from "@/i18n/translator";

/** Looks up a platform data deletion request by its confirmation code (GET /v1/data-deletion/:code). */
export function DeletionStatus({ apiUrl, intl, labels }: { apiUrl: string; intl: string; labels: Record<string, string> }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<string>();
  const [pending, setPending] = useState(false);

  async function check(value: string) {
    const c = value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(c)) return setResult(labels.notFound);
    setPending(true);
    try {
      const res = await fetch(`${apiUrl}/v1/data-deletion/${c}`, { cache: "no-store" });
      if (res.status === 404) return setResult(labels.notFound);
      if (!res.ok) return setResult(labels.error);
      const r = (await res.json()) as { status: string; requested_at: string; completed_at: string | null };
      const date = new Intl.DateTimeFormat(intl, { dateStyle: "long" }).format(new Date(r.completed_at ?? r.requested_at));
      setResult(interpolate(labels[r.status] ?? labels.RECEIVED!, { date }));
    } catch {
      setResult(labels.error);
    } finally {
      setPending(false);
    }
  }

  // A link from Meta's confirmation (?code=…) is checked automatically.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("code");
    if (!fromUrl) return;
    let active = true;
    (async () => {
      if (!active) return;
      setCode(fromUrl);
      await check(fromUrl);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void check(code);
  };

  return (
    <section aria-labelledby="deletion-status-h" className="mt-8 rounded-xl border border-ink-100 bg-ink-50 p-5">
      <h2 id="deletion-status-h" className="text-base font-semibold text-ink-950">{labels.heading}</h2>
      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="deletion-code" className="block text-xs font-medium text-ink-700">{labels.label}</label>
          <input id="deletion-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" maxLength={20} className="mt-1 h-10 w-full rounded-lg border border-ink-200 bg-white px-3 font-mono text-sm uppercase" />
        </div>
        <button type="submit" disabled={pending} className={buttonClass("primary")}>{labels.check}</button>
      </form>
      {result && <p role="status" className="mt-3 text-sm text-ink-700">{result}</p>}
    </section>
  );
}
