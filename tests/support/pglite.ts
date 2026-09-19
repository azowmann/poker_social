/**
 * An in-process Postgres for testing the schema.
 *
 * `supabase start` needs Docker, which makes it a poor fit for `npm run test`.
 * PGlite is the real Postgres engine compiled to WASM, so the migrations run
 * unmodified - policies, triggers, plpgsql and all.
 *
 * What it is NOT: Supabase. There is no GoTrue, no PostgREST, no JWT. The
 * bootstrap below hand-rolls the few things Supabase would have provided (the
 * `auth` schema, `auth.uid()`, and the `anon` / `authenticated` roles), so a test
 * passing here means the SQL is sound, not that the hosted stack is configured.
 */
import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');

/**
 * Everything the migrations assume already exists on a Supabase project.
 *
 * auth.uid() normally reads the request's JWT. Here it reads a GUC, so a test can
 * become any user by setting it - see `asUser`.
 */
const BOOTSTRAP = `
create schema if not exists auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

create role anon nologin;
create role authenticated nologin;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

export type TestDb = {
  /** Rows from a query, run as whoever is currently active. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Row count touched by a write - 0 means RLS filtered it out rather than erroring. */
  affected(sql: string, params?: unknown[]): Promise<number>;
  /** Become this user: RLS on, auth.uid() returns their id. */
  asUser(userId: string): Promise<void>;
  /** Become a signed-out caller. */
  asAnon(): Promise<void>;
  /** Drop back to superuser, which bypasses RLS entirely. For setup only. */
  asAdmin(): Promise<void>;
  /** Create an auth user, which fires the profile trigger. Returns the new id. */
  signUp(email: string, meta?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

/** Boot Postgres, install the Supabase stand-ins, and apply every migration in order. */
export async function createSchemaTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(BOOTSTRAP);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  }

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (cause) {
      throw new Error(`migration ${file} failed to apply: ${(cause as Error).message}`);
    }
  }

  const asAdmin = async () => {
    await db.exec(`reset role; set request.jwt.claim.sub = '';`);
  };

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params);
      return result.rows;
    },
    async affected(sql: string, params: unknown[] = []) {
      const result = await db.query(sql, params);
      return result.affectedRows ?? 0;
    },
    async asUser(userId: string) {
      // `authenticated` cannot SET ROLE to anything else, so always reset first.
      await db.exec(`reset role; set request.jwt.claim.sub = '${userId}';`);
      await db.exec(`set role authenticated;`);
    },
    async asAnon() {
      await db.exec(`reset role; set request.jwt.claim.sub = '';`);
      await db.exec(`set role anon;`);
    },
    asAdmin,
    async signUp(email: string, meta: Record<string, unknown> = {}) {
      await asAdmin();
      const result = await db.query<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data)
         values ($1, $2::jsonb)
         returning id`,
        [email, JSON.stringify(meta)]
      );
      return result.rows[0].id;
    },
    async close() {
      await db.close();
    },
  };
}
