import { DurableObject } from "cloudflare:workers";

/** How long a lease lasts unless renewed; a running Sandbox renews its lease every minute. */
export const CAPACITY_LEASE_TTL_MS = 3 * 60_000;
/** How often a waiting Sandbox asks again. */
export const CAPACITY_RETRY_MS = 10_000;
/** A waiter that has not asked for this long has given up, and loses its place. */
const WAITER_STALE_MS = 60_000;
const DEFAULT_LIMIT = 100;

export type CapacityGrant =
	| { granted: true; expiresAt: number }
	| { granted: false; position: number; retryAfterMs: number };

/** `SANDBOX_MAX_CONCURRENT`, or 100 when it is unset or invalid. */
export function capacityLimit(value: string | undefined): number {
	const limit = Number(value);
	return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
}

/**
 * The deployment-wide cap on running sandbox containers: one instance, named
 * "global". Each running container holds a lease. A Sandbox that finds every
 * slot taken joins a first-come queue and asks again; an expired lease or an
 * abandoned place in the queue frees itself.
 */
export class SandboxCapacity extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS leases (
			holder TEXT PRIMARY KEY,
			acquired_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			reason TEXT NOT NULL,
			enqueued_at INTEGER
		)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS waiters (
			holder TEXT PRIMARY KEY,
			enqueued_at INTEGER NOT NULL,
			seen_at INTEGER NOT NULL
		)`);
		this.migrate();
	}

	/** Leases taken before they recorded the holder's place in line. */
	private migrate(): void {
		const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(leases)").toArray();
		if (!columns.some((column) => column.name === "enqueued_at")) {
			this.sql.exec("ALTER TABLE leases ADD COLUMN enqueued_at INTEGER");
		}
	}

	/** Take (or extend) a slot for `holder`, or return its place in the queue. */
	acquire(holder: string, options: { ttlMs?: number; reason?: string } = {}): CapacityGrant {
		const now = Date.now();
		const expiresAt = now + (options.ttlMs ?? CAPACITY_LEASE_TTL_MS);
		this.reap(now);
		if (this.extend(holder, expiresAt)) return { granted: true, expiresAt };
		this.sql.exec(
			`INSERT INTO waiters (holder, enqueued_at, seen_at) VALUES (?, ?, ?)
			 ON CONFLICT(holder) DO UPDATE SET seen_at = excluded.seen_at`,
			holder,
			now,
			now,
		);
		const free = this.limit() - this.count("leases");
		const ahead = this.waitersAhead(holder);
		if (free > ahead) {
			// The lease keeps the holder's place in line, in case its start is refused.
			this.sql.exec(
				`INSERT INTO leases (holder, acquired_at, expires_at, reason, enqueued_at)
				 SELECT ?, ?, ?, ?, enqueued_at FROM waiters WHERE holder = ?`,
				holder,
				now,
				expiresAt,
				options.reason ?? "start",
				holder,
			);
			this.sql.exec("DELETE FROM waiters WHERE holder = ?", holder);
			return { granted: true, expiresAt };
		}
		return { granted: false, position: ahead + 1, retryAfterMs: CAPACITY_RETRY_MS };
	}

	/** Keep a held slot; false when it already expired, so the holder must acquire again. */
	renew(holder: string, ttlMs = CAPACITY_LEASE_TTL_MS): boolean {
		const now = Date.now();
		this.reap(now);
		return this.extend(holder, now + ttlMs);
	}

	/**
	 * Take a running container's slot again after its lease lapsed, past the cap
	 * if others took the free slots meanwhile: it runs either way, so it counts.
	 */
	reclaim(holder: string, ttlMs = CAPACITY_LEASE_TTL_MS): void {
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO leases (holder, acquired_at, expires_at, reason) VALUES (?, ?, ?, 'reclaim')
			 ON CONFLICT(holder) DO UPDATE SET expires_at = excluded.expires_at`,
			holder,
			now,
			now + ttlMs,
		);
		this.sql.exec("DELETE FROM waiters WHERE holder = ?", holder);
	}

	/** Give up a slot or a place in the queue. */
	release(holder: string): void {
		this.sql.exec("DELETE FROM leases WHERE holder = ?", holder);
		this.sql.exec("DELETE FROM waiters WHERE holder = ?", holder);
	}

	/**
	 * Give back a slot whose start the platform refused, and wait again at the
	 * place in line the holder had when it was granted.
	 */
	requeue(holder: string): void {
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO waiters (holder, enqueued_at, seen_at)
			 SELECT holder, COALESCE(enqueued_at, acquired_at), ? FROM leases WHERE holder = ?
			 ON CONFLICT(holder) DO UPDATE SET seen_at = excluded.seen_at`,
			now,
			holder,
		);
		this.sql.exec("DELETE FROM leases WHERE holder = ?", holder);
	}

	/** Give up a slot, keeping any place the holder has in the queue. */
	releaseLease(holder: string): void {
		this.sql.exec("DELETE FROM leases WHERE holder = ?", holder);
	}

	stats(): { limit: number; active: number; waiting: number } {
		this.reap(Date.now());
		return { limit: this.limit(), active: this.count("leases"), waiting: this.count("waiters") };
	}

	private limit(): number {
		return capacityLimit(this.env.SANDBOX_MAX_CONCURRENT);
	}

	private reap(now: number): void {
		this.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
		this.sql.exec("DELETE FROM waiters WHERE seen_at <= ?", now - WAITER_STALE_MS);
	}

	private extend(holder: string, expiresAt: number): boolean {
		return (
			this.sql.exec("UPDATE leases SET expires_at = ? WHERE holder = ?", expiresAt, holder)
				.rowsWritten > 0
		);
	}

	private count(table: "leases" | "waiters"): number {
		return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
	}

	private waitersAhead(holder: string): number {
		return this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM waiters AS other, waiters AS mine
				 WHERE mine.holder = ?
				   AND (other.enqueued_at < mine.enqueued_at
				     OR (other.enqueued_at = mine.enqueued_at AND other.holder < mine.holder))`,
				holder,
			)
			.one().n;
	}
}
