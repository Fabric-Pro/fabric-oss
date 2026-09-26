import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { DEFERRED_SCAN_MAX_ATTEMPTS } from "../lib/instruction-deferred-scan-retry";

const {
	verifyAndScanInstructionFiles,
	finalizeInstructionSnapshot,
	rejectInstructionSnapshot,
	markInstructionSnapshotFailed,
	publishInstructionSnapshotActivity,
	pruneInstructionSnapshots,
	promoteUnscannedInstructionSnapshot,
	recordDeferredScanOutcome,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * The publish-first path's deferred scan (Fizzy #2737), on a longer retry
 * budget than the rest. By the time it runs the version is already readable,
 * so a transient storage failure that exhausts three attempts would leave a
 * published version reported as never checked; six attempts backing off to a
 * minute ride out a few minutes of trouble. The activity reads the same
 * `DEFERRED_SCAN_MAX_ATTEMPTS`: on its final attempt it stops throwing for a
 * file it cannot read and returns INCOMPLETE with every finding it did
 * establish, so the workflow's own INCOMPLETE below is the last resort for
 * an attempt that could not return at all (a timeout, a lost worker).
 * `proxyActivities` only builds stubs, so this second call adds no command
 * to any history.
 */
const { scanPublishedInstructionSnapshot } = proxyActivities<typeof activities>(
	{
		startToCloseTimeout: "10 minutes",
		heartbeatTimeout: "60 seconds",
		retry: {
			initialInterval: "1s",
			maximumInterval: "60s",
			backoffCoefficient: 2,
			maximumAttempts: DEFERRED_SCAN_MAX_ATTEMPTS,
		},
	},
);

/**
 * A short, fixed identifier for what went wrong — never the error message.
 *
 * An activity error reaches the workflow wrapped as `ActivityFailure` ->
 * `ApplicationFailure`, so the outermost class name is always
 * "ActivityFailure" and says nothing. Walking to the innermost link and
 * preferring its `type` recovers the useful label: Temporal sets `type` from
 * the original error's class when it converts one ("TypeError"), and our own
 * activities set it explicitly ("INSTRUCTION_SNAPSHOT_TENANT_MISMATCH").
 * `name` is the fallback rather than `constructor.name` because the workflow
 * bundle may be minified, which mangles constructor names but not `name`.
 *
 * Only these two fields are read. A message can quote a storage URL, a signed
 * key, or the file content that caused the failure, and this value crosses an
 * activity boundary into a log line.
 */
function failureLabel(error: unknown): string {
	let current: unknown = error;
	let label = "UnknownError";
	// Bounded: a malformed cause chain must not spin the workflow thread.
	for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
		const type = (current as { type?: unknown }).type;
		label =
			typeof type === "string" && type.length > 0 ? type : current.name;
		current = current.cause;
	}
	return label.slice(0, 100);
}

export type ProjectInstructionSnapshotWorkflowInput = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	/**
	 * Publish first, scan afterwards (Fizzy #2737): set by `finalize` from the
	 * snapshot row's own opt-in. Optional so every history recorded before it
	 * existed — and every run started without it — takes the ordinary path,
	 * command for command. It only CHOOSES the path: the promotion re-reads
	 * the opt-in off the row and refuses a snapshot that did not make it.
	 */
	publishBeforeScan?: boolean;
};

type DeferredScanOutcome = "PASSED" | "ISSUES_FOUND" | "INCOMPLETE";

type SnapshotWorkflowResult = {
	status: "READY" | "REJECTED";
	published: boolean;
	publishReason?: string;
	/** The publish-first path's scan verdict; absent on the ordinary path. */
	deferredScan?: DeferredScanOutcome;
};

/**
 * The publish-first path (Fizzy #2737): promote -> publish -> scan -> record
 * -> prune.
 *
 * `promoteUnscannedInstructionSnapshot` runs everything the gate and
 * promotion decide except the content scan, and a refusal there rejects the
 * snapshot before anything publishes, exactly as on the ordinary path. The
 * publish step is the ordinary one; for this row it also re-checks the
 * acknowledging member's publish permission, and a refusal (that, or a
 * moved base) leaves the version READY and unpublished while the scan still
 * runs and its verdict is still recorded.
 *
 * The scan settles its own INCOMPLETE on its final attempt, with every
 * finding it established (see `DEFERRED_SCAN_MAX_ATTEMPTS`), and whatever it
 * returns is recorded as it stands. An attempt that could not return at all
 * — a timeout, a lost worker — is CAUGHT here and recorded as INCOMPLETE with
 * no findings: the one catch besides the boundary's, and deliberately
 * narrow, because a verdict must land either way and "could not finish" is a
 * verdict the tab shows. A cancellation is rethrown, not recorded. The
 * outcome write is NOT caught: if it fails, the workflow fails, the row stays
 * READY with its scan PENDING, and the reaper closes it out as INCOMPLETE
 * once it can prove no execution is left (`DEFERRED_SCAN_STALE_AFTER_MS`).
 * The same bound covers every other way this path can die after promotion —
 * a publish that exhausted its retries, a termination, a timeout.
 */
async function publishBeforeScanPath(
	input: ProjectInstructionSnapshotWorkflowInput,
): Promise<SnapshotWorkflowResult> {
	const promoted = await promoteUnscannedInstructionSnapshot(input);
	if (!promoted.ok) {
		await rejectInstructionSnapshot({
			...input,
			rejections: promoted.rejections,
		});
		return { status: "REJECTED", published: false };
	}
	const publish = await publishInstructionSnapshotActivity(input);
	let scan: Awaited<
		ReturnType<typeof scanPublishedInstructionSnapshot>
	> | null = null;
	let failure: string | undefined;
	try {
		scan = await scanPublishedInstructionSnapshot(input);
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		failure = failureLabel(error);
	}
	const outcome: DeferredScanOutcome = scan?.outcome ?? "INCOMPLETE";
	await recordDeferredScanOutcome({
		...input,
		outcome,
		findings: scan?.findings ?? [],
		...(failure ? { failure } : {}),
	});
	await pruneInstructionSnapshots(input);
	return {
		status: "READY",
		published: publish.published,
		publishReason: publish.reason,
		deferredScan: outcome,
	};
}

/**
 * Upload validation and publication: gate -> promote -> publish -> prune.
 * Either verdict-producing step (the integrity/secret gate, or promotion's
 * re-hash) rejects the snapshot and deletes its staging objects.
 *
 * The gate and promotion are a deliberate pair. Staged bytes stay mutable
 * while the client's signed PUT lives, so one pass cannot prove the bytes
 * that were scanned are the bytes that end up stored: the gate hashes and
 * scans one buffer, and promotion re-hashes and writes the buffer it hashed.
 * A standalone verify step preceding the scan is what this replaces — it
 * added a third read of the same mutable key and closed nothing.
 *
 * There is no classify step for the same reason. It used to sit between the
 * gate and promotion and re-download every staged object WITHOUT re-hashing
 * it, so frontmatter swapped in after the gate could be persisted as a file's
 * `name`/`description` — columns MCP and the API listings serve. The gate now
 * classifies from the buffer it has already verified. Every step in this
 * workflow reads staged bytes only through a hash it checks.
 *
 * ONE try/catch, at the workflow boundary, and it is not error handling: it
 * gives the snapshot a terminal state and rethrows unchanged, so the workflow
 * still fails and the error still reaches Temporal's history intact. It
 * exists because nothing else could write FAILED. An activity that exhausted
 * its three attempts used to leave the row VALIDATING forever, and the tab
 * reads VALIDATING as "still checking" and re-polls every three seconds for
 * every viewer, with no way back except a fresh upload that leaves the stuck
 * row behind still polling.
 *
 * `markInstructionSnapshotFailed` only moves a row that is still RECEIVING or
 * VALIDATING, so a failure after `finalizeInstructionSnapshot` has written
 * READY (a publish or prune error) leaves that genuinely-ready snapshot
 * alone.
 *
 * A snapshot whose member chose to publish before the content scan (Fizzy
 * #2737) takes `publishBeforeScanPath` instead, chosen by an explicit
 * `publishBeforeScan: true` in the input and nothing else.
 *
 * Recovery is a retried `finalize` call: the oRPC handler accepts FAILED as
 * a re-attempt status and starts this workflow again under the same
 * deterministic workflow id, which Temporal permits once the previous run has
 * closed. It also tolerates `WorkflowExecutionAlreadyStartedError` from a
 * still-open run and treats it as confirmation, so a row that is merely slow
 * is not restarted.
 */
export async function projectInstructionSnapshotWorkflow(
	input: ProjectInstructionSnapshotWorkflowInput,
): Promise<SnapshotWorkflowResult> {
	try {
		// Only an explicit `true` leaves the ordinary path below, which is
		// otherwise untouched: a history without the field replays through it
		// command for command.
		if (input.publishBeforeScan === true) {
			return await publishBeforeScanPath(input);
		}
		const gated = await verifyAndScanInstructionFiles(input);
		if (!gated.ok) {
			await rejectInstructionSnapshot({
				...input,
				rejections: gated.rejections,
			});
			return { status: "REJECTED", published: false };
		}
		const promoted = await finalizeInstructionSnapshot(input);
		if (!promoted.ok) {
			// The staged bytes changed between the gate and promotion. The
			// snapshot is refused rather than published, exactly as a gate
			// failure is.
			await rejectInstructionSnapshot({
				...input,
				rejections: promoted.rejections,
			});
			return { status: "REJECTED", published: false };
		}
		const publish = await publishInstructionSnapshotActivity(input);
		await pruneInstructionSnapshots(input);
		return {
			status: "READY",
			published: publish.published,
			// Carries WHY publish did or didn't happen (e.g. "manual" for
			// publishOnReady: false, or "older_than_current" for a genuine
			// pointer-race conflict) — without this the two were indistinguishable
			// in the workflow's result and history.
			publishReason: publish.reason,
		};
	} catch (error) {
		await markInstructionSnapshotFailed({
			...input,
			failure: failureLabel(error),
		});
		throw error;
	}
}
