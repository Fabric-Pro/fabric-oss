/**
 * Security & Accessibility scanning activities.
 *
 * Pipeline (orchestrated by securityAccessibilityScanWorkflow):
 *   markScanRunning → gatherScanContext → [runSecurityScan ‖ runAccessibilityScan]
 *   → persistScanResults  (failScan on any error)
 *
 * Each scanner resolves an AI model via the centralized entry point and calls
 * generateObject against a strict findings schema. All DB writes happen in
 * activities, so the workflow stays replay-safe.
 */

import {
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { classifyLimitError } from "@repo/ai/limits";
import { cacheableSystem } from "@repo/ai/prompt-cache";
import {
	carryForwardFindings,
	createScanFindings,
	db,
	getBoundPromptForAgent,
	getLastCompletedScanAt,
	getPriorFindingTriageByFingerprint,
	getProjectReposForCodeSearch,
	getProjectScanConfig,
	getProjectScanContent,
	getStoryIdsByIdentifiers,
	type Prisma,
	recordScanActivity,
	type ScanContentItem,
	type ScanKnowledgePack,
	setStoryBlocked,
	updateProjectScan,
	upsertScanCheckpoint,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { describeScanFailureReason } from "../../workflows/scan-failure-hint";
import {
	type RateLimitVerdict,
	runChunksAdaptive,
	verdictFromLimitSignal,
} from "./adaptive-concurrency";
import { emitScanNotification } from "./emit-scan-notification";
import {
	buildScanRequest,
	computeFindingFingerprint,
	isMetaContentFinding,
	mapRawFindingToDraft,
	type ScanFindingDraft,
	type ScanKnowledgePackPrompt,
	type ScanRequest,
	ScanResultSchema,
	type ScanRulePrompt,
	type ScanRunResult,
	type ScanSeverityRubricPrompt,
} from "./scan-schemas";

// =============================================================================
// Chunking + bounded-concurrency helpers (G3)
// =============================================================================

/**
 * Target characters per LLM chunk. The runScan activity packs whole items into
 * a chunk until it would exceed this budget, then starts a new chunk — so item
 * boundaries are always respected and a single oversized item becomes its own
 * chunk. ~28k keeps each call well within the model's context while HALVING the
 * chunk count on a large project: the fixed per-chunk prompt overhead (the
 * security knowledge baseline + scope/format instructions, ~1.7k tokens) is
 * re-sent once per chunk, so fewer chunks means far fewer total tokens pushed at
 * the deployment's per-minute quota.
 */
const CHUNK_TARGET_CHARS = 28_000;

/**
 * AIMD adaptive-concurrency bounds for the AI scanners. A FULL scan at a FIXED
 * 2+ in flight once blew the shared model deployment's tokens-per-minute (TPM)
 * quota — every chunk 429'd and the scan failed with zero findings — so it was
 * pinned to serial. Instead, {@link runChunksAdaptive} self-tunes parallelism to
 * the gateway's REAL limit (additive-increase on clean successes, multiplicative-
 * decrease + Retry-After on a 429), starting modest and degrading back to serial
 * (1) under sustained throttling: fast with headroom, safe without it.
 */
const SCAN_INITIAL_CONCURRENCY = 3;
const SCAN_MAX_CONCURRENCY = 8;

/**
 * Hard per-chunk timeout for a single `generateObject` LLM call. With the SDK's
 * own retry disabled (`maxRetries: 0`) there is no request timeout, so a stalled
 * connection would keep a chunk in flight until the 60-min activity ceiling and
 * discard every already-successful chunk. Aborting the individual call turns it
 * into a normal chunk failure (retried once, then skipped) so the rest still
 * aggregate. A healthy chunk is seconds; 5 min means it is genuinely stuck.
 */
const SCAN_CHUNK_TIMEOUT_MS = 5 * 60_000;

/**
 * Map an AI-call error to the adaptive controller's rate-limit verdict. Reuses
 * the shared {@link classifyLimitError}, which handles 429 / quota / overload
 * detection, deep error-chain traversal, and Retry-After extraction from every
 * header form and location the providers use (including the `.responseHeaders`
 * the AI SDK's `APICallError` carries). The controller needs that hint because
 * the AI SDK itself ignores Retry-After (vercel/ai#7247).
 */
function verdictFromScanError(error: unknown): RateLimitVerdict {
	return verdictFromLimitSignal(classifyLimitError(error));
}

/**
 * Pack discrete items into chunks of ~`targetChars`, respecting item
 * boundaries: an item is never split across chunks, and an item larger than the
 * budget becomes its own (single-item) chunk. Pure + exported for unit testing.
 * Empty/whitespace items are skipped. Each chunk is the items' text joined with
 * a blank line, mirroring the previous single-blob layout the model saw.
 */
export function chunkScanItems(
	items: ScanContentItem[],
	targetChars: number = CHUNK_TARGET_CHARS,
): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = 0;
	const flush = () => {
		if (current.length > 0) {
			chunks.push(current.join("\n\n"));
			current = [];
			currentLen = 0;
		}
	};
	for (const item of items) {
		const text = item.text?.trim() ?? "";
		if (!text) {
			continue;
		}
		// A single item at/over budget is its own chunk (don't split items).
		if (text.length >= targetChars) {
			flush();
			chunks.push(text);
			continue;
		}
		// Starting this item would overflow the current chunk → flush first.
		if (currentLen > 0 && currentLen + text.length > targetChars) {
			flush();
		}
		current.push(text);
		// +2 for the "\n\n" join between items.
		currentLen += text.length + 2;
	}
	flush();
	return chunks;
}

// =============================================================================
// Types
// =============================================================================

export interface GatherScanContextInput {
	projectId: string;
	storyId?: string | null;
	targetType: "PROJECT" | "FEATURE";
	/** FULL re-scans everything; INCREMENTAL only items changed since last scan. */
	mode?: "FULL" | "INCREMENTAL";
}

export interface GatheredScanContext {
	projectName: string;
	/**
	 * Discrete items to scan (project meta + each feature + each document). The
	 * scanner chunks these and runs the chunks in parallel (G3); no single-blob
	 * coverage cap.
	 */
	items: ScanContentItem[];
	itemCount: number;
	/** Items dropped by the high total-items ceiling (0 in the normal case). */
	truncatedItemCount: number;
	/** Identifiers/titles of items included this run (drives carry-forward). */
	scannedItemKeys: string[];
	securityRules: ScanRulePrompt[];
	accessibilityRules: ScanRulePrompt[];
	/** Editable severity rubric (seeded defaults when unset) injected into prompts. */
	severityRubric: ScanSeverityRubricPrompt[];
	/** Optional knowledge packs appended to the security prompt (knowledge only). */
	knowledgePacks: ScanKnowledgePack[];
	/** Whether the Semgrep SAST code scan is enabled for this project. */
	semgrepEnabled: boolean;
	/** Whether the git-history secret scan is enabled for this project. */
	gitHistoryEnabled: boolean;
	/**
	 * Whether the auto-run AI false-positive review is enabled (on by default).
	 * Independent of the four scanners — the review runs over whatever findings
	 * they produced. Best-effort: the scan never fails if the review can't run.
	 */
	autoReviewEnabled: boolean;
}

export interface RunScanInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	projectName: string;
	/** Discrete items to scan — chunked + parallelized inside runScan (G3). */
	items: ScanContentItem[];
	customRules: ScanRulePrompt[];
	/** Severity rubric injected into the prompt (seeded defaults when empty). */
	severityRubric?: ScanSeverityRubricPrompt[];
	/** Knowledge packs appended to the SECURITY prompt only (knowledge text). */
	knowledgePacks?: ScanKnowledgePackPrompt[];
}

export interface PersistScanResultsInput {
	scanId: string;
	projectId: string;
	storyId?: string | null;
	userId: string;
	organizationId?: string | null;
	security: ScanRunResult | null;
	accessibility: ScanRunResult | null;
	/**
	 * Real code-level (Semgrep SAST) security findings. Persisted as additional
	 * SECURITY rows and folded into the security finding count. Optional +
	 * defaulted so existing callers stay backward compatible.
	 */
	codeSecurityFindings?: ScanFindingDraft[];
	/** Secrets found in the repo's git history (gitleaks) — SECURITY rows. */
	gitHistoryFindings?: ScanFindingDraft[];
	/** FULL vs INCREMENTAL — INCREMENTAL carries unchanged findings forward. */
	mode?: "FULL" | "INCREMENTAL";
	/** Items re-scanned this run; carry forward findings on every other item. */
	scannedItemKeys?: string[];
	/**
	 * Repo-relative paths the code scan re-scanned this run (Semgrep DIFF). Passed
	 * SEPARATELY from `scannedItemKeys` so carry-forward drops ONLY superseded
	 * Semgrep findings by exact path — never a git-history secret whose location
	 * embeds a changed file path (gitleaks DIFF can't re-detect a pre-base secret).
	 */
	rescannedCodePaths?: string[];
	/** Which scanners actually ran (for the History "what was scanned" line). */
	scanners?: string[];
	/**
	 * Scanners that were requested but failed/timed out (the run still completes
	 * with whatever else succeeded). Surfaced in the completion summary + History
	 * so a partial scan isn't mistaken for a clean one.
	 */
	failedScanners?: string[];
	/**
	 * Cross-scan carry-forward triage (G2). When a fresh finding's fingerprint
	 * matches a prior finding, carry the prior `firstDetectedAt` + `status` (and,
	 * unless this is a purge re-scan, its `severity`) onto the fresh row so a
	 * recurring finding keeps its triage instead of resurfacing as OPEN.
	 *
	 * `preserveSeverity` defaults true (normal re-scan). A purge re-scan sets it
	 * false: status is still carried (RESOLVED/DISMISSED rows the user kept), but
	 * severity is re-evaluated fresh — the whole point of a purge.
	 */
	preserveSeverity?: boolean;
	/**
	 * Branch-scoped incremental scanning: the commit SHA this run scanned (the
	 * branch's HEAD, resolved before the code scanners). When present AND the scan
	 * row has a concrete branch, a per-branch checkpoint is advanced to this SHA so
	 * the next scan can diff from here. Absent (or blank) ⇒ no checkpoint write.
	 */
	scannedCommitSha?: string | null;
	/**
	 * The code-scan mode this run used. Only a "DIFF" produces meaningful
	 * changed-file / changed-commit counts; on a "FULL" (or first) scan the
	 * checkpoint records null for both so the panel omits the "0 changed files"
	 * scope line instead of showing a misleading zero.
	 */
	codeScanMode?: "FULL" | "DIFF";
	/** Files changed vs the prior checkpoint (Semgrep DIFF) — checkpoint telemetry. */
	changedFileCount?: number | null;
	/** New commits scanned vs the prior checkpoint (gitleaks DIFF) — telemetry. */
	changedCommitCount?: number | null;
}

export interface FailScanInput {
	scanId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	message: string;
}

// =============================================================================
// Activities
// =============================================================================

export async function markScanRunningActivity(input: {
	scanId: string;
}): Promise<void> {
	await updateProjectScan(input.scanId, {
		status: "RUNNING",
		startedAt: new Date(),
	});
}

/**
 * Assemble the Fabric-held content to scan and project the enabled custom rules
 * into the per-category prompt shape.
 */
export async function gatherScanContextActivity(
	input: GatherScanContextInput,
): Promise<GatheredScanContext> {
	heartbeat("gathering scan context");
	// Read config once here — reused below for the rule/rubric/pack projection.
	const config = await getProjectScanConfig(input.projectId);
	// For an incremental project scan, only re-read items changed since the last
	// completed project scan ON THE SAME BRANCH (so a branch's incremental window
	// is measured against its own history); everything else carries forward.
	let sinceCompletedAt: Date | null = null;
	if (input.mode === "INCREMENTAL" && input.targetType === "PROJECT") {
		const configured = config.scanBranch?.trim();
		const branch =
			configured ||
			(await getProjectReposForCodeSearch(input.projectId))[0]?.branch ||
			null;
		sinceCompletedAt = await getLastCompletedScanAt(input.projectId, {
			targetType: "PROJECT",
			branch,
		});
	}
	const content = await getProjectScanContent(input.projectId, {
		storyId: input.storyId,
		targetType: input.targetType,
		mode: input.mode,
		sinceCompletedAt,
	});
	// Coverage telemetry — never silently drop content (no-silent-caps standard).
	logger.info("[SecurityScan] Gathered scan content", {
		projectId: input.projectId,
		targetType: input.targetType,
		mode: input.mode ?? "FULL",
		scannedItems: content.itemCount,
		truncatedItems: content.truncatedItemCount,
	});
	if (content.truncatedItemCount > 0) {
		logger.warn(
			`[SecurityScan] Scanned ${content.itemCount} items; ${content.truncatedItemCount} dropped by the total-items ceiling`,
			{ projectId: input.projectId },
		);
	}
	const enabled = config.customRules.filter((r) => r.enabled);
	const toPrompt = (r: (typeof enabled)[number]): ScanRulePrompt => ({
		name: r.name,
		severity: r.severity,
		guidance: r.guidance,
	});

	return {
		projectName: content.projectName,
		items: content.items,
		itemCount: content.itemCount,
		truncatedItemCount: content.truncatedItemCount,
		scannedItemKeys: content.scannedItemKeys,
		securityRules: enabled
			.filter((r) => r.category === "SECURITY")
			.map(toPrompt),
		accessibilityRules: enabled
			.filter((r) => r.category === "ACCESSIBILITY")
			.map(toPrompt),
		severityRubric: config.severityRubric.map((r) => ({
			severity: r.severity,
			definition: r.definition,
		})),
		knowledgePacks: config.securityKnowledgePacks,
		semgrepEnabled: config.semgrepEnabled,
		gitHistoryEnabled: config.gitHistoryEnabled,
		autoReviewEnabled: config.autoReviewFindings,
	};
}

async function runScan(
	category: "SECURITY" | "ACCESSIBILITY",
	input: RunScanInput,
): Promise<ScanRunResult> {
	const { projectId, userId, organizationId, projectName } = input;

	// Map-reduce over content chunks: pack items into ~14k-char chunks (item
	// boundaries respected; a giant item is its own chunk) and scan them with
	// bounded parallelism — the "multiple parallel scan agents per project".
	const chunks = chunkScanItems(input.items);
	if (chunks.length === 0) {
		// Nothing to scan (empty project / fully-filtered incremental run).
		return {
			findings: [],
			modelName: null,
			inputTokens: 0,
			outputTokens: 0,
		};
	}

	// Load the org/user-overridable reviewer guidance (knowledge baseline +
	// false-positive contract) bound in the prompt-management UI. Falls back to
	// the in-code default inside the prompt builder when nothing is bound. A
	// prompt-binding hiccup must never fail the scan — degrade to the default.
	let reviewerGuidance: string | undefined;
	try {
		const bound = await getBoundPromptForAgent({
			agentName:
				category === "SECURITY"
					? "security_scan_reviewer"
					: "accessibility_scan_reviewer",
			documentType: "GENERAL",
			storyKind: null,
			userId,
			organizationId: organizationId ?? undefined,
		});
		reviewerGuidance = bound?.version?.content ?? undefined;
	} catch (error) {
		logger.warn(
			"[SecurityScan] Failed to load reviewer-guidance prompt binding — using in-code default",
			{
				category,
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		reviewerGuidance = undefined;
	}

	// Split each chunk into a fixed `system` prefix (cacheable across chunks) and
	// the per-chunk `prompt` (just the <document> block). Knowledge packs are
	// appended to the SECURITY guidance only; the accessibility builder ignores
	// them.
	const buildRequest = (content: string): ScanRequest =>
		buildScanRequest(
			category === "SECURITY" ? "security" : "accessibility",
			{
				projectName,
				content,
				customRules: input.customRules,
				severityRubric: input.severityRubric,
				knowledgePacks:
					category === "SECURITY" ? input.knowledgePacks : undefined,
				reviewerGuidance,
			},
		);

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "security-scan",
		},
	);

	logger.info("[SecurityScan] Running scanner", {
		category,
		projectId,
		modelString: metadata.modelString,
		provider: metadata.provider,
		chunks: chunks.length,
		concurrency: Math.min(SCAN_INITIAL_CONCURRENCY, chunks.length),
	});

	// Heartbeat continuously while ANY chunk's LLM call is in flight so a long
	// multi-chunk scan never goes silent past its heartbeat timeout. We also
	// heartbeat between chunks (onSettled) for progress visibility.
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat(`${category} scan: waiting for LLM`);
		} catch {
			/* activity cancelled — finally clears the interval */
		}
	}, 30_000);

	const start = Date.now();
	// Resilient map-reduce: a single chunk's transient LLM failure is retried
	// once then skipped, so the rest of a many-chunk FULL scan still aggregates
	// instead of the whole scan dying with zero findings.
	type ChunkResult = Awaited<
		ReturnType<typeof generateObject<typeof ScanResultSchema>>
	>;
	let chunkResults: Array<ChunkResult | null>;
	let failedChunks: number[];
	// Underlying per-chunk errors, kept so a wholesale failure can tell the user
	// *why* (rate-limited / timed out / unavailable) instead of a bare count.
	const chunkErrors: unknown[] = [];
	try {
		const out = await runChunksAdaptive<string, ChunkResult>(
			chunks,
			(chunk) => {
				const request = buildRequest(chunk);
				return generateObject({
					model,
					schema: ScanResultSchema,
					// Send the fixed guidance (role + OWASP/WCAG list + rubric +
					// knowledge packs + output contract) as a cacheable `system`
					// prefix so it isn't re-billed on every one of a scan's 30-60
					// chunks; only the <document> block in `prompt` varies. The
					// marker is provider-agnostic (see @repo/ai/prompt-cache).
					system: cacheableSystem(request.system),
					prompt: request.prompt,
					temperature: 0,
					maxRetries: 0,
					// Bound a single stalled LLM call so it can't hang the whole
					// scanner to the 60-min ceiling — an aborted call becomes a
					// normal chunk failure (retried once, then skipped).
					abortSignal: AbortSignal.timeout(SCAN_CHUNK_TIMEOUT_MS),
				});
			},
			{
				initialConcurrency: SCAN_INITIAL_CONCURRENCY,
				minConcurrency: 1,
				maxConcurrency: SCAN_MAX_CONCURRENCY,
				classify: verdictFromScanError,
				onSettled: (index) => {
					try {
						heartbeat(
							`${category} scan: completed chunk ${index + 1}/${chunks.length}`,
						);
					} catch {
						/* activity cancelled — finally clears the interval */
					}
				},
				onFail: (index, err) => {
					chunkErrors.push(err);
					logger.warn(
						"[SecurityScan] Scan chunk failed — skipping it",
						{
							category,
							projectId,
							chunk: index + 1,
							total: chunks.length,
							error:
								err instanceof Error
									? err.message
									: String(err),
						},
					);
				},
			},
		);
		chunkResults = out.results;
		failedChunks = out.failed;
		logger.info("[SecurityScan] Adaptive scan complete", {
			category,
			projectId,
			chunks: chunks.length,
			peakConcurrency: out.peakConcurrency,
			finalConcurrency: out.finalConcurrency,
			rateLimitHits: out.rateLimitHits,
		});
	} finally {
		clearInterval(heartbeatInterval);
	}

	// Every chunk failed → fail the scanner honestly. The workflow's allSettled
	// then degrades it to a "didn't finish" note instead of recording a
	// misleading clean (zero-finding) result. Surface the dominant cause so the
	// failure reads as the transient AI-capacity event it almost always is.
	if (failedChunks.length === chunks.length) {
		const hint = describeScanFailureReason(chunkErrors);
		throw new Error(
			`All ${chunks.length} ${category.toLowerCase()} scan chunk(s) failed to complete.${
				hint ? ` ${hint}` : ""
			}`,
		);
	}

	trackUsage();

	// Aggregate findings + token totals across all chunks. Each chunk's usage is
	// logged once so per-call cost/latency stays observable (no unbounded call).
	const latencyMs = Date.now() - start;
	const findings: ScanFindingDraft[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	// Count of findings the model itself flagged as meta-content and we dropped —
	// logged (never a silent cap) so the suppression is observable in telemetry.
	let suppressedMetaCount = 0;
	for (const result of chunkResults) {
		if (!result) {
			continue; // a skipped (failed) chunk — partial coverage, logged above
		}
		inputTokens += result.usage?.inputTokens ?? 0;
		outputTokens += result.usage?.outputTokens ?? 0;
		for (const raw of result.object.findings) {
			// Suppress the self-referential ECHO class at the source: a finding the
			// model itself classified as meta-content (its evidence only describes /
			// tracks / tests an issue, rather than introducing one or exposing an
			// actual sensitive value). Conservative — only an affirmative "describes"
			// basis is dropped; an unknown/missing basis is kept and left to the
			// adversarial judge (the second, grounded gate). This is the model's own
			// semantic call, not a hardcoded title/type rule.
			if (isMetaContentFinding(raw)) {
				suppressedMetaCount += 1;
				continue;
			}
			findings.push(mapRawFindingToDraft(raw, category));
		}
	}
	if (suppressedMetaCount > 0) {
		logger.info(
			`[SecurityScan] Dropped ${suppressedMetaCount} meta-content ${category.toLowerCase()} finding(s) at the finder (describes/tracks/tests — not a real defect)`,
			{ category, projectId, suppressedMetaCount },
		);
	}

	logModelUsageAsync({
		context: { userId, organizationId: organizationId ?? undefined },
		metadata,
		taskType: "COMPLEX",
		usage: {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
		},
		latencyMs,
		agentId: `security-scan:${category.toLowerCase()}`,
		projectId,
	});

	return {
		findings,
		modelName: metadata.modelString ?? null,
		inputTokens,
		outputTokens,
	};
}

export async function runSecurityScanActivity(
	input: RunScanInput,
): Promise<ScanRunResult> {
	return runScan("SECURITY", input);
}

export async function runAccessibilityScanActivity(
	input: RunScanInput,
): Promise<ScanRunResult> {
	return runScan("ACCESSIBILITY", input);
}

/** Pull a feature identifier (F-XXX / B-XXX) out of a finding's location text. */
function extractFeatureIdentifier(location: string | null): string | null {
	if (!location) {
		return null;
	}
	const m = location.match(/\b([FB]-\d+)\b/);
	return m ? m[1] : null;
}

const SEVERITY_RANK: Record<string, number> = {
	CRITICAL: 4,
	HIGH: 3,
	MEDIUM: 2,
	LOW: 1,
};

function toFindingRow(
	scanId: string,
	input: PersistScanResultsInput,
	draft: ScanFindingDraft,
	category: "SECURITY" | "ACCESSIBILITY",
	resolvedStoryId?: string | null,
): Prisma.ScanFindingCreateManyInput {
	// Every finding carries a fingerprint; derive one defensively if a legacy
	// draft (older engine path) didn't set it, so dedup/carry-forward always
	// have a key. Hashes already-redacted fields → never embeds a secret.
	const fingerprint =
		draft.fingerprint ??
		computeFindingFingerprint(category, draft.ruleSource, draft.location);
	return {
		scanId,
		projectId: input.projectId,
		// Feature-scoped scans pin the story; otherwise link the feature the
		// finding is about (resolved from its identifier) for an in-app link.
		storyId: input.storyId ?? resolvedStoryId ?? null,
		category,
		severity: draft.severity,
		title: draft.title,
		description: draft.description,
		remediation: draft.remediation,
		ruleSource: draft.ruleSource,
		isCustomRule: draft.isCustomRule,
		location: draft.location,
		sourceUrl: draft.sourceUrl ?? null,
		// Redacted source excerpt grounding the finding — fed to the FP judge.
		evidence: draft.evidence ?? null,
		// Numeric confidence is safe to persist as-is; default 0.5 when a draft
		// (legacy path) didn't carry one.
		confidence: draft.confidence ?? 0.5,
		fingerprint,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
	};
}

/**
 * INTRA-SCAN dedup (G2): collapse rows that share a fingerprint into one. Now
 * that parallel chunks overlap (the same item can appear in adjacent chunks via
 * a giant-item-own-chunk boundary, and the same global issue can surface in two
 * features), a fingerprint can legitimately repeat within a single scan. Keep
 * the highest severity, the max confidence, and prefer a row that already has a
 * source link / story link (more actionable). Pure + exported for unit testing.
 */
export function dedupeFindingRowsByFingerprint(
	rows: Prisma.ScanFindingCreateManyInput[],
): Prisma.ScanFindingCreateManyInput[] {
	const byFingerprint = new Map<string, Prisma.ScanFindingCreateManyInput>();
	const passthrough: Prisma.ScanFindingCreateManyInput[] = [];
	for (const row of rows) {
		const fp = row.fingerprint;
		if (!fp) {
			// No fingerprint (shouldn't happen — toFindingRow always sets one) →
			// keep as-is rather than collapsing unrelated rows.
			passthrough.push(row);
			continue;
		}
		const existing = byFingerprint.get(fp);
		if (!existing) {
			byFingerprint.set(fp, row);
			continue;
		}
		byFingerprint.set(fp, mergeDuplicateRows(existing, row));
	}
	return [...byFingerprint.values(), ...passthrough];
}

/** Pick the "stronger" of two same-fingerprint rows (see dedupe doc). */
function mergeDuplicateRows(
	a: Prisma.ScanFindingCreateManyInput,
	b: Prisma.ScanFindingCreateManyInput,
): Prisma.ScanFindingCreateManyInput {
	const rankA = SEVERITY_RANK[String(a.severity)] ?? 0;
	const rankB = SEVERITY_RANK[String(b.severity)] ?? 0;
	// Base the surviving row on the higher-severity one; ties prefer the one with
	// a link (sourceUrl/storyId). Then lift confidence to the max of the two.
	const aHasLink = Boolean(a.sourceUrl || a.storyId);
	const bHasLink = Boolean(b.sourceUrl || b.storyId);
	let winner: Prisma.ScanFindingCreateManyInput;
	let loser: Prisma.ScanFindingCreateManyInput;
	if (rankB > rankA || (rankB === rankA && bHasLink && !aHasLink)) {
		winner = b;
		loser = a;
	} else {
		winner = a;
		loser = b;
	}
	const confA = typeof a.confidence === "number" ? a.confidence : 0;
	const confB = typeof b.confidence === "number" ? b.confidence : 0;
	return {
		...winner,
		confidence: Math.max(confA, confB),
		// Backfill a link from the loser if the winner lacks one.
		sourceUrl: winner.sourceUrl ?? loser.sourceUrl ?? null,
		storyId: winner.storyId ?? loser.storyId ?? null,
		// Keep whichever row actually captured a source excerpt.
		evidence: winner.evidence ?? loser.evidence ?? null,
	};
}

/**
 * CROSS-SCAN carry-forward (G2): given the deduped fresh rows and the prior
 * triage map (fingerprint → latest prior finding), stamp each fresh row with
 * carried triage. On a match: carry `firstDetectedAt` + `status`, and — unless
 * this is a purge re-scan (`preserveSeverity=false`) — the prior `severity`, so
 * a recurring finding keeps the triage the user already applied. A genuinely new
 * fingerprint gets `firstDetectedAt = now` and stays OPEN. Pure + unit-tested.
 */
export function applyCarryForwardTriage(
	rows: Prisma.ScanFindingCreateManyInput[],
	prior: Map<
		string,
		{
			status: string;
			severity: string;
			firstDetectedAt: Date | null;
		}
	>,
	opts: { now: Date; preserveSeverity: boolean },
): Prisma.ScanFindingCreateManyInput[] {
	type StatusT = Prisma.ScanFindingCreateManyInput["status"];
	type SeverityT = Prisma.ScanFindingCreateManyInput["severity"];
	return rows.map((row) => {
		const fp = row.fingerprint;
		const match = fp ? prior.get(fp) : undefined;
		if (!match) {
			// Genuinely new finding — record when its fingerprint was first seen.
			return { ...row, firstDetectedAt: opts.now };
		}
		return {
			...row,
			firstDetectedAt: match.firstDetectedAt ?? opts.now,
			// Prior triage values are the Prisma enum's string literals at
			// runtime; cast through to the generated enum type.
			status: match.status as StatusT,
			...(opts.preserveSeverity
				? { severity: match.severity as SeverityT }
				: {}),
		};
	});
}

/**
 * Group findings by the work item they're tied to and build one block reason per
 * story (highest-severity finding's title + a "+N more" count). Pure — unit
 * tested. Findings without a `storyId` are ignored.
 */
export function computeAutoBlockReasons(
	rows: Array<{
		storyId?: string | null;
		severity: string;
		title: string;
	}>,
): Array<{ storyId: string; reason: string }> {
	const byStory = new Map<
		string,
		{ topTitle: string; topRank: number; count: number }
	>();
	for (const r of rows) {
		if (!r.storyId) {
			continue;
		}
		const rank = SEVERITY_RANK[r.severity] ?? 0;
		const existing = byStory.get(r.storyId);
		if (!existing) {
			byStory.set(r.storyId, {
				topTitle: r.title,
				topRank: rank,
				count: 1,
			});
		} else {
			existing.count += 1;
			if (rank > existing.topRank) {
				existing.topRank = rank;
				existing.topTitle = r.title;
			}
		}
	}
	return Array.from(byStory, ([storyId, { topTitle, count }]) => {
		const extra =
			count > 1
				? ` (+${count - 1} more finding${count > 2 ? "s" : ""})`
				: "";
		return {
			storyId,
			reason: `${topTitle}${extra} — auto-blocked by the security & accessibility scan`,
		};
	});
}

/**
 * BLOCK-mode enforcement: block every work item that a finding is tied to, using
 * the finding as the reason. Blocks are idempotent (`skipIfAlreadyBlocked`) so a
 * re-scan never overwrites a manual reason or spams the version history, and a
 * manual block stays put. One failure doesn't abort the others (or the scan).
 */
async function autoBlockTiedStories(
	rows: Prisma.ScanFindingCreateManyInput[],
	input: PersistScanResultsInput,
): Promise<void> {
	const blocks = computeAutoBlockReasons(
		rows.map((r) => ({
			storyId: r.storyId,
			severity: String(r.severity),
			title: r.title,
		})),
	);
	for (const { storyId, reason } of blocks) {
		try {
			await setStoryBlocked(storyId, input.projectId, {
				blocked: true,
				reason,
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				lastEditedSource: "AI_BACKLOG_UPDATE",
				skipIfAlreadyBlocked: true,
			});
		} catch (error) {
			logger.warn("[SecurityScan] Auto-block failed for a work item", {
				projectId: input.projectId,
				storyId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Persist findings, mark the scan COMPLETED with counts + telemetry, and emit
 * the completion notification (including the clean-scan case).
 */
export async function persistScanResultsActivity(
	input: PersistScanResultsInput,
): Promise<{
	securityFindingCount: number;
	accessibilityFindingCount: number;
}> {
	const llmSecurityFindings = input.security?.findings ?? [];
	const codeSecurityFindings = input.codeSecurityFindings ?? [];
	const gitHistoryFindings = input.gitHistoryFindings ?? [];
	const accessibilityFindings = input.accessibility?.findings ?? [];
	// Code (Semgrep) + git-history (gitleaks) findings are SECURITY rows
	// alongside the LLM security findings; the combined set drives the count.
	const securityFindings = [
		...llmSecurityFindings,
		...codeSecurityFindings,
		...gitHistoryFindings,
	];

	// Resolve feature identifiers in LLM finding locations → story ids, so the UI
	// can link a finding to the feature it's about (one batch query).
	const featureIds = Array.from(
		new Set(
			[...securityFindings, ...accessibilityFindings]
				.map((f) => extractFeatureIdentifier(f.location))
				.filter((x): x is string => x !== null),
		),
	);
	const storyIdByIdentifier = await getStoryIdsByIdentifiers(
		input.projectId,
		featureIds,
	);
	const resolveStoryId = (location: string | null): string | null => {
		const id = extractFeatureIdentifier(location);
		return id ? (storyIdByIdentifier[id] ?? null) : null;
	};

	const rawRows: Prisma.ScanFindingCreateManyInput[] = [
		...securityFindings.map((f) =>
			toFindingRow(
				input.scanId,
				input,
				f,
				"SECURITY",
				resolveStoryId(f.location),
			),
		),
		...accessibilityFindings.map((f) =>
			toFindingRow(
				input.scanId,
				input,
				f,
				"ACCESSIBILITY",
				resolveStoryId(f.location),
			),
		),
	];

	// (1) INTRA-SCAN dedup by fingerprint — parallel chunks legitimately overlap,
	// so collapse duplicate findings (keep highest severity / max confidence /
	// prefer a linked row) before anything else uses the set.
	const dedupedRows = dedupeFindingRowsByFingerprint(rawRows);

	// (2) CROSS-SCAN carry-forward triage by fingerprint — a recurring finding
	// keeps the status the user set (and, on a normal re-scan, its severity)
	// instead of resurfacing as a fresh OPEN row. `preserveSeverity` defaults
	// true; a purge re-scan passes false so severity is re-evaluated fresh.
	const preserveSeverity = input.preserveSeverity ?? true;
	const priorTriage = await getPriorFindingTriageByFingerprint(
		input.projectId,
		{
			excludeScanId: input.scanId,
			fingerprints: dedupedRows
				.map((r) => r.fingerprint)
				.filter((f): f is string => typeof f === "string"),
		},
	);
	const rows = applyCarryForwardTriage(dedupedRows, priorTriage, {
		now: new Date(),
		preserveSeverity,
	});

	await createScanFindings(rows);

	// Read the scan row once — its branch scopes incremental carry-forward to
	// the same branch, and its startedAt drives the duration telemetry below.
	let scanRow: { startedAt: Date | null; branch: string | null } | null =
		null;
	try {
		scanRow = await db.projectScan.findUnique({
			where: { id: input.scanId },
			select: { startedAt: true, branch: true },
		});
	} catch {
		/* best-effort — carry-forward + duration degrade gracefully */
	}

	// Enforcement: in BLOCK mode, auto-block every work item a finding is tied to,
	// with the finding as the reason. The block persists until removed manually
	// (an already-blocked item is left untouched — see `skipIfAlreadyBlocked`).
	const config = await getProjectScanConfig(input.projectId);
	if (config.enforcementMode === "BLOCK") {
		await autoBlockTiedStories(rows, input);
	}

	// Incremental scans ALSO carry forward findings on items that weren't
	// re-scanned this run (location-based), so the latest scan stays the complete
	// picture without re-analysing unchanged items. This is orthogonal to the
	// fingerprint carry-forward above (which preserves triage on RE-detected
	// findings); here we copy forward findings that simply weren't looked at.
	let carriedSecurity = 0;
	let carriedAccessibility = 0;
	if (input.mode === "INCREMENTAL") {
		// Dedup carried findings against what this run already persisted: a code
		// scanner that fell back to a FULL scan under an INCREMENTAL run (unreachable
		// base after a squash-merge/force-push, or forceFull) re-produces prior code
		// findings, so carrying them too would double-insert rows + inflate the count.
		// The fresh rows were inserted just above (createScanFindings), so their
		// fingerprints are known here.
		const freshFingerprints = new Set(
			rows
				.map((r) => r.fingerprint)
				.filter(
					(f): f is string => typeof f === "string" && f.length > 0,
				),
		);
		const carried = await carryForwardFindings(
			input.scanId,
			input.projectId,
			{
				storyId: input.storyId,
				targetType: input.storyId ? "FEATURE" : "PROJECT",
				scannedItemKeys: input.scannedItemKeys ?? [],
				rescannedCodePaths: input.rescannedCodePaths ?? [],
				freshFingerprints,
				// Scope carry-forward to the same branch this scan ran against.
				branch: scanRow?.branch ?? null,
			},
		);
		carriedSecurity = carried.security;
		carriedAccessibility = carried.accessibility;
	}

	// Counts span the complete latest-scan set (deduped fresh + carried-forward).
	const freshSecurityCount = rows.filter(
		(r) => r.category === "SECURITY",
	).length;
	const freshAccessibilityCount = rows.length - freshSecurityCount;
	const securityCount = freshSecurityCount + carriedSecurity;
	const accessibilityCount = freshAccessibilityCount + carriedAccessibility;

	// Duration from the run's startedAt (read once above, with the branch).
	const durationMs: number | null = scanRow?.startedAt
		? Date.now() - scanRow.startedAt.getTime()
		: null;

	const inputTokens =
		(input.security?.inputTokens ?? 0) +
		(input.accessibility?.inputTokens ?? 0);
	const outputTokens =
		(input.security?.outputTokens ?? 0) +
		(input.accessibility?.outputTokens ?? 0);
	const modelName =
		input.security?.modelName ?? input.accessibility?.modelName ?? null;
	const costUsd = await estimateScanCostUsd(
		modelName,
		inputTokens,
		outputTokens,
	);

	const completedAt = new Date();
	await updateProjectScan(input.scanId, {
		status: "COMPLETED",
		completedAt,
		securityFindingCount: securityCount,
		accessibilityFindingCount: accessibilityCount,
		modelName,
		inputTokens,
		outputTokens,
		costUsd,
		durationMs,
	});

	// Branch-scoped incremental scanning: advance the per-branch checkpoint to the
	// commit this run scanned, so the next scan can diff from here. Only when we
	// have a concrete SHA AND the scan ran against a concrete branch — a checkpoint
	// is keyed on (project, branch) and never tracks the null "no-repo" case.
	// Best-effort: a checkpoint failure must NEVER fail a scan that already
	// completed and persisted its findings.
	const checkpointBranch = scanRow?.branch?.trim();
	const scannedCommitSha = input.scannedCommitSha?.trim();
	if (scannedCommitSha && checkpointBranch) {
		// Only a DIFF scan produces meaningful diff-scope counts; on a FULL (or
		// first) scan record null for both so the panel omits the scope line instead
		// of showing a misleading "0 changed files · 0 commits".
		const wasDiffScan = input.codeScanMode === "DIFF";
		try {
			await upsertScanCheckpoint({
				projectId: input.projectId,
				branch: checkpointBranch,
				commitSha: scannedCommitSha,
				lastScanId: input.scanId,
				lastScannedAt: completedAt,
				changedFileCount: wasDiffScan
					? (input.changedFileCount ?? null)
					: null,
				changedCommitCount: wasDiffScan
					? (input.changedCommitCount ?? null)
					: null,
				userId: input.userId,
				organizationId: input.organizationId ?? null,
			});
		} catch (error) {
			logger.warn(
				"[SecurityScan] Failed to advance the branch scan checkpoint",
				{
					projectId: input.projectId,
					scanId: input.scanId,
					branch: checkpointBranch,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	await emitScanNotification({
		scanId: input.scanId,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		securityFindingCount: securityCount,
		accessibilityFindingCount: accessibilityCount,
	});

	const total = securityCount + accessibilityCount;
	const degraded =
		input.failedScanners && input.failedScanners.length > 0
			? input.failedScanners
			: null;
	// Note appended to the completion summary when some scanners didn't finish,
	// so a partial scan reads honestly instead of as a clean result.
	const degradedNote = degraded
		? ` — ${degraded.join(", ")} didn't finish`
		: "";
	await recordScanActivity({
		projectId: input.projectId,
		type: "SCAN_COMPLETED",
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		scanId: input.scanId,
		summary:
			total === 0
				? `Scan completed — no issues found${degradedNote}`
				: `Scan completed — ${total} finding${total === 1 ? "" : "s"} (${securityCount} security, ${accessibilityCount} accessibility)${degradedNote}`,
		// Telemetry surfaced on the scan row in the History dialog (Atlas-style).
		metadata: {
			securityFindingCount: securityCount,
			accessibilityFindingCount: accessibilityCount,
			mode: input.mode ?? "FULL",
			inputTokens,
			outputTokens,
			...(durationMs != null ? { durationMs } : {}),
			...(costUsd != null ? { costUsd } : {}),
			...(modelName ? { modelName } : {}),
			...(input.scanners && input.scanners.length > 0
				? { scanners: input.scanners }
				: {}),
			...(degraded ? { failedScanners: degraded } : {}),
			// Which branch this run scanned — surfaced in the History dialog.
			...(scanRow?.branch ? { branch: scanRow.branch } : {}),
		},
	}).catch(() => {});

	return {
		securityFindingCount: securityCount,
		accessibilityFindingCount: accessibilityCount,
	};
}

/**
 * Best-effort USD cost for a scan from the AiModel pricing catalog
 * (inputCostPer1M / outputCostPer1M). Returns null when the model isn't found
 * or has no pricing — the History view then shows tokens without a dollar value.
 */
async function estimateScanCostUsd(
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

export async function failScanActivity(input: FailScanInput): Promise<void> {
	// Record the failure server-side with enough detail to diagnose without a
	// user repro (AC3) — this line lands in Application Insights / Log Analytics.
	// Logged first so the failure is captured even if the DB write below throws.
	logger.error("[SecurityScan] Scan failed", {
		scanId: input.scanId,
		projectId: input.projectId,
		organizationId: input.organizationId ?? null,
		error: input.message,
	});
	await updateProjectScan(input.scanId, {
		status: "FAILED",
		completedAt: new Date(),
		error: input.message.slice(0, 1000),
	});
	await emitScanNotification({
		scanId: input.scanId,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		securityFindingCount: 0,
		accessibilityFindingCount: 0,
		failed: true,
		errorMessage: input.message,
	});

	await recordScanActivity({
		projectId: input.projectId,
		type: "SCAN_FAILED",
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		scanId: input.scanId,
		summary: "Scan failed",
	}).catch(() => {});
}
