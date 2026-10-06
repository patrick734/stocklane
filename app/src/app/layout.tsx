import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import { X_URL } from "@/lib/links";
import "./globals.css";

const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

// Absolute base for link-preview images. NEXT_PUBLIC_SITE_URL overrides the production domain.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://stocklane.fun";
const tagline = "The best price for tokenized stocks on Robinhood Chain, across Uniswap v3 and v4.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "StockLane",
  description: `${tagline} Every swap is checked against Chainlink, and its 0.05% fee buys and burns $LANE. No admin keys: every change waits 48 hours in a public timelock.`,
  openGraph: { title: "StockLane", description: tagline, siteName: "StockLane", type: "website" },
  twitter: { card: "summary_large_image", title: "StockLane", description: tagline },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
          <footer className="footer">
            <span className="footer-links">
              <a href={X_URL} target="_blank" rel="noreferrer">X</a>
              <a href="/safety">Safety</a>
            </span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
