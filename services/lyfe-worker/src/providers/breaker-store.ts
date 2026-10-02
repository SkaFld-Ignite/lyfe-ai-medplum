// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  ProviderBrake,
  ProviderBreakerStore,
} from '../../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';
import { setProviderBreakerStore } from '../../../../examples/medplum-provider/bots/shared/provider-rate-limit.ts';
import { isRagConfigured, ragQuery } from '../rag/db.ts';

/**
 * The brakes, somewhere every worker instance can see them.
 *
 * The in-process fallback in `provider-rate-limit.ts` already collapses the
 * thirty-three concurrent runs sharing one worker down to a single discovery of
 * a throttle, which is most of the win. It still has two holes, and both of
 * them are things that happen:
 *
 * - **A restart forgets.** A deploy during a forty-five minute hold wakes up
 *   with no memory of it and walks every queued run straight back into the
 *   throttle.
 * - **A second instance never learns.** Scaling the worker horizontally is the
 *   stated reason it exists at all — "run more of these and more patients
 *   import at once" — and a per-process brake gets weaker exactly as that
 *   happens.
 *
 * So the brakes go in Postgres. Specifically the Postgres the worker already
 * has: `RAG_DATABASE_URL`, the same instance Medplum runs on, reached through
 * the same pool. No new infrastructure, no Redis, nothing to provision — and
 * the alternative, a FHIR resource, would mean inventing a data type to hold
 * operational state, which is the thing this platform does not do.
 *
 * ## Why its own schema, and why that is not a data change
 *
 * `lyfe_ops`, not `lyfe_rag` and not `public`. Not `public` because Medplum
 * migrates that on every upgrade and a table named `provider_rate_limit`
 * sitting in it is a collision waiting for a release. Not `lyfe_rag` because
 * that schema carries a written rule — every row must be reconstructible by
 * re-reading FHIR — and a brake is not derived from FHIR at all.
 *
 * What a brake *is*, is **disposable**. `DROP SCHEMA lyfe_ops CASCADE` loses
 * nothing but the memory of which clinics are currently throttled, and the
 * worst case of losing that is the behaviour this repo had last week: call the
 * provider, get a 429, learn it again. Not one row here is clinical, not one is
 * a source of truth, and nothing reads it but this file. That is the test that
 * makes adding it an operational change rather than a data-model one.
 */

/** The schema the brakes live in. */
export const OPS_SCHEMA = 'lyfe_ops';

/**
 * How long a "no brake" answer may be reused before asking Postgres again.
 *
 * One import issues hundreds of provider calls, and every one of them consults
 * the brake first. A round trip per call would make the protection cost more
 * than the thing it protects. Five seconds is the window in which a brake
 * another run has just opened can still be missed — which costs at most a few
 * extra calls into a provider that is already refusing them, and those calls
 * open the brake themselves anyway.
 *
 * An *open* brake is not cached on this timer: its expiry is the cache key. We
 * know exactly when it stops being true, so there is nothing to guess.
 */
const CLEAR_CACHE_MS = 5_000;

/** Expired brakes older than this are swept, so the table cannot grow forever. */
const SWEEP_AFTER_MS = 24 * 60 * 60_000;

interface CacheEntry {
  /** When the brake lifts, or undefined when there was none. */
  openUntil?: Date;
  /** When this answer was read. Only consulted for the "no brake" case. */
  readAt: number;
}

let migration: Promise<void> | undefined;

/**
 * Create the schema and the table, idempotently.
 *
 * Lazy and self-applying, the same shape as `ensureRagSchema`, and for the same
 * reason: `RAG_DATABASE_URL` is a Railway-internal reference that resolves
 * inside the Railway network and nowhere else, so a migration script on a
 * developer's machine cannot run it. The only process that can reach this
 * database is the one that uses it.
 *
 * It follows that this DDL is applied by the first worker to need a brake, and
 * by nothing else. Shipping this file does not touch any database.
 * @returns Resolves once the table exists.
 */
export async function ensureBreakerSchema(): Promise<void> {
  migration ??= migrate().catch((err: unknown) => {
    // Not remembered on failure, so a missing grant an operator then fixes
    // takes effect without a redeploy.
    migration = undefined;
    throw err;
  });
  return migration;
}

/** The DDL. */
async function migrate(): Promise<void> {
  await ragQuery(`CREATE SCHEMA IF NOT EXISTS ${OPS_SCHEMA}`);
  await ragQuery(`
    CREATE TABLE IF NOT EXISTS ${OPS_SCHEMA}.provider_rate_limit (
      -- The integration key: 'drchrono', 'zus', or whatever the next one is
      -- called. Deliberately text and not an enum — a new provider must not
      -- need a migration to be able to be throttled.
      provider          text        NOT NULL,
      -- The clinic. Bare id, matching Organization.id, because a brake is per
      -- clinic: one practice exhausting its quota must not stop another's.
      organization_id   text        NOT NULL,
      -- When calls may resume. The provider's own number, not ours.
      open_until        timestamptz NOT NULL,
      -- Operator-facing. Never a response body: those can echo patient
      -- identifiers back at us.
      reason            text        NOT NULL DEFAULT '',
      updated_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, organization_id)
    )
  `);
}

/** Postgres-backed brakes, shared by every worker instance. */
export class PostgresBreakerStore implements ProviderBreakerStore {
  private readonly cache = new Map<string, CacheEntry>();

  async openUntil(provider: string, organizationId: string): Promise<Date | undefined> {
    // Memoised after the first call, so this is a resolved promise on the
    // hundreds of calls one import makes. Here as well as in `open` because a
    // read against a table that does not exist yet throws, and the guard's
    // fail-open catch would turn that into a warning line per HTTP request.
    await ensureBreakerSchema();
    const key = `${provider}\u0000${organizationId}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      // A known brake is trusted until the instant it expires — we are not
      // guessing when that is, the provider said so.
      if (cached.openUntil && cached.openUntil.getTime() > now) {
        return cached.openUntil;
      }
      // A "clear" answer is only as good as its age.
      if (!cached.openUntil && now - cached.readAt < CLEAR_CACHE_MS) {
        return undefined;
      }
    }

    const rows = await ragQuery<{ open_until: Date }>(
      `SELECT open_until FROM ${OPS_SCHEMA}.provider_rate_limit
       WHERE provider = $1 AND organization_id = $2 AND open_until > now()`,
      [provider, organizationId]
    );
    const openUntil = rows[0]?.open_until ? new Date(rows[0].open_until) : undefined;
    this.cache.set(key, { openUntil, readAt: now });
    return openUntil;
  }

  async open(brake: ProviderBrake): Promise<void> {
    await ensureBreakerSchema();
    // `GREATEST` rather than a plain overwrite. Two runs reporting the same
    // throttle a few seconds apart compute slightly different instants from
    // their own clocks, and the later-arriving one is often the *shorter*
    // window — letting it win would quietly shorten a hold another run had
    // correctly recorded.
    await ragQuery(
      `INSERT INTO ${OPS_SCHEMA}.provider_rate_limit (provider, organization_id, open_until, reason, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (provider, organization_id) DO UPDATE
         SET open_until = GREATEST(${OPS_SCHEMA}.provider_rate_limit.open_until, EXCLUDED.open_until),
             reason = EXCLUDED.reason,
             updated_at = now()`,
      [brake.provider, brake.organizationId, brake.openUntil.toISOString(), brake.reason]
    );
    this.cache.set(`${brake.provider}\u0000${brake.organizationId}`, {
      openUntil: brake.openUntil,
      readAt: Date.now(),
    });

    // Swept here rather than on a timer, so there is no background job to own.
    // Long-expired rows are the only thing removed; a brake that lifted a
    // minute ago is left alone, because `/health` showing it is useful.
    await ragQuery(
      `DELETE FROM ${OPS_SCHEMA}.provider_rate_limit WHERE open_until < now() - ($1 || ' milliseconds')::interval`,
      [String(SWEEP_AFTER_MS)]
    ).catch(() => undefined);
  }

  async list(): Promise<ProviderBrake[]> {
    await ensureBreakerSchema();
    const rows = await ragQuery<{ provider: string; organization_id: string; open_until: Date; reason: string }>(
      `SELECT provider, organization_id, open_until, reason
       FROM ${OPS_SCHEMA}.provider_rate_limit
       WHERE open_until > now()
       ORDER BY open_until DESC`
    );
    return rows.map((row) => ({
      provider: row.provider,
      organizationId: row.organization_id,
      openUntil: new Date(row.open_until),
      reason: row.reason,
    }));
  }
}

/**
 * Point the bots' brake at Postgres, if there is one to point at.
 *
 * Called once at worker startup. When `RAG_DATABASE_URL` is unset the bots keep
 * their in-process fallback, which is weaker but real — and it is better than
 * refusing to boot, because the imports do not otherwise need this database and
 * a worker that will not start without it is a worse outage than one that
 * brakes per process.
 * @returns Whether the shared store was installed.
 */
export function installSharedBreakerStore(): boolean {
  if (!isRagConfigured()) {
    console.warn('[rate-limit] RAG_DATABASE_URL is unset — provider brakes are per process only');
    return false;
  }
  setProviderBreakerStore(new PostgresBreakerStore());
  // Created now rather than on the first 429. A throttle is exactly the moment
  // not to discover that the DDL needs a grant nobody has.
  ensureBreakerSchema().catch((err: unknown) => {
    console.error('[rate-limit] could not create the brake table:', err instanceof Error ? err.message : err);
  });
  return true;
}
