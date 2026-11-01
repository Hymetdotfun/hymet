"use client";

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { APP_NETWORK, APP_RPC_PATH } from "../lib/app-network";

export function WalletAppProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const endpoint =
    typeof window === "undefined"
      ? `http://127.0.0.1:3001${APP_RPC_PATH}`
      : `${window.location.origin}${APP_RPC_PATH}`;

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider
        wallets={wallets}
        autoConnect={false}
        localStorageKey={`hymet:${process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK || APP_NETWORK}:walletName`}
      >
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
