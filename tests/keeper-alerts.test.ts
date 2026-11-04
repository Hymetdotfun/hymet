import { describe, expect, it } from "vitest";
import { ALERT_POLICY, KEEPER_ALERT_LIMITS, formatNotification, keeperAlerts, limitsForSlotTime, markSent, planNotifications, redactSecrets } from "../lib/keeper-alerts.mjs";
import { sendTelegram, telegramConfig } from "../lib/telegram.mjs";

type Input = {
  now: number;
  slot: bigint;
  keeperLamports: bigint;
  status: { at: string; ok: boolean; errors?: unknown[]; settlementErrors?: { mint: string; error: string }[]; migrationErrors?: { mint: string; error: string }[]; carrying?: string[] } | null;
  pools: { mint: string; nextEpoch: bigint; openEpoch: { number: bigint; snapshotSlot: bigint } | null; holderUnallocated?: bigint; lastSnapshotSlot?: bigint }[];
  indexedEpochs: Map<string, Set<string>>;
  units?: { name: string; state: string }[];
  graduations?: { mint: string; ageMs: number; lastError: string | null; dammRegistered: boolean }[];
};
const now = Date.parse("2026-11-03T12:00:00Z");
const healthy: Input = {
  now,
  slot: 1_000_000n,
  keeperLamports: 200_000_000n,
  status: { at: "2026-11-03T11:55:00Z", ok: true, errors: [] },
  pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: null }],
  indexedEpochs: new Map([["MINT", new Set(["0", "1"])]]),
};
const codes = (input: Partial<Input>) => keeperAlerts({ ...healthy, ...input }).map((a) => a.code);

describe("keeper alerts", () => {
  it("stay quiet for a funded, recent, fully indexed keeper", () => {
    expect(codes({})).toEqual([]);
  });

  it("flag low SOL, a missing, stale or failed run", () => {
    expect(codes({ keeperLamports: 49_999_999n })).toEqual(["keeper-sol-low"]);
    expect(codes({ status: null })).toEqual(["keeper-no-status"]);
    expect(codes({ status: { at: "2026-11-03T11:00:00Z", ok: true, errors: [] } })).toEqual(["keeper-stale"]);
    expect(codes({ status: { at: "2026-11-03T11:59:00Z", ok: false, errors: [{ mint: "MINT", error: "429" }] } })).toEqual(["keeper-failed"]);
  });

  it("flag an epoch open for more than 1 hour, not before", () => {
    const pool = (age: bigint) => [{ mint: "MINT", nextEpoch: 2n, openEpoch: { number: 1n, snapshotSlot: 1_000_000n - age } }];
    expect(codes({ pools: pool(9_001n) })).toEqual(["epoch-open-too-long"]);
    expect(codes({ pools: pool(9_000n) })).toEqual([]);
  });

  it("flag a service that is not running", () => {
    expect(codes({ units: [{ name: "keeper.timer", state: "active" }, { name: "watcher.service", state: "failed" }] })).toEqual(["keeper-unit-down"]);
  });

  it("flag failing settlement and migration the keeper run survived", () => {
    const at = "2026-11-03T11:59:00Z";
    expect(codes({ status: { at, ok: true, settlementErrors: [{ mint: "MINT", error: "x" }] } })).toEqual(["settlement-stalled"]);
    expect(codes({ status: { at, ok: true, migrationErrors: [{ mint: "MINT", error: "x" }] } })).toEqual(["migration-stalled"]);
  });

  it("flag a graduation only until the DAMM v2 pool is registered, once per mint", () => {
    const stuck = { mint: "MINT", ageMs: 3_600_000, lastError: "boom", dammRegistered: false };
    expect(codes({ graduations: [stuck] })).toEqual(["migration-stalled"]);
    expect(codes({ graduations: [{ ...stuck, dammRegistered: true }] })).toEqual([]);
    expect(codes({ graduations: [stuck], status: { at: "2026-11-03T11:59:00Z", ok: true, migrationErrors: [{ mint: "MINT", error: "x" }] } })).toEqual(["migration-stalled"]);
  });

  it("flag holder HYPE past its payout time, unless it is carrying or below the minimum", () => {
    const pool = { mint: "MINT", nextEpoch: 2n, openEpoch: null, holderUnallocated: 10_000_000n, lastSnapshotSlot: 1_000_000n - 9_001n };
    expect(codes({ pools: [pool] })).toEqual(["payout-overdue"]);
    expect(codes({ pools: [{ ...pool, lastSnapshotSlot: 0n }] })).toEqual(["payout-overdue"]);
    expect(codes({ pools: [{ ...pool, lastSnapshotSlot: 1_000_000n - 9_000n }] })).toEqual([]);
    expect(codes({ pools: [{ ...pool, holderUnallocated: 9_999_999n }] })).toEqual([]);
    expect(codes({ pools: [pool], status: { at: "2026-11-03T11:59:00Z", ok: true, carrying: ["MINT"] } })).toEqual([]);
  });

  it("flag a funded epoch whose root the keeper never prepared, after a short indexing grace", () => {
    const rogue = { indexedEpochs: new Map([["MINT", new Set(["0"])]]) };
    expect(codes({ ...rogue, pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: null }] })).toEqual(["unexpected-epoch"]);
    expect(codes({ ...rogue, pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: { number: 1n, snapshotSlot: 999_000n } }] })).toEqual([]);
    expect(codes({ ...rogue, pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: { number: 1n, snapshotSlot: 995_000n } }] })).toEqual(["unexpected-epoch"]);
  });
});

describe("alert windows at the measured slot time", () => {
  it("keep the same real durations when slots are faster than nominal", () => {
    const fast = limitsForSlotTime(200);
    expect(fast.maxOpenEpochSlots).toBe(18_000n);
    expect(fast.payoutOverdueSlots).toBe(18_000n);
    expect(fast.indexGraceSlots).toBe(3_000n);
    expect(fast.minLamports).toBe(KEEPER_ALERT_LIMITS.minLamports);
  });
  it("keep nominal windows for unknown or implausible slot times", () => {
    for (const bad of [NaN, 0, 50, 5_000, Infinity]) expect(limitsForSlotTime(bad)).toEqual(KEEPER_ALERT_LIMITS);
    expect(limitsForSlotTime(400)).toEqual(KEEPER_ALERT_LIMITS);
  });
  it("do not call a round overdue before 1 real hour at fast slots", () => {
    const base = { now, keeperLamports: 200_000_000n, status: { at: "2026-11-03T11:55:00Z", ok: true, errors: [] }, indexedEpochs: new Map([["MINT", new Set(["0"])]]) };
    const pool = (ago: bigint) => [{ mint: "MINT", nextEpoch: 1n, openEpoch: null, holderUnallocated: 20_000_000n, lastSnapshotSlot: 10_000_000n - ago }];
    const at = (ago: bigint) => keeperAlerts({ ...base, slot: 10_000_000n, pools: pool(ago) }, limitsForSlotTime(214.5)).map((a) => a.code);
    expect(at(4_200n)).toEqual([]); // about 15 real minutes, a normal gap
    expect(at(15_000n)).toEqual([]); // about 54 real minutes
    expect(at(17_000n)).toEqual(["payout-overdue"]); // about 61 real minutes
  });
});

describe("alert notifications", () => {
  const MIN = 60_000, t0 = Date.parse("2026-11-03T12:00:00Z");
  const failed = { code: "keeper-failed", message: "boom" };
  const low = { code: "keeper-sol-low", message: "low" };
  const kinds = (due: { kind: string; entry: { code: string } }[]) => due.map((d) => `${d.kind}:${d.entry.code}`);
  // One run: plan, pretend the send worked, return the next state.
  const run = (state: { active?: Record<string, unknown> }, alerts: { code: string; message: string; mint?: string }[], now: number) => {
    const { active, due } = planNotifications(state, alerts, now);
    return { due: kinds(due), state: { active: markSent(active, due, now) } };
  };

  it("notify at once for an alert with no holdoff, then remind every 6 hours", () => {
    let r = run({}, [low], t0);
    expect(r.due).toEqual(["firing:keeper-sol-low"]);
    r = run(r.state, [low], t0 + 5 * MIN);
    expect(r.due).toEqual([]);
    r = run(r.state, [low], t0 + 360 * MIN);
    expect(r.due).toEqual(["reminder:keeper-sol-low"]);
  });

  it("stay silent when a failure clears within its holdoff", () => {
    let r = run({}, [failed], t0);
    expect(r.due).toEqual([]);
    r = run(r.state, [], t0 + 5 * MIN);
    expect(r.due).toEqual([]);
    expect(r.state.active).toEqual({});
  });

  it("notify after the holdoff, then report recovery once", () => {
    let r = run({}, [failed], t0);
    r = run(r.state, [failed], t0 + 10 * MIN);
    expect(r.due).toEqual(["firing:keeper-failed"]);
    r = run(r.state, [], t0 + 15 * MIN);
    expect(r.due).toEqual(["resolved:keeper-failed"]);
    r = run(r.state, [], t0 + 20 * MIN);
    expect(r.due).toEqual([]);
  });

  it("retry on the next run when a send failed", () => {
    const first = planNotifications({}, [low], t0);
    expect(kinds(first.due)).toEqual(["firing:keeper-sol-low"]); // not marked sent
    expect(kinds(planNotifications({ active: first.active }, [low], t0 + 5 * MIN).due)).toEqual(["firing:keeper-sol-low"]);
  });

  it("do not resolve active alerts when the check itself crashed", () => {
    const r = run({}, [low], t0);
    const crashed = planNotifications(r.state, [{ code: "alert-check-failed", message: "db down" }], t0 + 5 * MIN, { partial: true });
    expect(kinds(crashed.due)).toEqual([]);
    expect(crashed.active["keeper-sol-low|"].resolved).toBe(false);
  });

  it("put a suspected key compromise first and repeat it hourly", () => {
    const rogue = { code: "unexpected-epoch", mint: "MINT", message: "rogue" };
    let r = run({}, [low, rogue], t0);
    expect(r.due[0]).toBe("firing:unexpected-epoch");
    r = run(r.state, [low, rogue], t0 + 60 * MIN);
    expect(r.due).toEqual(["reminder:unexpected-epoch"]);
  });

  it("track each mint separately", () => {
    const r = run({}, [{ ...low, code: "epoch-open-too-long", mint: "A" }, { ...low, code: "epoch-open-too-long", mint: "B" }], t0);
    expect(r.due).toHaveLength(2);
  });

  it("never let a secret into a message", () => {
    const token = "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll";
    const dirty = `fetch https://rpc.example/?api-key=SECRET1 failed postgres://u:p@h/d api_key=SECRET2 ${token}`;
    const clean = redactSecrets(dirty);
    for (const s of ["SECRET1", "SECRET2", "u:p@h", token]) expect(clean).not.toContain(s);
    const { due } = planNotifications({}, [{ code: "keeper-sol-low", message: dirty }], t0);
    expect(formatNotification(due).text).not.toContain("SECRET1");
  });

  it("stay under Telegram's limit and leave the overflow due", () => {
    const alerts = Array.from({ length: 40 }, (_, i) => ({ code: "epoch-open-too-long", mint: `MINT${i}`, message: "x".repeat(400) }));
    const { due } = planNotifications({}, alerts, t0);
    const { text, included } = formatNotification(due);
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(due.length);
  });

  it("have a holdoff for every alert the rules raise", () => {
    for (const code of ["keeper-sol-low", "keeper-no-status", "keeper-stale", "keeper-failed", "keeper-unit-down", "migration-stalled", "settlement-stalled", "payout-overdue", "epoch-open-too-long", "unexpected-epoch", "alert-check-failed"])
      expect(Object.keys(ALERT_POLICY.holdoffMs)).toContain(code);
  });
});

describe("telegram delivery", () => {
  const token = "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll";
  const config = { token, chatId: "42" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("is off when unset and refuses half or malformed settings without echoing them", () => {
    expect(telegramConfig({})).toBeNull();
    expect(telegramConfig({ HYMET_TELEGRAM_BOT_TOKEN: token, HYMET_TELEGRAM_CHAT_ID: "42" })).toEqual(config);
    expect(() => telegramConfig({ HYMET_TELEGRAM_BOT_TOKEN: token })).toThrow(/CHAT_ID/);
    expect(() => telegramConfig({ HYMET_TELEGRAM_BOT_TOKEN: "not-a-token", HYMET_TELEGRAM_CHAT_ID: "42" })).toThrow(/^(?!.*not-a-token)/);
  });

  it("posts plain text to the configured chat", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => { calls.push({ body: JSON.parse(init.body) }); return json(200, { ok: true }); }) as unknown as typeof fetch;
    await sendTelegram(config, "hello", { fetchImpl, silent: true });
    expect(calls[0].body).toMatchObject({ chat_id: "42", text: "hello", disable_notification: true });
    expect(calls[0].body).not.toHaveProperty("parse_mode");
  });

  it("waits out one rate limit", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchImpl = (async () => (n++ === 0 ? json(429, { parameters: { retry_after: 3 } }) : json(200, { ok: true }))) as unknown as typeof fetch;
    await sendTelegram(config, "hi", { fetchImpl, sleep: async (ms: number) => { slept.push(ms); } });
    expect(slept).toEqual([3_000]);
    expect(n).toBe(2);
  });

  it("never exposes the token in an error", async () => {
    const rejecting = (async () => json(401, { description: `Unauthorized ${token}` })) as unknown as typeof fetch;
    const a = await sendTelegram(config, "x", { fetchImpl: rejecting }).catch((e: Error) => e.message);
    expect(a).toContain("HTTP 401");
    expect(a).not.toContain(token);
    const offline = (async (url: string) => { throw Error(`connect failed ${url}`); }) as unknown as typeof fetch;
    const b = await sendTelegram(config, "x", { fetchImpl: offline }).catch((e: Error) => e.message);
    expect(b).toContain("Telegram request failed");
    expect(b).not.toContain(token);
  });
});
