// Route quotes fan out into dozens of eth_calls; JSON-RPC batching sends them in a few requests.
import { createConfig, http, injected } from "wagmi";
import { localChain, robinhoodChain } from "./chains";

const includeLocal = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1";

export const wagmiConfig = includeLocal
  ? createConfig({
      chains: [localChain, robinhoodChain],
      connectors: [injected()],
      transports: { [robinhoodChain.id]: http(undefined, { batch: { batchSize: 24 } }), [localChain.id]: http() },
      ssr: true,
    })
  : createConfig({
      chains: [robinhoodChain],
      connectors: [injected()],
      transports: { [robinhoodChain.id]: http(undefined, { batch: { batchSize: 24 } }) },
      ssr: true,
    });

export const defaultChainId = includeLocal ? localChain.id : robinhoodChain.id;
