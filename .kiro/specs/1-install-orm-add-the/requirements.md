# Connect mafaaza-api to Supabase Postgres via Drizzle

## Goal

Run mafaaza-api against a hosted Supabase Postgres database instead of only the local docker-compose Postgres, using the Drizzle ORM setup the project already has.

Drizzle is already installed and configured (`drizzle-orm` 0.45.3, `drizzle-kit` 0.31.11, `postgres` 3.4.9, schema in `src/db/schema/index.ts`, client in `src/db/client.ts`, migrations in `src/db/migrations`). The Supabase quickstart steps "install ORM", "add `drizzle/schema.ts`" and "add `index.tsx`" are therefore not repeated. What the quickstart does add, and this spec covers:

- The runtime connects through Supabase's **transaction-mode pooler** (port 6543, IPv4-only), which does not support prepared statements, so the postgres.js client needs `prepare: false`.
- Migrations and `drizzle-kit` go through a **session/direct connection** (port 5432). The transaction pooler does not keep session state between statements, and migrations need that state.
- The connection is encrypted with TLS, and the database password never goes into git.

Out of scope: the quickstart's sample `users` table (the app already has `admins`), a new `index.tsx` entry point, and switching the package manager from Bun to npm. The optional Supabase agent-skills install is in scope as developer tooling (Requirement 5).

## Requirements

### 1. Pooler-compatible runtime connection

As the operator, I want the API to connect through Supabase's transaction pooler, so that it works on IPv4-only hosts and does not run out of connections.

- WHEN `DATABASE_PREPARE` is `false` THE SYSTEM SHALL create the postgres.js client with `prepare: false` for the API server (`src/index.ts`), `db:seed` and `admin:reset-password`.
- WHEN `DATABASE_PREPARE` is unset or `true` THE SYSTEM SHALL keep prepared statements on, so the local docker-compose database and the test suite work as they do today.
- IF `DATABASE_PREPARE` has a value other than `true` or `false` THEN THE SYSTEM SHALL refuse to start and report `DATABASE_PREPARE` through the existing `EnvError` path.
- WHEN connected to Supabase through port 6543 THE SYSTEM SHALL answer `GET /health` (and every existing endpoint) without `prepared statement ... already exists/does not exist` errors.

### 2. Separate migration connection

As the operator, I want migrations to use a session connection, so that schema changes apply reliably on Supabase.

- WHEN `DATABASE_MIGRATION_URL` is set THE SYSTEM SHALL use it for `bun run db:migrate` and for `drizzle-kit` (`drizzle.config.ts`), and SHALL use `DATABASE_URL` everywhere else.
- WHEN `DATABASE_MIGRATION_URL` is unset THE SYSTEM SHALL fall back to `DATABASE_URL` (current behaviour, local setups keep working).
- WHEN `bun run db:migrate` runs against an empty Supabase database THE SYSTEM SHALL apply migrations `0000_init`, `0001_audit_logs_append_only` and `0002_sale_items_position` in order, and a second run SHALL be a no-op.

### 3. Secure configuration

As the operator, I want database credentials and transport handled safely, so that the Supabase password is not exposed.

- THE SYSTEM SHALL document the Supabase URLs in `.env.example` with a `[YOUR-PASSWORD]` placeholder only, and the real password SHALL live only in the git-ignored `.env`.
- THE SYSTEM SHALL document `?sslmode=require` on both Supabase URLs so traffic to the pooler is encrypted.
- IF the database is unreachable at startup THEN THE SYSTEM SHALL log the error without printing the connection string or password.

### 4. Documentation and verification

As a developer, I want clear setup steps, so that I can switch between local Postgres and Supabase.

- THE SYSTEM SHALL describe in `README.md` the new variables (`DATABASE_PREPARE`, `DATABASE_MIGRATION_URL`), the 6543-vs-5432 split, and the order: migrate, seed, start.
- WHEN `bun run typecheck` and `bun run test:unit` run THE SYSTEM SHALL pass, including new unit tests for parsing `DATABASE_PREPARE` and `DATABASE_MIGRATION_URL`.
- THE SYSTEM SHALL keep the integration test suite on the local `TEST_DATABASE_URL`. Tests SHALL never run against Supabase, because they truncate tables.

### 5. Supabase agent skills

As a developer, I want the Supabase agent skills in the repo, so that AI coding tools get accurate Supabase instructions for this project.

- WHEN `npx skills add supabase/agent-skills` runs in the repository root THE SYSTEM SHALL exit with status 0 and add the Supabase skill files to the project.
- THE SYSTEM SHALL commit the added skill files and list the command in `README.md` so other developers can re-run it.
- THE SYSTEM SHALL NOT add the skills package to `package.json` dependencies, and `bun run typecheck` SHALL still pass with the skill files present.
