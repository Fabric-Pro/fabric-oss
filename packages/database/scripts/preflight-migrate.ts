#!/usr/bin/env npx tsx

/**
 * Pre-migration preflight — the first step of a serialized database promotion.
 *
 * Runs before `prisma migrate deploy` and fails closed. Every check here exists
 * because the alternative is discovering the problem while DDL holds a lock on a
 * production table.
 *
 * Checks:
 *   1. Connectivity, and that session-level lock/statement timeouts can be set,
 *      so a blocked ALTER fails fast instead of queueing ahead of every other
 *      query on the table.
 *   2. `_prisma_migrations` has no migration left mid-flight — started, and
 *      neither finished nor resolved. That means a previous promotion died part
 *      way, and migrating on top of it compounds a divergence no rollback
 *      untangles. A migration explicitly resolved as rolled back is healthy.
 *   3. No migration is already running (advisory lock probe).
 *   4. No long-running transaction is holding a lock that the migration would
 *      queue behind.
 *
 * Concurrency: this probes the advisory lock rather than holding it, so it is a
 * fast-fail diagnostic, not the mutual-exclusion guard. Two real guards sit
 * behind it — the workflow's `concurrency` group, which stops two promotions
 * against one environment, and the advisory lock `prisma migrate deploy` takes
 * for itself while it runs.
 *
 * Usage:
 *   pnpm --filter @repo/database preflight
 *   pnpm --filter @repo/database preflight --long-tx-threshold-ms 30000
 */

import { pathToFileURL } from "node:url";
import { Client } from "pg";

/** Namespaced so it cannot collide with an application advisory lock. */
export const MIGRATION_ADVISORY_LOCK_KEY = 72_082_001;

export const DEFAULT_LONG_TX_THRESHOLD_MS = 30_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 900_000;

export interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

export interface MigrationLedgerRow {
	migration_name: string;
	finished_at: Date | null;
	rolled_back_at: Date | null;
	applied_steps_count: number;
}

export interface ActivityRow {
	pid: number;
	state: string | null;
	duration_ms: number;
	/**
	 * How long the session has been in its current `state`. For a session that
	 * is idle in transaction this is the time it has sat holding its locks.
	 */
	state_age_ms: number | null;
	wait_event_type: string | null;
	wait_event: string | null;
	/** `pg_blocking_pids(pid)`: the sessions this one is queued behind. */
	blocked_by: readonly number[] | null;
	application_name: string | null;
	/**
	 * Tables this session holds a granted lock on. Names only: the query text
	 * is deliberately not read (see the sampler), so this is what says which
	 * part of the schema the session is sitting on.
	 */
	locked_tables: readonly string[] | null;
}

/**
 * The one unhealthy ledger state is a migration that started and was never
 * resolved either way: `finished_at` and `rolled_back_at` both null. That means a
 * previous promotion died mid-flight, and migrating on top of it compounds a
 * divergence no rollback untangles.
 *
 * A row WITH `rolled_back_at` set is the opposite — it is the resolved state,
 * written by `prisma migrate resolve --rolled-back` precisely to record that a
 * failed migration has been dealt with. Treating it as a failure was wrong, and
 * wrong in the direction that blocks deploys: the dev database carries two such
 * rows from past incidents while `prisma migrate status` reports the schema up to
 * date, so every promotion failed preflight until this was corrected.
 */
export function evaluateMigrationLedger(
	rows: readonly MigrationLedgerRow[],
): CheckResult {
	const unresolved = rows.filter(
		(row) => row.finished_at === null && row.rolled_back_at === null,
	);

	if (unresolved.length > 0) {
		return {
			name: "migration-ledger",
			ok: false,
			detail: `${unresolved.length} migration(s) started but never finished or resolved: ${unresolved
				.map((row) => row.migration_name)
				.join(
					", ",
				)}. A previous promotion died mid-flight. The fix is \`prisma migrate resolve\`, but its argument is not something to pick from this message: \`--applied\` and \`--rolled-back\` are opposites, and a third reachable state takes neither. Read the catalog first — docs/database-promotion.md § "When an ordinary index build leaves the migration unresolved" carries the diagnostic SQL and a table mapping each state to the command it takes.`,
		};
	}

	const rolledBack = rows.filter((row) => row.rolled_back_at !== null).length;
	const resolvedNote =
		rolledBack > 0
			? ` (${rolledBack} previously resolved as rolled back)`
			: "";

	return {
		name: "migration-ledger",
		ok: true,
		detail: `${rows.length} migration(s) recorded, none left mid-flight${resolvedNote}.`,
	};
}

/**
 * `application_name` is free text the client chose. It goes into a CI log, so
 * it is clipped and stripped of anything that could break the line or smuggle
 * a value in: control characters (a newline would start a new log line) and
 * anything past a display-sized length.
 */
export const APPLICATION_NAME_MAX_CHARS = 64;
export function sanitizeApplicationName(name: string | null): string | null {
	if (!name) {
		return null;
	}
	// Every control character (C0 and C1) plus the Unicode line and paragraph
	// separators — a log line must end only where the formatter ends it.
	const cleaned = name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
	if (cleaned.length === 0) {
		return null;
	}
	return cleaned.length > APPLICATION_NAME_MAX_CHARS
		? `${cleaned.slice(0, APPLICATION_NAME_MAX_CHARS)}…`
		: cleaned;
}

/**
 * One offender, with everything the failure line needs to be acted on without
 * a second trip to the database. On 2026-09-02 two dev promotions failed on
 * "24 transaction(s) open" and the sessions were gone before anyone could ask
 * pg_stat_activity what they were: the line named pids, ages and states, which
 * identifies nothing. The shape of that incident — one session idle in
 * transaction, the rest active — is a lock chain, and a lock chain is only
 * legible when each line says what it waits on, whom it waits for, and which
 * tables the holder is sitting on.
 */
export function describeOffender(row: ActivityRow): string {
	const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
	const state = row.state ?? "unknown";
	const parts: string[] = [
		seconds(row.duration_ms),
		// Time in state matters for a holder (how long it has been idle on its
		// locks); for an active session it is just the current statement's age
		// and would read as a second, contradictory duration.
		row.state_age_ms != null && state !== "active"
			? `${state} for ${seconds(row.state_age_ms)}`
			: state,
	];
	if (row.wait_event_type) {
		parts.push(
			`waiting on ${row.wait_event_type}${row.wait_event ? `/${row.wait_event}` : ""}`,
		);
	}
	if (row.blocked_by && row.blocked_by.length > 0) {
		parts.push(`blocked by ${row.blocked_by.join(", ")}`);
	}
	const app = sanitizeApplicationName(row.application_name);
	if (app) {
		parts.push(`app ${app}`);
	}
	if (row.locked_tables && row.locked_tables.length > 0) {
		parts.push(`holds locks on ${row.locked_tables.join(", ")}`);
	}
	return `pid ${row.pid} (${parts.join(", ")})`;
}

/**
 * Long-running transactions are the reason a migration that "should take a
 * second" takes down a table: the DDL queues behind them holding its own lock
 * request, and every subsequent query on that table queues behind the DDL.
 */
export function evaluateLongRunningTransactions(
	rows: readonly ActivityRow[],
	thresholdMs: number = DEFAULT_LONG_TX_THRESHOLD_MS,
): CheckResult {
	const offenders = rows.filter((row) => row.duration_ms >= thresholdMs);

	if (offenders.length > 0) {
		const summary = offenders.map(describeOffender).join("; ");
		return {
			name: "long-running-transactions",
			ok: false,
			detail: `${offenders.length} transaction(s) open longer than ${thresholdMs}ms: ${summary}. Migration DDL would queue behind them and block the table.`,
		};
	}

	return {
		name: "long-running-transactions",
		ok: true,
		detail: `No transaction open longer than ${thresholdMs}ms.`,
	};
}

/**
 * How long the long-transaction check keeps re-sampling before giving up, and
 * the gap between samples.
 *
 * The check used to take ONE sample and fail the promotion on it. On 2026-08-19
 * a single transaction 37s old, against a 30s threshold, aborted a dev deploy —
 * and because the deploy workflow serializes on a concurrency group, every
 * queued deploy behind it waited over an hour.
 *
 * An idle transaction a few seconds past the threshold is a fluctuating
 * quantity, not a verdict. Re-sampling for a bounded while costs a minute in the
 * bad case and saves the pipeline in the common one. It cannot let an unsafe
 * migration through: a condition that persists for the whole budget still fails,
 * which is what the third test pins.
 */
export const DEFAULT_LONG_TX_WAIT_MS = 60_000;
export const LONG_TX_POLL_INTERVAL_MS = 5_000;

/**
 * Re-sample `sample` until it passes or the budget is spent.
 *
 * `sample` and `sleep` are injected rather than closed over so the behaviour is
 * testable without a database and without real time — a wait loop verified by
 * actually waiting is a slow test that proves less.
 */
export async function awaitQuietTransactions(opts: {
	sample: () => Promise<CheckResult>;
	sleep: (ms: number) => Promise<void>;
	budgetMs: number;
	intervalMs: number;
}): Promise<CheckResult> {
	const { sample, sleep, budgetMs, intervalMs } = opts;
	// SLEEPS, not attempts. The first sample is taken before any waiting, so
	// counting it as one of the budget's slots spends the budget one interval
	// short: 60s at a 5s interval used to sleep 11 times, wait 55s, and report
	// 60s. Raised by the Copilot review on this PR.
	//
	// A zero budget therefore means zero sleeps and exactly one sample, which is
	// the original single-sample behaviour rather than no check at all.
	const maxSleeps = intervalMs > 0 ? Math.floor(budgetMs / intervalMs) : 0;

	let waitedMs = 0;
	let last = await sample();
	for (let slept = 0; slept < maxSleeps && !last.ok; slept++) {
		await sleep(intervalMs);
		waitedMs += intervalMs;
		last = await sample();
	}

	if (last.ok) {
		return last;
	}
	// Report what it ACTUALLY waited, accumulated as it went, not the budget it
	// was given. The two agree now; deriving the number is what stops them
	// drifting apart again the next time the loop's shape changes — which is
	// exactly how they came to disagree in the first place.
	return {
		...last,
		detail: `${last.detail} Still present after ${waitedMs}ms of waiting.`,
	};
}

export function evaluateAdvisoryLock(acquired: boolean): CheckResult {
	return acquired
		? {
				name: "migration-lock",
				ok: true,
				detail: "No migration currently in flight.",
			}
		: {
				name: "migration-lock",
				ok: false,
				detail: `Advisory lock ${MIGRATION_ADVISORY_LOCK_KEY} is held — another migration is running. Refusing to start a second one.`,
			};
}

export function parseThresholdArg(
	argv: readonly string[],
	flag: string,
	fallback: number,
): number {
	const index = argv.indexOf(flag);
	if (index === -1) {
		return fallback;
	}
	const parsed = Number(argv[index + 1]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function summarize(results: readonly CheckResult[]): {
	ok: boolean;
	report: string;
} {
	const lines = results.map(
		(result) =>
			`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`,
	);
	return {
		ok: results.every((result) => result.ok),
		report: lines.join("\n"),
	};
}

async function runChecks(
	client: Client,
	longTxThresholdMs: number,
	longTxWaitMs: number,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	await client.query(`SET lock_timeout = ${DEFAULT_LOCK_TIMEOUT_MS}`);
	await client.query(
		`SET statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`,
	);
	results.push({
		name: "session-timeouts",
		ok: true,
		detail: `lock_timeout=${DEFAULT_LOCK_TIMEOUT_MS}ms statement_timeout=${DEFAULT_STATEMENT_TIMEOUT_MS}ms`,
	});

	const lock = await client.query<{ acquired: boolean }>(
		"SELECT pg_try_advisory_lock($1) AS acquired",
		[MIGRATION_ADVISORY_LOCK_KEY],
	);
	const acquired = lock.rows[0]?.acquired === true;
	if (acquired) {
		await client.query("SELECT pg_advisory_unlock($1)", [
			MIGRATION_ADVISORY_LOCK_KEY,
		]);
	}
	results.push(evaluateAdvisoryLock(acquired));

	// A brand-new database has no ledger table yet; that is a clean first run.
	const ledgerExists = await client.query<{ exists: boolean }>(
		"SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists",
	);
	if (ledgerExists.rows[0]?.exists) {
		const ledger = await client.query<MigrationLedgerRow>(
			'SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations"',
		);
		results.push(evaluateMigrationLedger(ledger.rows));
	} else {
		results.push({
			name: "migration-ledger",
			ok: true,
			detail: "No _prisma_migrations table yet — first migration on a fresh database.",
		});
	}

	// Deliberately does not select `query`: the statement text can carry literal
	// values from production rows, and this output goes to a CI log. The lock
	// columns are the substitute — a table name says where a session is sitting
	// without repeating what it wrote there. Everything else selected is
	// visible to this role for its own sessions, and every app connection
	// arrives as the same role.
	//
	// `relname::text`, not bare `relname`: `array_agg` over `name` yields a
	// `name[]`, and the driver has no parser for that array type, so it would
	// arrive as the literal string "{project,user_story}" rather than an
	// array. `text[]` is parsed.
	const sampleLongTransactions = async (): Promise<CheckResult> => {
		const activity = await client.query<ActivityRow>(
			`SELECT a.pid,
			        a.state,
			        a.application_name,
			        a.wait_event_type,
			        a.wait_event,
			        EXTRACT(EPOCH FROM (now() - a.xact_start)) * 1000 AS duration_ms,
			        EXTRACT(EPOCH FROM (now() - a.state_change)) * 1000 AS state_age_ms,
			        pg_blocking_pids(a.pid) AS blocked_by,
			        (SELECT array_agg(DISTINCT c.relname::text ORDER BY c.relname::text)
			           FROM pg_locks l
			           JOIN pg_class c ON c.oid = l.relation
			          WHERE l.pid = a.pid
			            AND l.granted
			            AND l.locktype = 'relation'
			            AND c.relkind IN ('r', 'p')
			            AND c.relnamespace <> 'pg_catalog'::regnamespace) AS locked_tables
			   FROM pg_stat_activity a
			  WHERE a.xact_start IS NOT NULL
			    AND a.pid <> pg_backend_pid()
			    AND a.datname = current_database()`,
		);
		return evaluateLongRunningTransactions(
			activity.rows.map((row) => ({
				...row,
				duration_ms: Number(row.duration_ms),
				state_age_ms:
					row.state_age_ms == null ? null : Number(row.state_age_ms),
			})),
			longTxThresholdMs,
		);
	};
	// The only check that is re-sampled. The ledger and the advisory lock are
	// not: a mid-flight migration row is a durable state that no amount of
	// waiting resolves, and a held advisory lock means another promotion is
	// running, where failing fast is the point.
	results.push(
		await awaitQuietTransactions({
			sample: sampleLongTransactions,
			sleep: (ms) =>
				new Promise((resolve) => {
					setTimeout(resolve, ms);
				}),
			budgetMs: longTxWaitMs,
			intervalMs: LONG_TX_POLL_INTERVAL_MS,
		}),
	);

	return results;
}

async function main(): Promise<void> {
	const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!connectionString) {
		console.error("preflight: DATABASE_URL (or DIRECT_URL) is required.");
		process.exit(1);
	}

	const longTxThresholdMs = parseThresholdArg(
		process.argv,
		"--long-tx-threshold-ms",
		DEFAULT_LONG_TX_THRESHOLD_MS,
	);
	// Takes a POSITIVE value, like its sibling — there is no "off" through this
	// flag, and none is needed: the budget only ever delays a verdict it would
	// have reached anyway, and a run with no budget still samples once.
	const longTxWaitMs = parseThresholdArg(
		process.argv,
		"--long-tx-wait-ms",
		DEFAULT_LONG_TX_WAIT_MS,
	);

	const client = new Client({ connectionString });
	await client.connect();

	try {
		const results = await runChecks(
			client,
			longTxThresholdMs,
			longTxWaitMs,
		);
		const { ok, report } = summarize(results);
		console.log("Database promotion preflight:\n");
		console.log(report);

		if (!ok) {
			console.error(
				"\npreflight FAILED — refusing to start the migration.",
			);
			process.exit(1);
		}
		console.log("\npreflight passed.");
	} finally {
		await client.end();
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error("preflight: unexpected failure", error);
		process.exit(1);
	});
}
