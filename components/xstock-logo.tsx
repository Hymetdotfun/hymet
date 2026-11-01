"use client";
import { useState } from "react";
import Image from "next/image";
import type { OfficialXstock } from "../lib/xstocks";
export function logoInitials(symbol: string) {
  return (
    symbol
      .replace(/x$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}
function Logo({ asset }: { asset: OfficialXstock }) {
  const [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false);
  return (
    <span className="xstock-icon" aria-hidden="true">
      {!loaded && <span>{logoInitials(asset.symbol)}</span>}
      {asset.icon && !failed && (
        <Image
          unoptimized
          width={30}
          height={30}
          src={`/api/xstocks/logo?mint=${encodeURIComponent(asset.mint)}`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setFailed(true);
            setLoaded(false);
          }}
        />
      )}
    </span>
  );
}
export function XstockLogo({ asset }: { asset: OfficialXstock }) {
  return <Logo key={`${asset.mint}:${asset.icon || ""}`} asset={asset} />;
}
