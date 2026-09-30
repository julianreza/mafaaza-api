import { count } from "drizzle-orm";
import type { Executor } from "./client";
import { admins, expenseCategories } from "./schema";

export const DEFAULT_EXPENSE_CATEGORIES = [
  "Bahan Baku Ayam",
  "Tepung & Bumbu",
  "Minyak Goreng",
  "Gas/LPG",
  "Kemasan",
  "Gaji Karyawan",
  "Sewa Tempat",
  "Listrik & Air",
  "Transportasi",
  "Perawatan & Perbaikan",
  "Lain-lain",
] as const;

export interface SeedAdminInput {
  email: string;
  password: string;
  name: string;
}

export interface SeedResult {
  adminCreated: boolean;
  categoriesInserted: number;
}

/** Idempotent seed: creates the admin only when none exists; inserts missing default categories. */
export async function seed(db: Executor, admin: SeedAdminInput): Promise<SeedResult> {
  let adminCreated = false;
  const [{ n }] = await db.select({ n: count() }).from(admins);
  if (n === 0) {
    const passwordHash = await Bun.password.hash(admin.password, { algorithm: "argon2id" });
    await db.insert(admins).values({ email: admin.email.trim(), name: admin.name.trim(), passwordHash });
    adminCreated = true;
  }
  const inserted = await db
    .insert(expenseCategories)
    .values(DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ name })))
    .onConflictDoNothing()
    .returning({ id: expenseCategories.id });
  return { adminCreated, categoriesInserted: inserted.length };
}

if (import.meta.main) {
  const { createDatabase } = await import("./client");
  const { EnvError, parseDbEnv } = await import("../config/env");
  let prepare: boolean;
  try {
    prepare = parseDbEnv(process.env).prepare;
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  const missing = Object.entries({ DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Variabel wajib untuk seed belum diisi: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (ADMIN_PASSWORD!.length < 8) {
    console.error("ADMIN_PASSWORD minimal 8 karakter");
    process.exit(1);
  }
  const database = createDatabase(DATABASE_URL!, { max: 1, prepare });
  try {
    const r = await seed(database.db, { email: ADMIN_EMAIL!, password: ADMIN_PASSWORD!, name: ADMIN_NAME! });
    console.log(
      `${r.adminCreated ? "Akun admin dibuat" : "Akun admin sudah ada (tidak diubah)"}; ${r.categoriesInserted} kategori pengeluaran ditambahkan`,
    );
  } finally {
    await database.close();
  }
}
