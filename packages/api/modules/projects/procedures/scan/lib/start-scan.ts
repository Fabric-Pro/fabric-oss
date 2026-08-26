/**
 * Shared helper to create a ProjectScan row and start the scan workflow.
 * Used by the manual trigger procedure and the maturation-gate auto-trigger.
 */

import {
	createProjectScan,
	type FeatureDraftingStage,
	getProjectReposForCodeSearch,
	getProjectScanConfig,
	hasActiveScan,
	recordScanActivity,
	updateProjectScan,
} from "@repo/database";
import { logger } from "@repo/logs";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";

export interface StartProjectScanArgs {
	projectId: string;
	storyId?: string | null;
	targetType: "PROJECT" | "FEATURE";
	trigger: "MANUAL" | "MATURATION_GATE";
	/** FULL re-scans everything; INCREMENTAL only items changed since last scan. */
	mode?: "FULL" | "INCREMENTAL";
	userId: string;
	organizationId?: string | null;
	securityEnabled: boolean;
	accessibilityEnabled: boolean;
	/**
	 * Repo-based scanners. PROJECT-scope only — the workflow gates them on
	 * `targetType === "PROJECT"` and re-reads the saved config to actually run
	 * them, so they aren't threaded into the workflow input here. They count
	 * only toward "is there anything to scan?" so a project that enables solely
	 * the repo scanners can still start a scan.
	 */
	semgrepEnabled?: boolean;
	gitHistoryEnabled?: boolean;
	/**
	 * Purge re-scan (G10). When the caller has already deleted the project's
	 * OPEN findings, this threads `purge: true` into the workflow so the persist
	 * step re-evaluates severity fresh (carry-forward still preserves a recurring
	 * finding's RESOLVED/DISMISSED status by fingerprint — only the severity is
	 * re-graded). Inert on the AI workflow when the signal-quality path isn't
	 * patched in; harmless to thread regardless.
	 */
	purge?: boolean;
	/**
	 * Explicit branch override for a branch-targeted / bulk manual trigger. When
	 * provided (incl. `null` for a no-repo scan) it wins over the project's
	 * configured scanBranch / repo default; omitted ⇒ resolve as before. The
	 * resolved value is written to the scan row AND threaded into the workflow
	 * input, so the two always agree (the per-branch checkpoint keys on it).
	 */
	branch?: string | null;
	/**
	 * Force a full code re-scan (skip the incremental diff) even when a checkpoint
	 * exists. Threaded straight into the workflow input.
	 */
	forceFull?: boolean;
}

/**
 * Create the scan row and dispatch the workflow on the general-purpose
 * `fabric-worker` queue. Returns null when neither scanner is enabled.
 */
export async function startProjectScan(
	args: StartProjectScanArgs,
): Promise<{ scanId: string; workflowId: string } | null> {
	const securityRequested = args.securityEnabled;
	const accessibilityRequested = args.accessibilityEnabled;
	// Semgrep SAST + git-history secret scans are repo-based and run only on a
	// PROJECT-scope scan (the workflow gates them on targetType === "PROJECT").
	// They count toward "is there anything to scan?" so a project that enables
	// only the repo scanners can still run a scan.
	const codeScannersRequested =
		args.targetType === "PROJECT" &&
		(args.semgrepEnabled === true || args.gitHistoryEnabled === true);
	if (
		!securityRequested &&
		!accessibilityRequested &&
		!codeScannersRequested
	) {
		return null;
	}
	// Feature-scoped (maturation) scans always re-read their one feature in full.
	const mode = args.targetType === "FEATURE" ? "FULL" : (args.mode ?? "FULL");

	// Resolve which branch this scan targets. An explicit override (a
	// branch-targeted / bulk manual trigger) wins; otherwise fall back to the
	// project's configured scanBranch, else the connected repo's default branch,
	// else null (no repo). Recorded on the scan row so the results view + history
	// are branch-aware and the repo-based scanners clone the right ref — and it MUST
	// equal the branch threaded into the workflow input below, since the per-branch
	// checkpoint write keys on the scan row's branch.
	let branch: string | null;
	if (args.branch !== undefined) {
		branch = args.branch;
	} else {
		// Read the config (source of the selection) and repos (source of the
		// default) — both cheap, tenant-scoped.
		const scanConfig = await getProjectScanConfig(args.projectId);
		const repos = await getProjectReposForCodeSearch(args.projectId);
		branch = scanConfig.scanBranch?.trim() || repos[0]?.branch || null;
	}

	const scan = await createProjectScan({
		projectId: args.projectId,
		storyId: args.storyId ?? null,
		trigger: args.trigger,
		targetType: args.targetType,
		mode,
		securityRequested,
		accessibilityRequested,
		branch,
		userId: args.userId,
		organizationId: args.organizationId ?? null,
	});

	// Page-history entry (best-effort — never block the scan dispatch). Name the
	// branch the scan ran against when one was resolved.
	const baseSummary =
		args.trigger === "MATURATION_GATE"
			? "Started a maturation-gate scan"
			: mode === "INCREMENTAL"
				? "Started a scan (changed items)"
				: "Started a full scan";
	await recordScanActivity({
		projectId: args.projectId,
		type: "SCAN_STARTED",
		userId: args.userId,
		organizationId: args.organizationId ?? null,
		scanId: scan.id,
		summary: branch ? `${baseSummary} on branch "${branch}"` : baseSummary,
	}).catch(() => {});

	// Lazy-load @repo/temporal so importing this helper (and the stage-transition
	// procedures that use it) doesn't pull the temporal worker graph into their
	// module graph — keeps unit-test mocks lean and procedure imports light.
	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();
	const workflowId = `security-scan-${scan.id}`;
	const handle = await client.workflow.start(
		"securityAccessibilityScanWorkflow",
		withCorrelationMemo({
			taskQueue: "fabric-worker",
			workflowId,
			args: [
				{
					scanId: scan.id,
					projectId: args.projectId,
					storyId: args.storyId ?? null,
					targetType: args.targetType,
					mode,
					userId: args.userId,
					organizationId: args.organizationId ?? null,
					securityRequested,
					accessibilityRequested,
					// Purge re-scan (G10): re-grade severity fresh instead of
					// carrying the prior triaged severity forward. Only set on a
					// purge; omitted otherwise so existing behavior is unchanged.
					...(args.purge ? { purge: true } : {}),
					// Branch-scoped incremental scanning: thread the RESOLVED branch
					// (identical to the scan row's `branch`, which the checkpoint
					// write keys on) plus the force-full override. Omitted when
					// null/false so existing whole-repo scans keep their input verbatim.
					...(branch !== null ? { branch } : {}),
					...(args.forceFull ? { forceFull: true } : {}),
				},
			],
			// A large project (up to the 200-item cap) scanned by the AI engines
			// with adaptive parallel concurrency — self-tuning to the AI gateway's
			// TPM limit and degrading back toward serial under sustained throttling
			// — plus the git-history (gitleaks) full clone can legitimately run well
			// past an hour on a busy shared worker. The individual scan activities
			// self-limit (60-min startToClose + 2-min heartbeat), so a generous
			// execution ceiling only prevents a healthy-but-slow run from being
			// killed mid-scan (it must sit above the AI activity's 60-min cap so a
			// single full attempt + persist has room); it never masks a hang.
			workflowExecutionTimeout: "90 minutes",
		}),
	);

	await updateProjectScan(scan.id, { workflowId: handle.workflowId });

	return { scanId: scan.id, workflowId: handle.workflowId };
}

/**
 * Auto-trigger a feature-scoped scan when a feature transitions INTO the
 * project's configured maturation gate. Best-effort: deduped against any
 * in-flight scan and guarded so it never disrupts the stage transition.
 */
export async function maybeTriggerMaturationScan(args: {
	projectId: string;
	storyId: string;
	previousStage: FeatureDraftingStage | null | undefined;
	newStage: FeatureDraftingStage;
	userId: string;
	organizationId?: string | null;
}): Promise<void> {
	try {
		const config = await getProjectScanConfig(args.projectId);
		if (!config.autoScanOnMaturation) {
			return;
		}
		if (!config.securityEnabled && !config.accessibilityEnabled) {
			return;
		}
		// Only fire on a fresh transition INTO the gate (not edits of an item
		// already at the gate stage).
		if (args.newStage !== config.maturationGate) {
			return;
		}
		if (args.previousStage === config.maturationGate) {
			return;
		}
		if (await hasActiveScan(args.projectId, { storyId: args.storyId })) {
			return;
		}

		const result = await startProjectScan({
			projectId: args.projectId,
			storyId: args.storyId,
			targetType: "FEATURE",
			trigger: "MATURATION_GATE",
			userId: args.userId,
			organizationId: args.organizationId ?? null,
			securityEnabled: config.securityEnabled,
			accessibilityEnabled: config.accessibilityEnabled,
		});
		if (result) {
			logger.info("[SecurityScan] Maturation-gate scan started", {
				projectId: args.projectId,
				storyId: args.storyId,
				scanId: result.scanId,
				gate: config.maturationGate,
			});
		}
	} catch (error) {
		logger.warn("[SecurityScan] Maturation-gate auto-trigger failed", {
			projectId: args.projectId,
			storyId: args.storyId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
