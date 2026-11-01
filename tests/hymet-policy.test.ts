import { describe, expect, it } from "vitest";
import { normalizeName, normalizeTicker, rewardSplit } from "../lib/hymet-policy";
import { validateArtwork } from "../lib/artwork";
import { png500 } from "./fixtures/png-500";
import { defaults, validate } from "../lib/config";

describe("HYMET launch policy",()=>{
  it("normalizes Unicode-equivalent names and case-insensitive tickers",()=>{
    expect(normalizeName("  HYPE   Café ")).toBe(normalizeName("hype cafe\u0301"));
    expect(normalizeTicker(" hype ")).toBe("HYPE");
  });
  it("preserves the 20% platform share and partitions only the remaining 80%",()=>{
    expect(rewardSplit(0)).toEqual({hymet:20,creatorPercent:0,holderPercent:100,creatorBpsOfRemaining:0});
    expect(rewardSplit(65)).toEqual({hymet:20,creatorPercent:65,holderPercent:35,creatorBpsOfRemaining:6500});
    expect(rewardSplit(100)).toEqual({hymet:20,creatorPercent:100,holderPercent:0,creatorBpsOfRemaining:10000});
    expect(rewardSplit(42)).toMatchObject({creatorPercent:42,holderPercent:58,creatorBpsOfRemaining:4200});
    for (const bad of [-5, -1, 101, 105, 80.5, NaN]) expect(()=>rewardSplit(bad)).toThrow();
    for (const ok of ["0","1","7","50","73","99","100"]) expect(()=>validate({...defaults,name:"Split",symbol:"SPL",creatorShare:ok})).not.toThrow();
    for (const bad of ["101","110","-5","40.5","080x","07"," 7",""]) expect(()=>validate({...defaults,name:"Split",symbol:"SPL",creatorShare:bad})).toThrow();
  });
  it("rejects Solana native SOL as a launch quote and caps trading fees at 3%",()=>{
    const launch={...defaults,name:"Policy",symbol:"POL"};
    expect(()=>validate({...launch,quote:"sol"})).toThrow(/HYPE/);
    expect(()=>validate({...launch,fee:"3.01"})).toThrow();
    expect(()=>validate({...launch,supply:"100000000"})).toThrow(/fixed/);
  });
});

describe("launch artwork validation",()=>{
  it("accepts valid exact-size PNG and rejects dimensions, MIME mismatch and malformed bytes",()=>{
    const valid=png500();
    expect(validateArtwork(valid,"image/png")).toEqual({format:"image/png",width:500,height:500});
    expect(()=>validateArtwork(valid,"image/jpeg")).toThrow(/type/);
    expect(()=>validateArtwork(valid.subarray(0,40),"image/png")).toThrow();
    const wrong=Buffer.from(valid);wrong.writeUInt32BE(499,16);
    expect(()=>validateArtwork(wrong,"image/png")).toThrow();
  });
});
