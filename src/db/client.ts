import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Anything that can run a query: the root db or an open transaction. */
export type Executor = DB | Tx;

export interface Database {
  db: DB;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number; prepare?: boolean } = {}): Database {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // Transaction-mode poolers (e.g. Supabase port 6543) do not support prepared statements.
    prepare: opts.prepare ?? true,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Replace credentials in any postgres:// or postgresql:// URL inside `message` with `***`. */
export function redactDbUrl(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s@/]+@/g, "postgres://***@");
}
