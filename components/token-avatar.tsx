"use client";
import { useState } from "react";
import Image from "next/image";

export function TokenAvatar({src,symbol,name}:{src?:string;symbol:string;name?:string}) {
  const [failedSrc,setFailedSrc]=useState<string>();
  return <span className="token-image token-placeholder" aria-label={name || symbol}>
    {src&&src!==failedSrc ? <Image unoptimized src={src} alt="" width={42} height={42} loading="lazy" onError={()=>setFailedSrc(src)}/> : (symbol||"H").slice(0,1).toUpperCase()}
  </span>;
}
