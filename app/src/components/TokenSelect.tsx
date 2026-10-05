"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtAmount } from "@/lib/format";
import type { Token } from "@/lib/tokens";

export function TokenBadge({ token }: { token: Token }) {
  return (
    <span className={`tok tok-${token.kind}`} aria-hidden>
      {token.kind === "usd" ? "$" : token.symbol.slice(0, 2)}
    </span>
  );
}

export function TokenSelect({
  tokens,
  value,
  other,
  balances,
  onChange,
}: {
  tokens: Token[];
  value: Token;
  other: Token;
  balances: Record<string, bigint | undefined>;
  onChange: (t: Token) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return tokens.filter((t) => !s || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s));
  }, [tokens, q]);

  return (
    <div className="token-select" ref={ref}>
      <button type="button" className="token-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <TokenBadge token={value} />
        {value.symbol}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="token-pop" role="listbox" aria-label="Choose a token">
          <input autoFocus placeholder="Search stocks" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="token-list">
            {shown.map((t) => (
              <button
                key={t.address}
                type="button"
                role="option"
                aria-selected={t.address === value.address}
                className={t.address === value.address ? "token-row active" : "token-row"}
                onClick={() => {
                  onChange(t);
                  setOpen(false);
                  setQ("");
                }}
              >
                <TokenBadge token={t} />
                <span className="token-row-name">
                  <b>{t.symbol}</b>
                  <small>{t.address === other.address ? "selected on the other side" : t.name}</small>
                </span>
                <span className="num muted">{balances[t.address.toLowerCase()] ? fmtAmount(balances[t.address.toLowerCase()], t.decimals) : ""}</span>
              </button>
            ))}
            {!shown.length && <p className="muted pad">No match.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
