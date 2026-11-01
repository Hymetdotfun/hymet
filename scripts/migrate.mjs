import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running database migrations.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS hymet_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = resolve("migrations");
  const files = (await readdir(dir)).filter((n) => /^\d+_[a-z0-9_-]+\.sql$/i.test(n)).sort();
  for (const name of files) {
    const exists = await pool.query("SELECT 1 FROM hymet_schema_migrations WHERE name=$1", [name]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(dir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO hymet_schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
} finally { await pool.end(); }
