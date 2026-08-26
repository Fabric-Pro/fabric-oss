/**
 * On-demand AI FALSE-POSITIVE REVIEW activities (G7).
 *
 * Pipeline (orchestrated by scanFindingReviewWorkflow):
 *   markReviewRunning → gatherReviewFindings → runFindingReview
 *   → persistReviewResults   (failReview on any error)
 *
 * `runFindingReviewActivity` runs an ADVERSARIAL, fresh-context judge per
 * finding (only the finding + its evidence + the severity rubric — never the
 * scanner's prior reasoning), with bounded concurrency and a heartbeat between
 * batches. It PROPOSES dismiss / severity-change / uncertain verdicts; proposals
 * NEVER mutate findings. All DB writes happen in activities, so the workflow
 * stays replay-safe.
 */

import {
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { cacheableSystem } from "@repo/ai/prompt-cache";
import {
	createScanFindingReview,
	DEFAULT_CONFIDENCE_FLOOR,
	db,
	getBoundPromptForAgent,
	getProjectScanConfig,
	listOpenFindingsForReview,
	recordScanActivity,
	type ScanReviewProposal,
	updateScanFinding,
	updateScanFindingReview,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import {
	buildFindingReviewRequest,
	mapRawReviewToProposal,
	type ReviewFindingInput,
	type ReviewProposal,
	ReviewResultSchema,
	type ScanSeverityValue,
} from "./review-schemas";

// =============================================================================
// Tunables
// =============================================================================

/**
 * Parallel judge calls per batch ("multiple parallel review agents"). Each
 * batch of this many findings is judged concurrently, then a heartbeat fires —
 * so this bounds both concurrency AND the heartbeat cadence.
 */
const REVIEW_CONCURRENCY = 4;
/**
 * Hard ceiling on findings reviewed in one run (cost/latency guard). Findings
 * are gathered severity-desc, so a truncated batch favours impact. Raised from
 * 200 so the low-signal tail of a large scan is actually reachable by the
 * on-demand review; the AUTO review additionally band-filters (below), so its
 * per-scan call count is far smaller than this cap.
 */
const MAX_FINDINGS_PER_REVIEW = 600;

/**
 * AUTO-review confidence band. The auto phase judges ONLY the ambiguous, VISIBLE
 * findings — those at/above the default view's floor but not obviously-strong —
 * and skips both tails: findings below the floor are already hidden (judging
 * them would spend tokens on rows nobody sees), and findings at/above the
 * ceiling (a HIGH-confidence Semgrep rule, a gitleaks secret at 0.85, an AI
 * finding the scanner rated high) are already trusted. This turns a
 * whole-scan's worth of calls into a few dozen. The on-demand review ignores
 * the band and judges everything.
 */
const AUTO_REVIEW_MIN_CONFIDENCE = DEFAULT_CONFIDENCE_FLOOR;
const AUTO_REVIEW_MAX_CONFIDENCE = 0.85;

/**
 * Confidence a judge-CONFIRMED finding is lifted to (never lowered) when the
 * auto-review applies its verdict — so a confirmed finding stays above the
 * default view's floor and reads as high-confidence. The deterministic view
 * then reflects the judge's refinement without depending on it.
 */
const CONFIRMED_CONFIDENCE = 0.9;

/**
 * Task tier for the FP judge. A bounded classify-with-evidence task does NOT
 * need the top ("COMPLEX") model — SIMPLE is the cheaper standard tier — so the
 * targeted, per-finding judge stays inexpensive. The fixed adversarial rubric is
 * prompt-cached (see buildFindingReviewPrompt / cacheableSystem callers) to
 * further cut input tokens.
 */
const JUDGE_TASK_TYPE = "SIMPLE" as const;

/**
 * Severity rank (worst = highest) — used by the auto-apply step to (a) refuse to
 * auto-dismiss a CRITICAL/HIGH finding and (b) apply a judge's severity re-grade
 * only when it is an INCREASE, never a silent downgrade.
 */
const SEVERITY_RANK: Record<string, number> = {
	CRITICAL: 4,
	HIGH: 3,
	MEDIUM: 2,
	LOW: 1,
};

/**
 * Project the in-memory {@link ReviewProposal}s onto the DB JSON shape. The two
 * shapes are structurally identical (the DB type just widens `confidence` to
 * `string` and the enums to the Prisma unions), so this is an explicit typed map
 * rather than an `as unknown as` cast.
 */
function toScanReviewProposals(
	proposals: ReviewProposal[],
): ScanReviewProposal[] {
	return proposals.map((p) => ({
		findingId: p.findingId,
		verdict: p.verdict,
		reasoning: p.reasoning,
		confidence: p.confidence,
		...(p.suggestedStatus ? { suggestedStatus: p.suggestedStatus } : {}),
		...(p.suggestedSeverity
			? { suggestedSeverity: p.suggestedSeverity }
			: {}),
		...(p.evidenceQuote ? { evidenceQuote: p.evidenceQuote } : {}),
	}));
}

// =============================================================================
// Types
// =============================================================================

export interface MarkReviewRunningInput {
	reviewId: string;
}

export interface GatherReviewFindingsInput {
	projectId: string;
	/** Pin a specific scan; omit to use the latest COMPLETED scan's findings. */
	scanId?: string | null;
}

export interface GatherReviewFindingsOutput {
	findings: ReviewFindingInput[];
	/** The (configured or seeded-default) severity rubric text for the prompt. */
	rubric: string;
}

export interface RunFindingReviewInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	findings: ReviewFindingInput[];
	rubric: string;
}

export interface RunFindingReviewOutput {
	proposals: ReviewProposal[];
	reviewedCount: number;
	modelName: string | null;
	inputTokens: number;
	outputTokens: number;
}

export interface PersistReviewResultsInput {
	reviewId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	proposals: ReviewProposal[];
	reviewedCount: number;
	modelName: string | null;
	inputTokens: number;
	outputTokens: number;
}

export interface FailReviewInput {
	reviewId: string;
	message: string;
}

export interface AutoReviewFindingsInput {
	scanId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
}

export interface AutoReviewFindingsOutput {
	/** The review run created for this auto-review, or null when nothing to judge. */
	reviewId: string | null;
	reviewedCount: number;
	/** Findings auto-dismissed as likely false positives (reversible). */
	autoDismissedCount: number;
	/** Findings the judge confirmed (their confidence was lifted to stay visible). */
	confirmedCount: number;
}

// =============================================================================
// Activities
// =============================================================================

export async function markReviewRunningActivity(
	input: MarkReviewRunningInput,
): Promise<void> {
	await updateScanFindingReview(input.reviewId, {
		status: "RUNNING",
		startedAt: new Date(),
	});
}

/**
 * Load the project's current OPEN findings + the severity rubric the judge will
 * use for any severity re-grade. The rubric falls back to the seeded default
 * description when none is configured.
 */
export async function gatherReviewFindingsActivity(
	input: GatherReviewFindingsInput,
): Promise<GatherReviewFindingsOutput> {
	heartbeat("gathering findings to review");
	const findings = await listOpenFindingsForReview(
		input.projectId,
		input.scanId ?? undefined,
	);
	const config = await getProjectScanConfig(input.projectId);
	return {
		findings,
		rubric: renderSeverityRubric(config),
	};
}

/**
 * Render the per-project severity rubric into prompt text. Reads
 * `severityRubric` off the resolved scan config when present; otherwise emits a
 * CVSS-aligned default so the judge always has bands to grade against. Tolerates
 * the config not yet carrying the field (additive column) by feature-detecting.
 */
function renderSeverityRubric(config: unknown): string {
	const rubric =
		config && typeof config === "object" && "severityRubric" in config
			? (config as { severityRubric?: unknown }).severityRubric
			: undefined;
	if (Array.isArray(rubric)) {
		const lines = rubric
			.map((r) => {
				if (!r || typeof r !== "object") {
					return null;
				}
				const row = r as Record<string, unknown>;
				const sev =
					typeof row.severity === "string" ? row.severity : null;
				const def =
					typeof row.definition === "string"
						? row.definition
						: typeof row.guidance === "string"
							? row.guidance
							: null;
				return sev && def ? `- ${sev}: ${def}` : null;
			})
			.filter((l): l is string => l !== null);
		if (lines.length > 0) {
			return lines.join("\n");
		}
	}
	return DEFAULT_SEVERITY_RUBRIC;
}

const DEFAULT_SEVERITY_RUBRIC = `- CRITICAL: Directly exploitable with severe impact (full account/data takeover, RCE, secret exposure) and little/no precondition.
- HIGH: Serious impact (privilege escalation, sensitive-data exposure, auth bypass) but with some precondition or narrower scope.
- MEDIUM: Real weakness with limited impact or requiring significant preconditions; defense-in-depth gaps.
- LOW: Minor or best-practice issue; minimal direct impact.`;

/**
 * On-demand review activity — judges the findings the review workflow gathered
 * (every OPEN finding). Thin wrapper over {@link runAdversarialReview}, which the
 * auto-review activity also reuses.
 */
export async function runFindingReviewActivity(
	input: RunFindingReviewInput,
): Promise<RunFindingReviewOutput> {
	return runAdversarialReview(input);
}

/**
 * Run the adversarial judge over the findings: batched, bounded concurrency,
 * heartbeated, `Promise.allSettled` so one judge failure doesn't sink the run.
 * Aggregates proposals + token totals. Resolves the AI model once and reuses it
 * across calls (same model/usage logging as the scanner). Shared by the on-demand
 * review activity and the auto-review activity.
 */
async function runAdversarialReview(
	input: RunFindingReviewInput,
): Promise<RunFindingReviewOutput> {
	const { projectId, userId, organizationId, rubric } = input;
	const findings = input.findings.slice(0, MAX_FINDINGS_PER_REVIEW);

	if (findings.length === 0) {
		return {
			proposals: [],
			reviewedCount: 0,
			modelName: null,
			inputTokens: 0,
			outputTokens: 0,
		};
	}

	// Load the org/user-overridable adversarial judge rubric bound in the
	// prompt-management UI ONCE for the whole run; falls back to the in-code
	// default inside buildFindingReviewPrompt when nothing is bound (passed as
	// undefined). A prompt-binding hiccup must never fail the review.
	let boundRubric: string | undefined;
	try {
		const bound = await getBoundPromptForAgent({
			agentName: "security_scan_fp_judge",
			documentType: "GENERAL",
			storyKind: null,
			userId,
			organizationId: organizationId ?? undefined,
		});
		boundRubric = bound?.version?.content ?? undefined;
	} catch (error) {
		logger.warn(
			"[ScanReview] Failed to load FP-judge prompt binding — using in-code default rubric",
			{
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		boundRubric = undefined;
	}

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: JUDGE_TASK_TYPE },
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "security-scan",
		},
	);

	logger.info("[ScanReview] Running adversarial false-positive review", {
		projectId,
		findingCount: findings.length,
		modelString: metadata.modelString,
		provider: metadata.provider,
	});

	// Heartbeat continuously so a slow batch never times the activity out (the
	// per-batch heartbeat below also fires, but a long single call needs this).
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat("reviewing findings: waiting for LLM");
		} catch {
			/* activity cancelled — finally clears the interval */
		}
	}, 30_000);

	const start = Date.now();
	const proposals: ReviewProposal[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let reviewedCount = 0;

	/** Judge a single finding; returns its proposal + token usage (or null). */
	const judgeOne = async (
		finding: ReviewFindingInput,
	): Promise<{
		proposal: ReviewProposal;
		inputTokens: number;
		outputTokens: number;
	} | null> => {
		try {
			// Feed the judge the finding's REAL evidence (the matched Semgrep
			// code, gitleaks rule/location, or AI-scanner quote). The prior code
			// hardcoded `undefined` here, so the prompt's evidence block was always
			// the "(no excerpt available…)" fallback and the judge abstained on
			// everything — the root cause of the 200/200 "uncertain" run.
			const request = buildFindingReviewRequest(
				finding,
				rubric,
				finding.evidence ?? undefined,
				boundRubric,
			);
			const result = await generateObject({
				model,
				schema: ReviewResultSchema,
				// The fixed adversarial rubric is a cacheable system prefix so it
				// isn't re-billed on every per-finding call; only the finding block
				// in `prompt` varies. Marker is provider-agnostic.
				system: cacheableSystem(request.system),
				prompt: request.prompt,
				temperature: 0,
			});
			return {
				proposal: mapRawReviewToProposal(finding.id, result.object),
				inputTokens: result.usage?.inputTokens ?? 0,
				outputTokens: result.usage?.outputTokens ?? 0,
			};
		} catch (error) {
			// One finding failing the judge must not sink the whole review; it
			// simply gets no proposal (the user keeps the finding as-is).
			logger.warn("[ScanReview] Judge failed for a finding", {
				projectId,
				findingId: finding.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	};

	try {
		// Process in batches, heartbeating between them. Each batch holds at most
		// REVIEW_CONCURRENCY findings and is judged in parallel — so the number of
		// concurrent LLM calls is bounded by the batch size (cost/latency guard).
		for (let i = 0; i < findings.length; i += REVIEW_CONCURRENCY) {
			const batch = findings.slice(i, i + REVIEW_CONCURRENCY);
			const settled = await Promise.allSettled(
				batch.map((f) => judgeOne(f)),
			);
			for (const r of settled) {
				if (r.status === "fulfilled" && r.value) {
					proposals.push(r.value.proposal);
					inputTokens += r.value.inputTokens;
					outputTokens += r.value.outputTokens;
				}
				reviewedCount += 1;
			}
			heartbeat(
				`reviewed ${Math.min(i + REVIEW_CONCURRENCY, findings.length)} of ${findings.length} findings`,
			);
		}
	} finally {
		clearInterval(heartbeatInterval);
	}

	trackUsage();
	logModelUsageAsync({
		context: { userId, organizationId: organizationId ?? undefined },
		metadata,
		// Attribute cost to the tier the judge actually resolved (SIMPLE), not the
		// old hardcoded COMPLEX.
		taskType: JUDGE_TASK_TYPE,
		usage: {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
		},
		latencyMs: Date.now() - start,
		agentId: "security-scan:fp-review",
		projectId,
	});

	logger.info("[ScanReview] Review complete", {
		projectId,
		reviewedCount,
		proposalCount: proposals.length,
		flaggedFalsePositive: proposals.filter(
			(p) => p.verdict === "false_positive",
		).length,
	});

	return {
		proposals,
		reviewedCount,
		modelName: metadata.modelString ?? null,
		inputTokens,
		outputTokens,
	};
}

/**
 * Persist proposals + telemetry, mark the review COMPLETED, and record a
 * FINDINGS_REVIEWED activity summary. Proposals are propose-only — NO finding is
 * mutated here. Free-text fields were already redacted at mapping time.
 */
export async function persistReviewResultsActivity(
	input: PersistReviewResultsInput,
): Promise<{ reviewedCount: number; flaggedCount: number }> {
	const flaggedCount = input.proposals.filter(
		(p) => p.verdict === "false_positive",
	).length;
	const uncertainCount = input.proposals.filter(
		(p) => p.verdict === "uncertain",
	).length;

	// Duration from the review run's startedAt (set by markReviewRunning).
	let durationMs: number | null = null;
	try {
		const review = await db.scanFindingReview.findUnique({
			where: { id: input.reviewId },
			select: { startedAt: true },
		});
		if (review?.startedAt) {
			durationMs = Date.now() - review.startedAt.getTime();
		}
	} catch {
		/* telemetry only — ignore */
	}

	const costUsd = await estimateReviewCostUsd(
		input.modelName,
		input.inputTokens,
		input.outputTokens,
	);

	await updateScanFindingReview(input.reviewId, {
		status: "COMPLETED",
		completedAt: new Date(),
		// Persist the typed proposals as JSON (structurally JSON-safe).
		proposals: toScanReviewProposals(input.proposals),
		reviewedCount: input.reviewedCount,
		modelName: input.modelName,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		costUsd,
		durationMs,
	});

	const summary =
		input.reviewedCount === 0
			? "Reviewed 0 findings — nothing open to review"
			: `Reviewed ${input.reviewedCount} finding${input.reviewedCount === 1 ? "" : "s"} — flagged ${flaggedCount} as likely false positive${flaggedCount === 1 ? "" : "s"}${uncertainCount > 0 ? `, ${uncertainCount} uncertain` : ""}`;

	await recordScanActivity({
		projectId: input.projectId,
		type: "FINDINGS_REVIEWED",
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		summary,
		metadata: {
			reviewedCount: input.reviewedCount,
			flaggedFalsePositive: flaggedCount,
			uncertain: uncertainCount,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
			...(durationMs != null ? { durationMs } : {}),
			...(costUsd != null ? { costUsd } : {}),
			...(input.modelName ? { modelName: input.modelName } : {}),
		},
	}).catch(() => {});

	return { reviewedCount: input.reviewedCount, flaggedCount };
}

export async function failReviewActivity(
	input: FailReviewInput,
): Promise<void> {
	await updateScanFindingReview(input.reviewId, {
		status: "FAILED",
		completedAt: new Date(),
		error: input.message.slice(0, 1000),
	});
}

/**
 * AUTO false-positive review — the scan's final phase (best-effort). Judges ONLY
 * the visible ambiguous band of a scan's fresh findings (see AUTO_REVIEW_*), then
 * APPLIES the verdicts so findings arrive pre-triaged:
 *   - a confident false_positive → status DISMISSED (reversible — the user reopens),
 *   - a confirmed finding → its confidence lifted to/above the floor (so it stays
 *     in the default view even if the scanner rated it low) + any severity re-grade,
 *   - uncertain → left OPEN, untouched.
 * The verdicts + reasoning are persisted on a ScanFindingReview run so the UI can
 * show WHY. Everything runs in THIS activity (all DB writes here → replay-safe);
 * the workflow only sequences the call and swallows failure. NOTHING here can fail
 * or blank a scan, and the deterministic confidence-floor default view holds
 * whether or not this ran.
 */
export async function autoReviewFindingsActivity(
	input: AutoReviewFindingsInput,
): Promise<AutoReviewFindingsOutput> {
	const { scanId, projectId, userId, organizationId } = input;

	// Only the shown-but-ambiguous band: skip the already-hidden low-confidence
	// tail (no tokens on rows nobody sees) and the obviously-strong high band.
	const findings = await listOpenFindingsForReview(projectId, scanId, {
		minConfidence: AUTO_REVIEW_MIN_CONFIDENCE,
		maxConfidence: AUTO_REVIEW_MAX_CONFIDENCE,
	});
	if (findings.length === 0) {
		logger.info(
			"[ScanReview] Auto-review: no findings in the review band",
			{
				projectId,
				scanId,
			},
		);
		return {
			reviewId: null,
			reviewedCount: 0,
			autoDismissedCount: 0,
			confirmedCount: 0,
		};
	}

	const config = await getProjectScanConfig(projectId);
	const rubric = renderSeverityRubric(config);

	// Record the run so the page's latest-review + per-finding reasoning surface it.
	const review = await createScanFindingReview({
		projectId,
		userId,
		organizationId,
	});
	await updateScanFindingReview(review.id, {
		status: "RUNNING",
		startedAt: new Date(),
	});

	let run: RunFindingReviewOutput;
	try {
		run = await runAdversarialReview({
			projectId,
			userId,
			organizationId,
			findings,
			rubric,
		});
	} catch (error) {
		await updateScanFindingReview(review.id, {
			status: "FAILED",
			completedAt: new Date(),
			error: (error instanceof Error
				? error.message
				: String(error)
			).slice(0, 1000),
		});
		throw error;
	}

	const costUsd = await estimateReviewCostUsd(
		run.modelName,
		run.inputTokens,
		run.outputTokens,
	);
	await updateScanFindingReview(review.id, {
		status: "COMPLETED",
		completedAt: new Date(),
		proposals: toScanReviewProposals(run.proposals),
		reviewedCount: run.reviewedCount,
		modelName: run.modelName,
		inputTokens: run.inputTokens,
		outputTokens: run.outputTokens,
		costUsd,
	});

	// Apply the verdicts. Keyed on the findings we loaded so we can read each
	// one's current confidence + severity; everything applied here is reversible.
	const confidenceById = new Map(
		findings.map((f) => [f.id, f.confidence ?? 0]),
	);
	const severityById = new Map(findings.map((f) => [f.id, f.severity]));
	let autoDismissedCount = 0;
	let confirmedCount = 0;
	for (const p of run.proposals) {
		const severity = severityById.get(p.findingId);
		if (p.verdict === "false_positive" && shouldAutoDismiss(p, severity)) {
			const ok = await updateScanFinding(p.findingId, projectId, {
				status: "DISMISSED",
			});
			if (ok) {
				autoDismissedCount += 1;
			}
		} else if (p.verdict === "confirmed") {
			const current = confidenceById.get(p.findingId) ?? 0;
			// Lift confidence so a confirmed finding stays in the default view, and
			// apply a severity re-grade ONLY when it's an increase (never a silent
			// downgrade — see resolveSeverityUpgrade).
			const upgrade = resolveSeverityUpgrade(
				severity,
				p.suggestedSeverity,
			);
			const ok = await updateScanFinding(p.findingId, projectId, {
				confidence: Math.max(current, CONFIRMED_CONFIDENCE),
				...(upgrade ? { severity: upgrade } : {}),
			});
			if (ok) {
				confirmedCount += 1;
			}
		}
	}

	await recordScanActivity({
		projectId,
		type: "FINDINGS_REVIEWED",
		userId,
		organizationId: organizationId ?? null,
		summary: `AI review auto-triaged ${run.reviewedCount} finding${
			run.reviewedCount === 1 ? "" : "s"
		} — dismissed ${autoDismissedCount} likely false positive${
			autoDismissedCount === 1 ? "" : "s"
		}`,
		metadata: {
			auto: true,
			reviewId: review.id,
			reviewedCount: run.reviewedCount,
			autoDismissed: autoDismissedCount,
			confirmed: confirmedCount,
			...(run.modelName ? { modelName: run.modelName } : {}),
		},
	}).catch(() => {});

	logger.info("[ScanReview] Auto-review complete", {
		projectId,
		scanId,
		reviewedCount: run.reviewedCount,
		autoDismissedCount,
		confirmedCount,
	});

	return {
		reviewId: review.id,
		reviewedCount: run.reviewedCount,
		autoDismissedCount,
		confirmedCount,
	};
}

/**
 * Whether a false_positive proposal may be AUTO-dismissed, given the finding's
 * severity.
 *
 * SAFETY: a CRITICAL or HIGH finding is NEVER auto-dismissed — important findings
 * must not be silently hidden by the scan. The false_positive PROPOSAL + reasoning
 * is still persisted on the review run and shown in the UI, so a human sees the
 * judge's opinion and can dismiss it manually; we just never bury it automatically.
 *
 * For MEDIUM / LOW noise, the judge is refute-by-default and abstains ("uncertain")
 * when unsure, so a false_positive verdict already means it found the finding
 * benign — dismiss on a reasonably-confident (high/medium) verdict; a
 * low-confidence FP stays OPEN for a human. An unknown/absent severity is treated
 * conservatively (never auto-dismissed). Reversible regardless.
 */
export function shouldAutoDismiss(
	proposal: ReviewProposal,
	severity: string | undefined,
): boolean {
	if (severity !== "MEDIUM" && severity !== "LOW") {
		return false;
	}
	return proposal.confidence === "high" || proposal.confidence === "medium";
}

/**
 * The severity to auto-apply on a CONFIRMED verdict, or undefined for no change.
 * Only an INCREASE is applied — the judge may up-grade an under-rated finding,
 * but never silently DOWN-grade a real HIGH/CRITICAL (reopen restores status,
 * not severity, so a downgrade isn't cleanly reversible; it stays a human
 * decision on the on-demand apply flow). Pure + exported for unit testing.
 */
export function resolveSeverityUpgrade(
	current: string | undefined,
	suggested: ScanSeverityValue | undefined,
): ScanSeverityValue | undefined {
	if (!suggested || !current) {
		return undefined;
	}
	return SEVERITY_RANK[suggested] > SEVERITY_RANK[current]
		? suggested
		: undefined;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Best-effort USD cost for a review from the AiModel pricing catalog. Returns
 * null when the model isn't found or has no pricing (the UI then shows tokens
 * without a dollar value). Mirrors the scanner's `estimateScanCostUsd`.
 */
async function estimateReviewCostUsd(
	modelName: string | null,
	inputTokens: number,
	outputTokens: number,
): Promise<number | null> {
	if (!modelName) {
		return null;
	}
	try {
		const canonicalName = modelName.split("/").pop() ?? modelName;
		const model = await db.aiModel.findUnique({
			where: { canonicalName },
			select: { inputCostPer1M: true, outputCostPer1M: true },
		});
		if (!model || (!model.inputCostPer1M && !model.outputCostPer1M)) {
			return null;
		}
		const cost =
			(inputTokens / 1_000_000) * (model.inputCostPer1M ?? 0) +
			(outputTokens / 1_000_000) * (model.outputCostPer1M ?? 0);
		return Math.round(cost * 1_000_000) / 1_000_000;
	} catch {
		return null;
	}
}
