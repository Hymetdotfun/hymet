import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALERT_POLICY, formatNotification, keeperAlerts, markSent, planNotifications } from "../lib/keeper-alerts.mjs";

const healthy = { now: 1_000_000, slot: 1_000n, keeperLamports: 1_000_000_000n, pools: [], indexedEpochs: new Map() };
const status = (sellerProofFailures: { mint: string; wallet: string; reason: string; kind: string }[]) => ({ at: new Date(1_000_000).toISOString(), ok: true, sellerProofFailures });
const mismatch = { mint: "MINT", wallet: "WALLET1", reason: "balance does not reproduce the committed snapshot hash", kind: "mismatch" };
const unavailable = { mint: "MINT", wallet: "WALLET2", reason: "origin snapshot balances are not stored", kind: "unavailable" };
const MIN = 60_000, t0 = 1_000_000_000;

describe("seller proof alerts", () => {
  it("stays quiet when every proof passes or none was needed", () => {
    expect(keeperAlerts({ ...healthy, status: status([]) })).toEqual([]);
    expect(keeperAlerts({ ...healthy, status: { at: new Date(1_000_000).toISOString(), ok: true } })).toEqual([]);
  });

  it("raises one alert per token and kind, naming the count, first wallet and that nothing was paid", () => {
    const alerts = keeperAlerts({ ...healthy, status: status([mismatch, { ...mismatch, wallet: "WALLET3" }, unavailable]) });
    expect(alerts.map((a) => a.code)).toEqual(["seller-proof-mismatch", "seller-proof-unavailable"]);
    expect(alerts[0].message).toMatch(/2 seller wallet\(s\) not paid; first WALLET1: balance does not reproduce/);
    expect(alerts[0].mint).toBe("MINT");
  });

  it("notifies a mismatch at once and hourly, and holds an unavailable proof for 30 minutes", () => {
    const [m] = keeperAlerts({ ...healthy, status: status([mismatch]) });
    const first = planNotifications({}, [m], t0);
    expect(first.due.map((d) => d.kind)).toEqual(["firing"]);
    const active = markSent(first.active, first.due, t0);
    expect(planNotifications({ active }, [m], t0 + 59 * MIN).due).toEqual([]);
    expect(planNotifications({ active }, [m], t0 + 60 * MIN).due.map((d) => d.kind)).toEqual(["reminder"]);
    expect(ALERT_POLICY.critical).toContain("seller-proof-mismatch");

    const [u] = keeperAlerts({ ...healthy, status: status([unavailable]) });
    const held = planNotifications({}, [u], t0);
    expect(held.due).toEqual([]);
    expect(planNotifications({ active: held.active }, [u], t0 + 30 * MIN).due.map((d) => d.kind)).toEqual(["firing"]);
  });

  it("reports recovery once a later snapshot proves the wallet", () => {
    const [m] = keeperAlerts({ ...healthy, status: status([mismatch]) });
    const first = planNotifications({}, [m], t0);
    const active = markSent(first.active, first.due, t0);
    expect(planNotifications({ active }, keeperAlerts({ ...healthy, status: status([]) }), t0 + MIN).due.map((d) => d.kind)).toEqual(["resolved"]);
  });

  it("has a readable title and removes credentials from the message", () => {
    const dirty = { ...unavailable, reason: "verification failed: fetch https://rpc.example/v2/SECRETKEY1 failed" };
    const [a] = keeperAlerts({ ...healthy, status: status([dirty]) });
    const { text } = formatNotification(planNotifications({}, [a], t0, {}, { ...ALERT_POLICY, holdoffMs: {} } as unknown as typeof ALERT_POLICY).due);
    expect(text).toContain("Seller snapshot proof unavailable");
    expect(text).not.toContain("SECRETKEY1");
  });
});

describe("migration 011 rollback", () => {
  const up = readFileSync("migrations/011_carry_origins.sql", "utf8"), down = readFileSync("migrations/rollback/011_carry_origins_down.sql", "utf8");
  const pairs = (sql: string, verb: string) => [...sql.matchAll(new RegExp(`ALTER TABLE (\\w+) ${verb} COLUMN IF (?:NOT )?EXISTS (\\w+)`, "g"))].map((m) => `${m[1]}.${m[2]}`).sort();

  it("drops exactly the columns the migration adds and removes its record, keeping carry amounts", () => {
    expect(pairs(down, "DROP")).toEqual(pairs(up, "ADD"));
    expect(down).toMatch(/DELETE FROM hymet_schema_migrations WHERE name = '011_carry_origins\.sql'/);
    expect(down).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM holder|COLUMN IF EXISTS amount/i);
  });
  it("is not picked up by the migration runner", () => {
    const runner = /^\d+_[a-z0-9_-]+\.sql$/i;
    expect(readdirSync("migrations").filter((n) => runner.test(n))).toContain("011_carry_origins.sql");
    expect(readdirSync("migrations").filter((n) => runner.test(n))).not.toContain("rollback");
    expect(runner.test("rollback")).toBe(false);
  });
});
