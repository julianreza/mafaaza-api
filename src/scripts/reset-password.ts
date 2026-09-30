import { parseArgs } from "node:util";
import { EnvError, parseDbEnv } from "../config/env";
import { createDatabase } from "../db/client";
import { admins } from "../db/schema";
import { NO_CONTEXT } from "../lib/audit";
import { PASSWORD_MAX, PASSWORD_MIN, setPassword } from "../modules/auth/service";

/** Reset the (single) admin password; revokes every session. Returns the admin email. */
export async function resetAdminPassword(
  databaseUrl: string,
  password: string,
  opts: { prepare?: boolean } = {},
): Promise<string> {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new Error(`Password harus ${PASSWORD_MIN}-${PASSWORD_MAX} karakter`);
  }
  const database = createDatabase(databaseUrl, { max: 1, prepare: opts.prepare });
  try {
    const [admin] = await database.db.select().from(admins).limit(1);
    if (!admin) throw new Error("Belum ada akun admin. Jalankan `bun run db:seed` terlebih dahulu.");
    await setPassword(database.db, admin.id, password, new Date(), {
      action: "admin.password_reset_cli",
      ctx: NO_CONTEXT,
    });
    return admin.email;
  } finally {
    await database.close();
  }
}

async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const isTty = stdin.isTTY;
  if (isTty) stdin.setRawMode(true);
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          if (isTty) stdin.setRawMode(false);
          stdin.off("data", onData);
          stdin.pause();
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { password: { type: "string" } } });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL wajib diisi");
    process.exit(1);
  }
  let prepare: boolean;
  try {
    prepare = parseDbEnv(process.env).prepare;
  } catch (e) {
    console.error(e instanceof EnvError ? e.message : String(e));
    process.exit(1);
  }
  let password = values.password;
  if (!password) {
    password = await promptHidden("Password baru: ");
    const confirm = await promptHidden("Ulangi password baru: ");
    if (password !== confirm) {
      console.error("Password tidak sama");
      process.exit(1);
    }
  }
  try {
    const email = await resetAdminPassword(url, password, { prepare });
    console.log(`Password admin ${email} berhasil direset. Semua sesi login dibatalkan.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
