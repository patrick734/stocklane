"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { erc20Abi, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { useDeployment } from "@/lib/deployment";

type TxState = { busy: boolean; message?: string; error?: string };

export function useTx() {
  const { chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  const queryClient = useQueryClient();
  const { address, chainId: walletChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ busy: false });

  async function wait(hash: Hash) {
    if (!client) throw new Error("No RPC client");
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Transaction reverted");
  }

  async function ensureAllowance(token: Address, spender: Address, amount: bigint) {
    if (!client || !address) throw new Error("Connect a wallet first");
    const current = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, spender],
    });
    if (current >= amount) return;
    setState({ busy: true, message: "Approving…" });
    await wait(await writeContractAsync({ address: token, abi: erc20Abi, chainId, functionName: "approve", args: [spender, amount] }));
  }

  /** Runs the steps and returns whether the transaction confirmed. */
  async function run(label: string, steps: (helpers: { ensureAllowance: typeof ensureAllowance }) => Promise<Hash>): Promise<boolean> {
    setState({ busy: true, message: `${label}…` });
    try {
      if (walletChain !== chainId) {
        setState({ busy: true, message: "Switch your wallet network…" });
        await switchChainAsync({ chainId });
      }
      const hash = await steps({ ensureAllowance });
      setState({ busy: true, message: `${label}: confirming…` });
      await wait(hash);
      setState({ busy: false, message: `${label}: confirmed` });
      await queryClient.invalidateQueries();
      return true;
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setState({ busy: false, error: err.shortMessage || err.message || "Transaction failed" });
      return false;
    }
  }

  return { ...state, run, writeContractAsync };
}

export function TxStatus({ message, error }: { message?: string; error?: string }) {
  if (error) return <p className="tx-status error">{error}</p>;
  if (message) return <p className="tx-status">{message}</p>;
  return null;
}
