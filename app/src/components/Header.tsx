"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";
import { LogoMark } from "./Logo";
import { MarketChip } from "./MarketChip";

const NAV = [
  { href: "/", label: "Swap" },
  { href: "/burn", label: "Burn" },
  { href: "/safety", label: "Safety" },
];

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <header className="header">
      <Link href="/" className="brand">
        <LogoMark />
        <span>
          Stock<b>Lane</b>
        </span>
      </Link>
      <nav id="site-nav" className={open ? "nav open" : "nav"}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={(n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)) ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <MarketChip />
      <ConnectButton />
      <button
        className="menu-btn"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "✕" : "☰"}
      </button>
    </header>
  );
}
