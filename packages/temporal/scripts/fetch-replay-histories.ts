/**
 * Fetch recent workflow histories from Temporal and save them as fixtures
 * for the replay-validation test. Pulls both closed (Completed or
 * ContinuedAsNew) and Running workflows — Temporal's docs recommend replaying
 * "a representative set of recent open and closed workflows" because
 * running-workflow histories expose non-determinism in partial execution
 * paths that closed ones cannot, and ContinuedAsNew histories specifically
 * cover the rollover path where long-running workflows are most prone to
 * non-determinism bugs.
 *
 * Usage:
 *   pnpm --filter @repo/temporal fetch:replay-histories
 *   pnpm --filter @repo/temporal fetch:replay-histories -- --per-type 10 --per-type-running 3 --since-days 3
 *
 * Requires the same Temporal connection env vars as the worker:
 *   TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_CLOUD_API_KEY (or mTLS vars).
 *
 * Each fixture is a JSON object of the form:
 *   { workflowId, runId, bucket, history }
 * Fixtures land in __tests__/__fixtures__/histories/<WorkflowType>/*.json.
 * The fixtures directory is gitignored — histories may contain tenant data.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tls from "node:tls";
import { Client, Connection } from "@temporalio/client";
// historyToJSON is not re-exported from @temporalio/common's main entrypoint,
// only from its proto-utils submodule. The subpath is stable (referenced by
// internal SDK code) and is the sanctioned way to produce proto3-JSON that
// the replayer's historyFromJSON can parse back.
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { getTemporalConfig } from "../src/client";

const FIXTURES_DIR = join(
	__dirname,
	"..",
	"__tests__",
	"__fixtures__",
	"histories",
);

const DEFAULT_PER_TYPE = 20;
const DEFAULT_PER_TYPE_RUNNING = 5;
const DEFAULT_SINCE_DAYS = 7;

function parseArgs(): {
	perType: number;
	perTypeRunning: number;
	sinceDays: number;
} {
	let perType = DEFAULT_PER_TYPE;
	let perTypeRunning = DEFAULT_PER_TYPE_RUNNING;
	let sinceDays = DEFAULT_SINCE_DAYS;
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if (arg === "--per-type" && process.argv[i + 1]) {
			perType = Number.parseInt(process.argv[++i], 10);
		} else if (arg === "--per-type-running" && process.argv[i + 1]) {
			perTypeRunning = Number.parseInt(process.argv[++i], 10);
		} else if (arg === "--since-days" && process.argv[i + 1]) {
			sinceDays = Number.parseInt(process.argv[++i], 10);
		}
	}
	return { perType, perTypeRunning, sinceDays };
}

async function createClient(): Promise<{
	client: Client;
	connection: Connection;
}> {
	const config = getTemporalConfig();
	const connectionOptions: Parameters<typeof Connection.connect>[0] = {
		address: config.address,
	};

	if (config.apiKey) {
		connectionOptions.apiKey = config.apiKey;
		const rootCerts = tls.rootCertificates.join("\n");
		connectionOptions.tls = {
			serverRootCACertificate: Buffer.from(rootCerts),
		};
		connectionOptions.metadata = {
			"temporal-namespace": config.namespace,
		};
	} else if (
		config.tls &&
		process.env.TEMPORAL_CLIENT_CERT &&
		process.env.TEMPORAL_CLIENT_KEY
	) {
		connectionOptions.tls = {
			clientCertPair: {
				crt: Buffer.from(process.env.TEMPORAL_CLIENT_CERT),
				key: Buffer.from(process.env.TEMPORAL_CLIENT_KEY),
			},
		};
		connectionOptions.metadata = {
			"temporal-namespace": config.namespace,
		};
	} else if (config.tls) {
		connectionOptions.tls = true;
	}

	const connection = await Connection.connect(connectionOptions);
	const client = new Client({ connection, namespace: config.namespace });
	return { client, connection };
}

function safeFilename(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

type Bucket = "closed" | "running";
type Counts = Map<string, { closed: number; running: number }>;

/** How many fetches a single workflow type may cost, as a multiple of how many
 *  fixtures are actually wanted from it. See the comment in `pullBatch`. */
const MAX_ATTEMPT_MULTIPLIER = 3;

async function pullBatch(
	client: Client,
	query: string,
	limitPerType: number,
	bucket: Bucket,
	counts: Counts,
): Promise<{ saved: number; skipped: number }> {
	if (limitPerType <= 0) {
		return { saved: 0, skipped: 0 };
	}
	let saved = 0;
	// Counted, not just warned about. Each skip is a history that will not be
	// replayed, and the per-line warnings scroll past in a log that is hundreds
	// of lines long — so the total goes in the summary where the coverage numbers
	// are read.
	let skipped = 0;

	// ATTEMPTS, tracked separately from `counts`. The per-type cap is checked
	// against `counts`, which is only written on a SUCCESSFUL save — so a type
	// whose every fetch fails is never recorded, never reaches the cap, and is
	// retried for every matching execution in the window. One pathological type
	// could walk the entire list, and the cost lands on both CI time and the
	// Temporal cluster. Raised by the Copilot review on this PR.
	//
	// Capped at a MULTIPLE of the wanted count rather than at the count itself:
	// equality would let a few transient failures silently reduce coverage,
	// which is the opposite of what this gate is for. Local to the call, so the
	// budget is per (type, bucket), matching `limitPerType`.
	const attempts = new Map<string, number>();
	const reportedCap = new Set<string>();
	const maxAttemptsPerType = limitPerType * MAX_ATTEMPT_MULTIPLIER;

	for await (const summary of client.workflow.list({
		query,
		pageSize: 100,
	})) {
		const type = summary.type;
		const entry = counts.get(type) ?? { closed: 0, running: 0 };
		if (entry[bucket] >= limitPerType) {
			continue;
		}
		const tried = attempts.get(type) ?? 0;
		if (tried >= maxAttemptsPerType) {
			// Once per type, not once per execution — the whole point is to stop
			// this type generating unbounded output as well as unbounded work.
			if (!reportedCap.has(type)) {
				reportedCap.add(type);
				console.warn(
					`[fetch] ${type} (${bucket}): giving up after ${tried} attempts, ${entry[bucket]} saved of ${limitPerType} wanted. Coverage for this type is reduced.`,
				);
			}
			continue;
		}
		attempts.set(type, tried + 1);
		try {
			const handle = client.workflow.getHandle(
				summary.workflowId,
				summary.runId,
			);
			const history = await handle.fetchHistory();
			const typeDir = join(FIXTURES_DIR, safeFilename(type));
			const file = join(
				typeDir,
				`${bucket}__${safeFilename(summary.workflowId)}__${safeFilename(summary.runId)}.json`,
			);
			// historyToJSON() produces proto3-JSON (Timestamps as RFC3339
			// strings, bytes as base64) — the same format historyFromJSON
			// expects on replay. A plain JSON.stringify(history) serializes
			// internal protobuf.js representations (Timestamps as
			// {seconds, nanos} objects, Longs as {low, high, unsigned}),
			// which fails validateHistory during replay.
			// The fixture wraps the history alongside the original
			// workflowId and runId so the replay test can feed the real
			// workflowId to Worker.runReplayHistories — workflows that
			// branch on workflowInfo().workflowId (project-document-
			// generation, code-indexing, etc) would otherwise see a
			// synthetic ID derived from the sanitized filename.
			const fixture = {
				workflowId: summary.workflowId,
				runId: summary.runId,
				bucket,
				history: JSON.parse(historyToJSON(history)),
			};
			// mkdir is deliberately deferred to HERE — after the fixture has
			// serialized successfully. Creating the directory earlier leaves an
			// EMPTY type directory behind whenever historyToJSON() throws (it
			// does, on some payloads: "Cannot serialize object to proto3 JSON
			// since its .$type is unknown"). The replay gate treats a directory
			// with no loadable histories as a coverage hole and fails, so an
			// unserializable history for a type with no other executions turns
			// into a red build for every PR that touches this package.
			await mkdir(typeDir, { recursive: true });
			await writeFile(file, JSON.stringify(fixture));
			entry[bucket]++;
			counts.set(type, entry);
			saved++;
		} catch (err) {
			skipped++;
			console.warn(
				`[fetch] skipped ${summary.workflowId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return { saved, skipped };
}

async function fetchHistories(
	client: Client,
	perType: number,
	perTypeRunning: number,
	sinceDays: number,
) {
	const sinceIso = new Date(
		Date.now() - sinceDays * 24 * 60 * 60 * 1000,
	).toISOString();
	// "Closed" bucket includes both Completed and ContinuedAsNew — the latter
	// is how long-running workflows (teams-channel-monitor, meeting-transcript
	// -sync, code-indexing, connector-sync, etc.) close each run when they
	// roll over. ContinuedAsNew execution histories are exactly the frames
	// where rollover non-determinism bites, so excluding them would leave a
	// big coverage gap for this class of workflow.
	const closedQuery = `(ExecutionStatus = "Completed" OR ExecutionStatus = "ContinuedAsNew") AND CloseTime > "${sinceIso}"`;
	const runningQuery = `ExecutionStatus = "Running" AND StartTime > "${sinceIso}"`;

	const counts: Counts = new Map();
	const closed = await pullBatch(
		client,
		closedQuery,
		perType,
		"closed",
		counts,
	);
	const running = await pullBatch(
		client,
		runningQuery,
		perTypeRunning,
		"running",
		counts,
	);

	return {
		counts,
		total: closed.saved + running.saved,
		skipped: closed.skipped + running.skipped,
	};
}

async function main() {
	const { perType, perTypeRunning, sinceDays } = parseArgs();
	console.log(
		`[fetch] pulling up to ${perType} closed (completed + continued-as-new) + ${perTypeRunning} running histories/type from last ${sinceDays}d`,
	);
	await mkdir(FIXTURES_DIR, { recursive: true });

	const { client, connection } = await createClient();
	try {
		const { counts, total, skipped } = await fetchHistories(
			client,
			perType,
			perTypeRunning,
			sinceDays,
		);
		console.log(
			// "could not be saved", not "could not be serialized": the catch that
			// feeds this counter wraps the fetch, the proto3-JSON conversion, the
			// parse AND the write, so naming one of them would send an operator
			// looking in the wrong place during an incident. Raised by the Copilot
			// review on this PR. The per-line warnings above carry the actual
			// error for each one.
			`[fetch] saved ${total} histories across ${counts.size} types` +
				(skipped > 0
					? `, skipped ${skipped} that could not be saved`
					: ""),
		);
		// Deferring mkdir (above) means a type whose every history failed to
		// serialize now leaves NO directory, so the replay gate no longer fails
		// on it — but that must not make the gap invisible. Name those types
		// here so a reduced-coverage run is still readable in the log.
		const zeroSaved = Array.from(counts.entries())
			.filter(([, c]) => c.closed + c.running === 0)
			.map(([type]) => type);
		if (zeroSaved.length > 0) {
			console.warn(
				`[fetch] NO histories saved for ${zeroSaved.length} type(s): ${zeroSaved.join(", ")}. ` +
					"Replay coverage for these types is a hole this run — see the per-execution skip reasons above.",
			);
		}
		const sorted = Array.from(counts.entries()).sort(
			(a, b) => b[1].closed + b[1].running - (a[1].closed + a[1].running),
		);
		for (const [type, n] of sorted) {
			console.log(`  ${type}: ${n.closed} closed, ${n.running} running`);
		}

		// FAIL rather than hand the replay step an empty directory. Exiting 0 with
		// nothing saved is what let the gate report success having replayed no
		// history at all — and the replay step cannot tell "dev was quiet" from
		// "the query, the window or the namespace was wrong". Failing here says
		// which of the two happened, right where the evidence is.
		if (total === 0) {
			console.error(
				"[fetch] no histories were saved. Nothing would be replayed, so this is a failure, not an empty result. " +
					"Check the namespace, the --since-days window, and whether any workflow ran in dev at all.",
			);
			process.exitCode = 1;
		}
	} finally {
		await connection.close();
	}
}

main().catch((err) => {
	console.error("[fetch] failed:", err);
	process.exit(1);
});
