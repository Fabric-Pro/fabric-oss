/**
 * Security & Accessibility scan workflow.
 *
 * Orchestrates the scan pipeline on the general-purpose `fabric-worker` queue:
 *   markScanRunning → gatherScanContext → [security ‖ accessibility] → persist
 * Any failure routes to failScan so the run never hangs in PENDING/RUNNING.
 *
 * All side effects live in activities; this workflow only sequences them, so it
 * stays deterministic / replay-safe.
 */

import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { ScanFindingDraft } from "../activities/security-scan/scan-schemas";
import {
	describeScanFailureReason,
	ensureScanFailureHint,
} from "./scan-failure-hint";

// Cheap DB-only activities — retry generously. `resolveScanCommitActivity` also
// does one quick `git ls-remote` (single ref, no clone) and self-degrades to a
// FULL result on any failure, so it fits the same cheap/retryable profile.
const {
	markScanRunningActivity,
	gatherScanContextActivity,
	resolveScanCommitActivity,
	persistScanResultsActivity,
	failScanActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// LLM scanner activities — long timeout + heartbeat, ONE attempt (cost). The
// adaptive chunked scan can legitimately run up to ~an hour on a rate-limited
// gateway (it degrades back toward serial under sustained throttling), so
// startToClose is generous (60m) and the 2-min heartbeat is the real hang
// guard; the workflow's executionTimeout is the overall ceiling.
const { runSecurityScanActivity, runAccessibilityScanActivity } =
	proxyActivities<typeof activities>({
		// The AI engines scan chunks with ADAPTIVE (AIMD) parallel concurrency —
		// self-tuning to the gateway's real TPM limit and degrading back toward
		// serial under sustained throttling — so a large project's total
		// in-activity time still grows with item count and gateway latency. The
		// activity heartbeats continuously, so the 2-min heartbeatTimeout — not
		// this ceiling — is the real "is it alive?" guard; startToClose just needs
		// enough headroom for a worst-case throttled run so a healthy-but-slow scan
		// isn't killed mid-way (observed: a 197-item accessibility scan on a busy
		// staging worker exceeded the old 15-min cap and failed "Every scanner
		// failed").
		startToCloseTimeout: "60 minutes",
		heartbeatTimeout: "2 minutes",
		retry: {
			initialInterval: "5s",
			maximumInterval: "1 minute",
			backoffCoefficient: 2,
			maximumAttempts: 1,
		},
	});

// Semgrep SAST activity — clone + scan is expensive (large repos), so give it a
// long timeout and DON'T retry hard: a re-clone+re-scan on a transient failure
// would just burn minutes. It degrades gracefully (returns a `skipped` reason)
// rather than throwing, so a single attempt is the right trade-off.
const { runSemgrepScanActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "15 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

// Git-history secret scan — a FULL clone + gitleaks over the whole commit log is
// the heaviest step, so give it the longest timeout and a single attempt (same
// rationale as Semgrep). Degrades gracefully to a `skipped` reason.
const { runGitHistorySecretScanActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

// Auto false-positive review — the scan's final phase. Batched LLM judge with a
// cheap tier over only the ambiguous confidence band, so it's far lighter than a
// full review, but still an LLM loop: long timeout + heartbeat, single attempt
// (cost). Best-effort — the caller swallows any failure so the scan never fails.
const { autoReviewFindingsActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "20 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 1,
	},
});

export interface SecurityAccessibilityScanInput {
	scanId: string;
	projectId: string;
	storyId?: string | null;
	targetType: "PROJECT" | "FEATURE";
	/** FULL re-scans everything; INCREMENTAL only items changed since last scan. */
	mode?: "FULL" | "INCREMENTAL";
	userId: string;
	organizationId?: string | null;
	securityRequested: boolean;
	accessibilityRequested: boolean;
	/**
	 * Purge re-scan (G10): the caller has already deleted the current OPEN
	 * findings. Threaded to persist so carry-forward runs with
	 * `preserveSeverity = false` — a recurring finding's RESOLVED/DISMISSED status
	 * is still carried by fingerprint, but its severity is re-evaluated fresh
	 * (the whole point of a purge). Adding this field is replay-safe.
	 */
	purge?: boolean;
	/**
	 * Branch-scoped incremental scanning: the concrete branch this scan runs
	 * against (matches the scan row's `branch`). Enables per-branch checkpoints and
	 * diff-scoped code scanning. Absent/null ⇒ current whole-repo behavior. Adding
	 * these fields is replay-safe; their effect is gated behind a patch marker.
	 */
	branch?: string | null;
	/** Force a full code re-scan (skip the diff) even when a checkpoint exists. */
	forceFull?: boolean;
}

export interface SecurityAccessibilityScanOutput {
	success: boolean;
	securityFindingCount: number;
	accessibilityFindingCount: number;
	error?: string;
}

export async function securityAccessibilityScanWorkflow(
	input: SecurityAccessibilityScanInput,
): Promise<SecurityAccessibilityScanOutput> {
	const {
		scanId,
		projectId,
		storyId,
		targetType,
		mode,
		userId,
		organizationId,
		securityRequested,
		accessibilityRequested,
		purge,
		branch,
		forceFull,
	} = input;

	// Gate the new signal-quality persist/scan behavior (chunked items in the
	// scan input + fingerprint dedup/carry-forward + rubric/packs) behind a patch
	// marker so in-flight executions started before this change replay
	// deterministically: the new code path only runs on the patched branch, the
	// legacy single-blob path on the old branch. Adding fields to activity INPUT
	// is itself replay-safe; this gate is about the new control flow it enables.
	const signalQuality = patched("security-scan-signal-quality-v1");

	try {
		await markScanRunningActivity({ scanId });

		const ctx = await gatherScanContextActivity({
			projectId,
			storyId,
			targetType,
			mode,
		});

		// Branch-scoped incremental scanning: resolve the branch's remote HEAD
		// (targetSha) and the last-scanned commit (baseSha checkpoint) so the code
		// scanners can diff only what changed. Gated behind its OWN patch marker so
		// in-flight executions — whose history has no resolve activity — replay the
		// original activity sequence (no resolve, FULL code scans). On the patched
		// path the resolve is ALWAYS scheduled in this fixed position; its own
		// try/catch keeps a Temporal-level failure non-fatal (→ FULL). Adding the
		// resolved fields to the scanner/persist INPUTS is replay-safe, so those are
		// NOT gated — only the new activity CALL is.
		const branchIncremental = patched(
			"security-scan-branch-incremental-v1",
		);
		let codeScanMode: "FULL" | "DIFF" | undefined;
		let baseSha: string | undefined;
		let targetSha: string | undefined;
		let scanBranch: string | undefined;
		if (branchIncremental) {
			scanBranch = branch?.trim() || undefined;
			try {
				const resolved = await resolveScanCommitActivity({
					projectId,
					organizationId,
					branch: scanBranch ?? "",
					mode: mode ?? "FULL",
					forceFull,
				});
				codeScanMode = resolved.codeScanMode;
				baseSha = resolved.baseSha ?? undefined;
				targetSha = resolved.targetSha ?? undefined;
			} catch {
				// Infra failure resolving the range (the activity itself never
				// throws on app errors) — degrade to a full code scan.
				codeScanMode = "FULL";
			}
		}

		// Gate the Semgrep SAST code scan behind a patch marker so in-flight
		// executions (started before this change) replay deterministically:
		// the new activity is only scheduled on the patched path. Code scanning
		// is project-scope only — a per-feature maturation scan reviews planning
		// text, not the whole repo. The activity itself degrades gracefully
		// (no repo / missing binary / clone failure → `skipped`), so it never
		// fails the overall scan.
		const runSemgrep =
			patched("security-scan-semgrep-v1") &&
			ctx.semgrepEnabled &&
			targetType === "PROJECT";

		// Git-history secret scan — gated behind its own patch marker (separate
		// from Semgrep) so in-flight executions replay deterministically. Project
		// scope only; degrades gracefully like Semgrep.
		const runGitHistory =
			patched("security-scan-git-history-v1") &&
			ctx.gitHistoryEnabled &&
			targetType === "PROJECT";

		// Resolve the items to scan for BOTH paths. On the patched (new) path the
		// context already carries discrete `items` (chunked + parallelized in the
		// activity). On the legacy path — only ever hit when REPLAYING an
		// execution started before this change — the recorded context has the old
		// single `content` blob and no `items`; wrap it as one synthetic item so
		// the scan input shape is uniform. (The scan activity result on that path
		// also comes from history, so the input only needs to be deterministic.)
		const legacyCtx = ctx as unknown as {
			content?: string;
			projectName: string;
		};
		const scanItems = signalQuality
			? ctx.items
			: [
					{
						key: "__legacy_content__",
						label: legacyCtx.projectName,
						text: legacyCtx.content ?? "",
					},
				];
		const severityRubric = signalQuality ? ctx.severityRubric : undefined;
		// Knowledge packs go to the SECURITY prompt only, filtered by appliesTo
		// (absent ⇒ security, the default). Knowledge text — never executed.
		const knowledgePacks = signalQuality
			? ctx.knowledgePacks
					.filter(
						(p) =>
							p.appliesTo === undefined ||
							p.appliesTo === "SECURITY",
					)
					.map((p) => ({ title: p.title, content: p.content }))
			: undefined;

		// Build each enabled scanner's promise once (disabled → resolve(null)).
		// Kept in fixed order so the resilient + legacy paths schedule the same
		// activities in the same sequence (replay-safe).
		const securityPromise = securityRequested
			? runSecurityScanActivity({
					projectId,
					userId,
					organizationId,
					projectName: ctx.projectName,
					items: scanItems,
					customRules: ctx.securityRules,
					severityRubric,
					knowledgePacks,
				})
			: Promise.resolve(null);
		const accessibilityPromise = accessibilityRequested
			? runAccessibilityScanActivity({
					projectId,
					userId,
					organizationId,
					projectName: ctx.projectName,
					items: scanItems,
					customRules: ctx.accessibilityRules,
					severityRubric,
				})
			: Promise.resolve(null);
		// The diff-scope fields are undefined on the un-patched path, so the
		// activity input serializes identically to a pre-change history.
		const semgrepPromise = runSemgrep
			? runSemgrepScanActivity({
					projectId,
					userId,
					organizationId,
					workflowRunId: scanId,
					branch: scanBranch,
					baseSha,
					targetSha,
					codeScanMode,
				})
			: Promise.resolve(null);
		const gitHistoryPromise = runGitHistory
			? runGitHistorySecretScanActivity({
					projectId,
					userId,
					organizationId,
					workflowRunId: scanId,
					branch: scanBranch,
					baseSha,
					targetSha,
					codeScanMode,
				})
			: Promise.resolve(null);

		// Each scanner is independent, and the repo-based ones (Semgrep /
		// git-history) are explicitly best-effort — so a failure or Temporal
		// timeout in ANY one of them must NOT fail the whole scan. Gather them
		// resiliently (allSettled) and persist whatever succeeded; only a
		// wholesale failure (every requested scanner failed) fails the run. Gated
		// behind a patch marker so in-flight executions (which used the fail-fast
		// Promise.all) replay deterministically.
		let security: Awaited<typeof securityPromise> = null;
		let accessibility: Awaited<typeof accessibilityPromise> = null;
		let semgrep: Awaited<typeof semgrepPromise> = null;
		let gitHistory: Awaited<typeof gitHistoryPromise> = null;
		const failedScanners: string[] = [];
		// Raw rejection reasons of the failed scanners, kept so a wholesale
		// failure can explain *why* to the user (see describeScanFailureReason).
		const failedReasons: unknown[] = [];

		if (patched("security-scan-resilient-scanners-v1")) {
			const [secR, accR, semR, gitR] = await Promise.allSettled([
				securityPromise,
				accessibilityPromise,
				semgrepPromise,
				gitHistoryPromise,
			]);
			security = secR.status === "fulfilled" ? secR.value : null;
			accessibility = accR.status === "fulfilled" ? accR.value : null;
			semgrep = semR.status === "fulfilled" ? semR.value : null;
			gitHistory = gitR.status === "fulfilled" ? gitR.value : null;
			if (securityRequested && secR.status === "rejected") {
				failedScanners.push("Security");
				failedReasons.push(secR.reason);
			}
			if (accessibilityRequested && accR.status === "rejected") {
				failedScanners.push("Accessibility");
				failedReasons.push(accR.reason);
			}
			if (runSemgrep && semR.status === "rejected") {
				failedScanners.push("Semgrep");
				failedReasons.push(semR.reason);
			}
			if (runGitHistory && gitR.status === "rejected") {
				failedScanners.push("Git history");
				failedReasons.push(gitR.reason);
			}

			// Nothing succeeded → fail the run with a clear message rather than
			// recording a misleading clean scan. Append the transient-cause hint
			// (rate-limited / timed out / unavailable) so the failure toast tells
			// the user it's usually temporary and worth retrying, instead of a
			// bare "Every scanner failed". Gated behind its own patch marker so
			// in-flight executions replay the original message deterministically.
			const requestedCount = [
				securityRequested,
				accessibilityRequested,
				runSemgrep,
				runGitHistory,
			].filter(Boolean).length;
			if (
				requestedCount > 0 &&
				failedScanners.length === requestedCount
			) {
				const base = `Every scanner failed to complete (${failedScanners.join(", ")}).`;
				const hint = patched("scan-failure-reason-v1")
					? describeScanFailureReason(failedReasons)
					: null;
				throw new Error(hint ? `${base} ${hint}` : base);
			}
		} else {
			[security, accessibility, semgrep, gitHistory] = await Promise.all([
				securityPromise,
				accessibilityPromise,
				semgrepPromise,
				gitHistoryPromise,
			]);
		}

		const codeSecurityFindings: ScanFindingDraft[] =
			semgrep?.findings ?? [];
		const gitHistoryFindings: ScanFindingDraft[] =
			gitHistory?.findings ?? [];

		// Which scanners actually ran — surfaced in the History "what was scanned".
		const scanners = [
			securityRequested && security ? "Security" : null,
			accessibilityRequested && accessibility ? "Accessibility" : null,
			semgrep && semgrep.skipped === null ? "Semgrep" : null,
			gitHistory && gitHistory.skipped === null ? "Git history" : null,
		].filter((s): s is string => s !== null);

		// CARRY-FORWARD WIRING: in DIFF mode the code scan only looked at the changed
		// files, so thread those file PATHS as a SEPARATE carry-forward signal —
		// deliberately NOT merged into the planning-item `scannedItemKeys`. persist
		// drops a superseded Semgrep finding (location `path:line`) by EXACT path,
		// while a git-history secret — whose location embeds a file path but which
		// gitleaks DIFF (base..HEAD) can't re-detect once it predates the base —
		// always carries forward. Merging the paths into the substring-matched
		// planning keys would wrongly drop a pre-existing secret (and its triage)
		// the moment its file changed. Git-history commit ids are likewise NOT added.
		const rescannedCodePaths =
			codeScanMode === "DIFF" && semgrep?.changedFilePaths?.length
				? semgrep.changedFilePaths
				: [];

		const counts = await persistScanResultsActivity({
			scanId,
			projectId,
			storyId,
			userId,
			organizationId,
			mode,
			scannedItemKeys: ctx.scannedItemKeys,
			rescannedCodePaths,
			scanners,
			failedScanners,
			security,
			accessibility,
			codeSecurityFindings,
			gitHistoryFindings,
			// A purge re-scan re-evaluates severity fresh; a normal re-scan
			// preserves a recurring finding's prior triaged severity. Only the
			// patched path threads this — on a legacy replay the activity result
			// comes from history regardless, so the flag is inert there.
			preserveSeverity: signalQuality ? !purge : undefined,
			// Branch-scoped incremental scanning: advance the branch checkpoint to
			// the scanned HEAD and record the diff-scope counts. All undefined on
			// the un-patched path ⇒ input serializes identically to old history and
			// persist writes no checkpoint. `codeScanMode` gates whether those counts
			// are recorded (DIFF) or nulled (FULL/first scan → no "0 changed" line).
			scannedCommitSha: targetSha,
			codeScanMode,
			changedFileCount: semgrep?.changedFileCount,
			changedCommitCount: gitHistory?.changedCommitCount,
		});

		// FINAL PHASE (best-effort): auto-run the AI false-positive review so
		// findings arrive pre-triaged (likely FPs auto-dismissed reversibly,
		// confirmed low-confidence findings kept visible). Gated behind a patch
		// marker (replay-safe) + the project toggle; independent of which
		// scanners ran (it judges whatever findings they produced). A failure
		// here NEVER fails the scan, and the deterministic confidence-floor
		// default view holds whether or not the review ran.
		if (
			patched("security-scan-auto-review-v1") &&
			ctx.autoReviewEnabled &&
			counts.securityFindingCount + counts.accessibilityFindingCount > 0
		) {
			try {
				await autoReviewFindingsActivity({
					scanId,
					projectId,
					userId,
					organizationId,
				});
			} catch {
				// Best-effort — the scan already completed and its findings are
				// visible. The review row was marked FAILED inside the activity.
			}
		}

		return {
			success: true,
			securityFindingCount: counts.securityFindingCount,
			accessibilityFindingCount: counts.accessibilityFindingCount,
		};
	} catch (err) {
		const raw = err instanceof Error ? err.message : String(err);
		// Enrich EVERY failure path — not just the wholesale "every scanner
		// failed" branch — with the transient-cause hint, so a FAILED scan always
		// persists an actionable message the UI can show. The wholesale branch
		// already appended its hint from the raw per-scanner reasons;
		// ensureScanFailureHint is idempotent, and for every other path (context
		// gather, commit resolve, persist) it classifies the caught error's cause
		// chain here. Gated so in-flight FAILED scans replay the exact message they
		// recorded under the old code.
		const message = patched("scan-failure-reason-v2")
			? ensureScanFailureHint(raw, err)
			: raw;
		try {
			await failScanActivity({
				scanId,
				projectId,
				userId,
				organizationId,
				message,
			});
		} catch {
			// failScan is best-effort; the watchdog-free design means the row
			// stays RUNNING only if both the scan AND this fail-write die.
		}
		return {
			success: false,
			securityFindingCount: 0,
			accessibilityFindingCount: 0,
			error: message,
		};
	}
}
