# Tasks: Connect mafaaza-api to Supabase Postgres via Drizzle

Run all commands from `/Users/rezajulian/Kiro/mafaaza/mafaaza-api` with Bun. Do not add or upgrade npm packages: `drizzle-orm` 0.45.3, `drizzle-kit` 0.31.11 and `postgres` 3.4.9 are already installed.

- [x] 1. Add the database env settings to `src/config/env.ts`
  - [x] 1.1 Export a standalone helper `parseDbEnv(source: Record<string, string | undefined>): { prepare: boolean; migrationUrl: string | undefined }`. `DATABASE_PREPARE` accepts only `true`/`false` (unset or empty means `true`). Any other value throws `EnvError` naming `DATABASE_PREPARE`. `DATABASE_MIGRATION_URL`, when set, must match `^postgres(ql)?://`; otherwise it throws `EnvError` naming `DATABASE_MIGRATION_URL`. The helper stays independent of `JWT_SECRET`/`CORS_ORIGINS`, so the CLI scripts can call it.
  - [x] 1.2 Add `DATABASE_PREPARE: boolean` and `DATABASE_MIGRATION_URL?: string` to the `Env` interface. `parseEnv` fills them by calling `parseDbEnv`, and reports these errors together with the other variable errors in one `EnvError`.
  - [x] 1.3 Extend `tests/unit/env.test.ts` to cover: the default `DATABASE_PREPARE` is `true`; `"false"` gives `false`; `"no"` throws with `DATABASE_PREPARE` in the message; an unset `DATABASE_MIGRATION_URL` gives `undefined`; a valid URL is returned; `mysql://x` throws with `DATABASE_MIGRATION_URL` in the message. Verify with `bun run test:unit` and `bun run typecheck`.
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 4.2_

- [x] 2. Make the Drizzle client pooler-compatible
  - [x] 2.1 In `src/db/client.ts`, extend `createDatabase(url, opts)` with `opts.prepare?: boolean` (default `true`) and pass it to `postgres(url, { max, prepare, onnotice })`.
  - [x] 2.2 In `src/index.ts`, call `createDatabase(env.DATABASE_URL, { prepare: env.DATABASE_PREPARE })`. In the startup `SELECT 1` failure log, run the error message through a new `redactDbUrl(message)` helper (exported from `src/db/client.ts`) that replaces any `postgres(ql)://user:password@` credentials with `postgres://***@`.
  - [x] 2.3 In `src/db/seed.ts` and `src/scripts/reset-password.ts` (including `resetAdminPassword`), read `parseDbEnv(process.env).prepare` and pass it to `createDatabase`. On `EnvError`, print the message and exit 1.
  - [x] 2.4 Add `tests/unit/db-client.test.ts`: `redactDbUrl` removes the password from `postgresql://postgres.abc:secret@host:6543/postgres` and leaves text without a URL unchanged. Verify with `bun run test:unit` and `bun run typecheck`.
  - _Requirements: 1.1, 1.2, 1.4, 3.3_

- [x] 3. Route migrations and drizzle-kit through the migration URL
  - [x] 3.1 In `src/db/migrate.ts`'s `import.meta.main` block, use `parseDbEnv(process.env).migrationUrl ?? process.env.DATABASE_URL`. Keep the existing "wajib diisi" error when both are missing. Keep `runMigrations(url)` unchanged, so `tests/helpers.ts` still migrates `TEST_DATABASE_URL`.
  - [x] 3.2 In `drizzle.config.ts`, set `dbCredentials.url` to `process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? "postgres://mafaaza:mafaaza@localhost:5432/mafaaza"`.
  - [x] 3.3 Verify with `bun run typecheck`. With the local docker `db` running, run `bun run db:migrate` twice: the first run applies any pending migrations and the second run is a no-op.
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 4. Document the Supabase configuration
  - [x] 4.1 In `.env.example`, add a commented Supabase block below the local `DATABASE_URL`, using `[YOUR-PASSWORD]` placeholders only:
    - `DATABASE_URL="postgresql://postgres.ginaiawcuoaybsxqnfjr:[YOUR-PASSWORD]@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require"` (transaction pooler, IPv4)
    - `DATABASE_MIGRATION_URL="postgresql://postgres.ginaiawcuoaybsxqnfjr:[YOUR-PASSWORD]@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"` (session pooler, for `db:migrate`/`drizzle-kit`)
    - `DATABASE_PREPARE=false`
  - [x] 4.2 In `README.md`, add `DATABASE_PREPARE` and `DATABASE_MIGRATION_URL` to the env table. Add a "Supabase" section covering the 6543-vs-5432 split, the rule that the password goes only in the git-ignored `.env`, the run order `bun run db:migrate` → `bun run db:seed` → `bun run start`, and a warning never to point `TEST_DATABASE_URL` at Supabase.
  - [x] 4.3 Check with `git check-ignore .env` (must print `.env`) and `git diff` (no real password anywhere).
  - _Requirements: 3.1, 3.2, 4.1, 4.3_

- [x] 5. Install the Supabase agent skills
  - [x] 5.1 Run `npx skills add supabase/agent-skills` in the repository root and confirm it exits with status 0.
  - [x] 5.2 Check `git status`: `package.json` and `bun.lock` are unchanged, and the new skill files are listed. Add the command under a "Developer tooling" heading in `README.md`.
  - [x] 5.3 Verify with `bun run typecheck`, then commit the skill files together with the README change.
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 6. Final verification
  - [x] 6.1 Run `bun run typecheck` and `bun run test:unit`. If the local `db-test` container is up and the host has memory headroom, also run `bun test tests/integration` to confirm the local setup still works with `DATABASE_PREPARE` unset.
  - [x] 6.2 With the user's real Supabase `.env` in place (needs the user's password), run `bun run db:migrate`, then `bun run start`, and confirm `GET /health` returns 200 with no prepared-statement errors in the log. If the credentials are not available, stop and report that this step is waiting on the user.
  - _Requirements: 1.4, 2.3, 4.2, 4.3_
