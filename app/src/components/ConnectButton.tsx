"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { shortAddress } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";

type Panel = { kind: "nowallet" } | { kind: "pick"; wallets: Connector[] } | { kind: "error"; message: string } | null;

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [panel, setPanel] = useState<Panel>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!panel) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPanel(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [panel]);

  async function connect() {
    setPanel(null);
    // Wallets announced through EIP-6963 (one connector each), then the classic window.ethereum injection.
    // With several wallets installed, let the user pick: opening whichever announced first can open the wrong one.
    const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
    if (announced.length > 1) return setPanel({ kind: "pick", wallets: announced });
    const hasInjected = typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
    const connector = announced[0] ?? (hasInjected ? connectors.find((c) => c.id === "injected") : undefined);
    if (!connector) return setPanel({ kind: "nowallet" });
    await connectWith(connector);
  }

  async function connectWith(connector: Connector) {
    setPanel(null);
    try {
      await connectAsync({ connector });
    } catch (e) {
      setPanel({ kind: "error", message: explain(e, "connect") });
    }
  }

  async function switchNetwork() {
    setPanel(null);
    try {
      await switchChainAsync({ chainId: wagmiConfig.chains[0].id });
    } catch (e) {
      setPanel({ kind: "error", message: explain(e, "switch") });
    }
  }

  const supported = wagmiConfig.chains.some((c) => c.id === chainId);
  const button = !isConnected ? (
    <button className="btn btn-primary" disabled={isPending} onClick={connect}>
      {isPending ? "Check your wallet…" : "Connect wallet"}
    </button>
  ) : !supported ? (
    <button className="btn btn-warn" disabled={switching} onClick={switchNetwork}>
      {switching ? "Check your wallet…" : "Switch to Robinhood Chain"}
    </button>
  ) : (
    <button className="btn" onClick={() => disconnect()} title="Disconnect">
      {shortAddress(address!)}
    </button>
  );

  return (
    <div className="connect" ref={ref}>
      {button}
      {panel?.kind === "nowallet" && <NoWallet />}
      {panel?.kind === "pick" && (
        <div className="connect-pop" role="dialog" aria-label="Choose a wallet">
          <h3>Choose a wallet</h3>
          {panel.wallets.map((w) => (
            <button key={w.uid} className="btn wide wallet-option" onClick={() => connectWith(w)}>
              {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
              {w.name}
            </button>
          ))}
        </div>
      )}
      {panel?.kind === "error" && (
        <div className="connect-pop" role="alert">
          <p>{panel.message}</p>
          <button className="btn btn-sm" onClick={() => setPanel(null)}>Close</button>
        </div>
      )}
    </div>
  );
}

function NoWallet() {
  const here = typeof window !== "undefined" ? window.location : undefined;
  const target = here ? `${here.host}${here.pathname}` : "stocklane.fun";
  const full = here ? here.href : "https://stocklane.fun";
  const mobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return (
    <div className="connect-pop" role="dialog" aria-label="No wallet found">
      <h3>No wallet in this browser</h3>
      {mobile ? (
        <>
          <p>Open StockLane inside your wallet app&apos;s browser to connect.</p>
          <a className="btn btn-primary wide" href={`https://metamask.app.link/dapp/${target}`}>Open in MetaMask</a>
          <a className="btn wide" href={`https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(full)}`}>Open in Coinbase Wallet</a>
        </>
      ) : (
        <>
          <p>Install a browser wallet such as MetaMask or Rabby, then reload this page.</p>
          <a className="btn btn-primary wide" href="https://metamask.io/download/" target="_blank" rel="noreferrer">Install MetaMask ↗</a>
          <a className="btn wide" href="https://rabby.io/" target="_blank" rel="noreferrer">Install Rabby ↗</a>
        </>
      )}
    </div>
  );
}

function explain(e: unknown, action: "connect" | "switch") {
  const err = e as { code?: number; name?: string; shortMessage?: string; message?: string; cause?: { code?: number } };
  const code = err.code ?? err.cause?.code;
  if (code === 4001 || err.name === "UserRejectedRequestError") {
    return action === "connect" ? "The request was declined in your wallet." : "The network switch was declined in your wallet.";
  }
  if (code === -32002) return "Your wallet already has a request open. Open the wallet and finish or dismiss it.";
  if (action === "switch") {
    return "Couldn't switch networks. Add Robinhood Chain in your wallet (chain ID 4663, RPC https://rpc.mainnet.chain.robinhood.com), then try again.";
  }
  return err.shortMessage || err.message || "Couldn't connect to your wallet.";
}
