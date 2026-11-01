import type { Pool, QueryResultRow } from "pg";

declare global { var __hymetPool: Pool | undefined; }
export function databaseConfigured() { return Boolean(process.env.DATABASE_URL); }
export async function databasePool(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!globalThis.__hymetPool) {
    const { Pool } = await import("pg");
    globalThis.__hymetPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  }
  return globalThis.__hymetPool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
  const pool = await databasePool();
  return pool.query<T>(sql, values);
}
