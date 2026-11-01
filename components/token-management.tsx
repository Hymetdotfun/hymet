"use client";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Network } from "../lib/transactions";
import MyTokens from "./my-tokens";
import CreatorFees from "./creator-fees";
import { ApplicationPanel, type AppTab } from "./application-tabs";
export default function TokenManagement(props: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  network: Network;
  verifiedPool?: string;
}) {
  const wallet = useWallet();
  return (
    <Panel
      key={`${props.network}:${wallet.publicKey?.toBase58()}`}
      {...props}
    />
  );
}
function Panel({
  activeTab,
  onTabChange,
  network,
  verifiedPool,
}: {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  network: Network;
  verifiedPool?: string;
}) {
  const wallet = useWallet();
  const [requestedPool, setRequestedPool] = useState<{
      pool: string;
      requestId: number;
    }>(),
    [revision, setRevision] = useState(0);
  return (
    <>
      <ApplicationPanel id="tokens" active={activeTab}>
        <MyTokens
          network={network}
          owner={wallet.publicKey?.toBase58()}
          revision={revision}
          verifiedPool={verifiedPool}
          onFees={(pool) => {
            setRequestedPool({ pool, requestId: Date.now() });
            onTabChange("fees");
          }}
        />
      </ApplicationPanel>
      <ApplicationPanel id="fees" active={activeTab}>
        <div id="creator-fees">
          <CreatorFees
            network={network}
            verifiedPool={verifiedPool}
            requestedPool={requestedPool}
            onClaimConfirmed={() => setRevision((r) => r + 1)}
          />
        </div>
      </ApplicationPanel>
    </>
  );
}
