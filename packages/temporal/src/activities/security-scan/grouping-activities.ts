/**
 * Security & Accessibility finding-grouping — PROPOSE-phase activities.
 *
 * The grouping run now PROPOSES tickets for human review instead of writing
 * them during the run. This module drafts one proposal per theme and persists
 * them onto the run's `results` JSON at status `AWAITING_REVIEW`. The actual
 * writes (create story, post the incremental comment, tag, PM-sync) happen
 * later in the `scan.grouping.apply` procedure once the user accepts — see
 * `packages/api/.../scan/apply-grouping.ts`.
 *
 * Pipeline (orchestrated by `securityFindingGroupingWorkflow`):
 *   markGroupingRunning
 *   → gatherEligibleFindings   (group by (category, ruleSource); split a large
 *                               theme by severity; flag themes the user has
 *                               durably declined)
 *   → proposeTheme  (per theme, bounded concurrency at the WORKFLOW level) —
 *                    drafts the ticket body via the `security_finding_ticket`
 *                    prompt + a deterministic findings tail, generates the
 *                    title via the shared `story_title_generator`, and decides
 *                    the action (create / update / skip / declined) WITHOUT any
 *                    writes
 *   → persistGroupingProposals (AWAITING_REVIEW)
 *   (failGrouping on any uncaught throw)
 *
 * No access toggle: the feature is always available (gated only by the manual
 * trigger + the review step). The severity-split, title, and body drafting are
 * the only LLM-touching work; the theme grouping and the deterministic tail are
 * fully code-owned (ADR-007 "deterministic clustering + AI-narrative-only").
 */

import {
	generateStoryTitleFromDescription,
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import {
	db,
	type FindingForGrouping,
	findOpenStoryByThemeTag,
	type GroupingFailedTheme,
	type GroupingProposalCreate,
	type GroupingProposalUpdate,
	type GroupingRunResults,
	type GroupingSkippedTheme,
	getBoundPromptForAgent,
	getDeclinedGroupingThemes,
	getEligibleFindingsForGrouping,
	getLastKnownFingerprints,
	getLatestProjectScan,
	updateScanFindingGrouping,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import {
	buildDeterministicTail,
	buildNewFindingsSummary,
	categoryLabel,
	type GroupingCategory,
	type GroupingFindingInput,
	maxSeverityToPriority,
	type ScanSeverityValue,
} from "./grouping-schemas";
import { themeTagValue } from "./grouping-tags";

// Re-export the DB-layer proposal/outcome types so the workflow imports them
// from this activities module (matching the established convention of workflows
// depending on ../activities/* rather than reaching into @repo/database).
export type {
	GroupingFailedTheme,
	GroupingProposalCreate,
	GroupingProposalUpdate,
	GroupingSkippedTheme,
} from "@repo/database";

// =============================================================================
// Tunables
// =============================================================================

/**
 * Soft safety valve — a realistic project has tens, not thousands, of distinct
 * themes. Themes beyond this cap are recorded as `failed`/`theme_limit_exceeded`
 * rather than silently dropped. Severity-split sub-themes each count toward the
 * cap.
 */
export const MAX_THEMES_PER_GROUPING_RUN = 50;

/**
 * Cap on how many findings are inlined verbatim into the drafting prompt for a
 * single theme. Bounds prompt size + latency; the ticket BODY still lists 100%
 * of the theme's findings via `buildDeterministicTail` (this caps the model
 * INPUT only).
 */
export const MAX_FINDINGS_IN_DRAFT_PROMPT = 60;

/**
 * Split a theme into per-severity sub-tickets once it exceeds this many
 * findings (distribution — a 119-finding catch-all rule shouldn't become one
 * overwhelming ticket). Each severity slice becomes its own proposal with a
 * stable `themeTagValue(category, ruleSource, severity)` identity so reruns
 * still dedupe. Below the threshold a theme stays whole (one ticket).
 */
export const THEME_SPLIT_THRESHOLD = 25;

// =============================================================================
// Shared helpers
// =============================================================================

function notNull<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Project a scan finding into the minimal shape the body helpers read. */
function toFindingInput(f: FindingForGrouping): GroupingFindingInput {
	return {
		title: f.title,
		severity: f.severity as ScanSeverityValue,
		description: f.description,
		location: f.location,
		confidence: f.confidence,
	};
}

// =============================================================================
// markGroupingRunningActivity / failGroupingActivity
// =============================================================================

export interface MarkGroupingRunningInput {
	groupingId: string;
}

/** PENDING -> RUNNING. */
export async function markGroupingRunningActivity(
	input: MarkGroupingRunningInput,
): Promise<void> {
	await updateScanFindingGrouping(input.groupingId, {
		status: "RUNNING",
		startedAt: new Date(),
	});
}

export interface FailGroupingInput {
	groupingId: string;
	message: string;
}

/** Writes FAILED + error + completedAt. Called from the workflow's catch block. */
export async function failGroupingActivity(
	input: FailGroupingInput,
): Promise<void> {
	await updateScanFindingGrouping(input.groupingId, {
		status: "FAILED",
		completedAt: new Date(),
		error: input.message.slice(0, 1000),
	});
}

// =============================================================================
// gatherEligibleFindingsActivity
// =============================================================================

export interface GatherEligibleFindingsInput {
	projectId: string;
}

/**
 * One theme to propose. `severity` is non-null only for a severity-split slice
 * of a large theme; `declined` marks a theme the user durably declined (still
 * drafted, but surfaced under "declined" with a Re-add action, never proposed
 * as a fresh create).
 */
export interface GroupingTheme {
	category: GroupingCategory;
	ruleSource: string;
	severity: ScanSeverityValue | null;
	themeKey: string;
	declined: boolean;
	findings: FindingForGrouping[];
}

export interface GatherEligibleFindingsOutput {
	themes: GroupingTheme[];
	/** Themes past the cap — recorded straight as failed, never processed. */
	overflowThemes: GroupingFailedTheme[];
	scanId: string | null;
	scanCompletedAt: string | null;
	findingCount: number;
}

const SEVERITY_SLICE_ORDER: readonly ScanSeverityValue[] = [
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
];

/**
 * Resolve the project's latest COMPLETED scan's OPEN findings, group them by
 * `(category, ruleSource)`, split any theme over `THEME_SPLIT_THRESHOLD` into
 * per-severity slices, and flag themes the user has declined. Reads the declined
 * set once here (rather than per-theme) so the workflow can fan out cheaply.
 *
 * A `null` scan and a resolved-but-zero-findings scan are handled identically
 * (both return zero themes) — a fresh, never-scanned project must not fail.
 */
export async function gatherEligibleFindingsActivity(
	input: GatherEligibleFindingsInput,
): Promise<GatherEligibleFindingsOutput> {
	heartbeat("gathering eligible findings");
	const { projectId } = input;

	const [scan, findings, declined] = await Promise.all([
		getLatestProjectScan(projectId, { status: "COMPLETED" }),
		getEligibleFindingsForGrouping(projectId),
		getDeclinedGroupingThemes(projectId),
	]);

	const scanId = scan?.id ?? null;
	const scanCompletedAt = scan?.completedAt?.toISOString() ?? null;

	if (findings.length === 0) {
		return {
			themes: [],
			overflowThemes: [],
			scanId,
			scanCompletedAt,
			findingCount: 0,
		};
	}

	const declinedKeys = new Set(declined.map((d) => d.themeKey));

	// Group by (category, ruleSource).
	const grouped = new Map<string, FindingForGrouping[]>();
	for (const finding of findings) {
		const key = `${finding.category} ${finding.ruleSource}`;
		const bucket = grouped.get(key);
		if (bucket) {
			bucket.push(finding);
		} else {
			grouped.set(key, [finding]);
		}
	}

	// Build themes, splitting large ones by severity.
	const allThemes: GroupingTheme[] = [];
	for (const bucket of grouped.values()) {
		const first = bucket[0];
		if (!first) {
			continue;
		}
		const category = first.category as GroupingCategory;
		const ruleSource = first.ruleSource;

		if (bucket.length > THEME_SPLIT_THRESHOLD) {
			const bySeverity = new Map<
				ScanSeverityValue,
				FindingForGrouping[]
			>();
			for (const finding of bucket) {
				const sev = finding.severity as ScanSeverityValue;
				const slice = bySeverity.get(sev);
				if (slice) {
					slice.push(finding);
				} else {
					bySeverity.set(sev, [finding]);
				}
			}
			for (const severity of SEVERITY_SLICE_ORDER) {
				const slice = bySeverity.get(severity);
				if (!slice || slice.length === 0) {
					continue;
				}
				const themeKey = themeTagValue(category, ruleSource, severity);
				allThemes.push({
					category,
					ruleSource,
					severity,
					themeKey,
					declined: declinedKeys.has(themeKey),
					findings: slice,
				});
			}
		} else {
			const themeKey = themeTagValue(category, ruleSource);
			allThemes.push({
				category,
				ruleSource,
				severity: null,
				themeKey,
				declined: declinedKeys.has(themeKey),
				findings: bucket,
			});
		}
	}

	const themes = allThemes.slice(0, MAX_THEMES_PER_GROUPING_RUN);
	const overflowThemes: GroupingFailedTheme[] = allThemes
		.slice(MAX_THEMES_PER_GROUPING_RUN)
		.map((theme) => ({
			category: theme.category,
			ruleSource: theme.ruleSource,
			themeKey: theme.themeKey,
			findingCount: theme.findings.length,
			reason: "theme_limit_exceeded",
		}));

	return {
		themes,
		overflowThemes,
		scanId,
		scanCompletedAt,
		findingCount: findings.length,
	};
}

// =============================================================================
// proposeThemeActivity — the core (drafts + decides, NO writes)
// =============================================================================

export interface ProposeThemeInput {
	theme: GroupingTheme;
	projectId: string;
	userId: string;
	organizationId: string | null;
	scanCompletedAt: string | null;
}

interface ProposeThemeTelemetry {
	modelName: string | null;
	inputTokens: number;
	outputTokens: number;
}

const EMPTY_TELEMETRY: ProposeThemeTelemetry = {
	modelName: null,
	inputTokens: 0,
	outputTokens: 0,
};

export type ProposeThemeOutcome =
	| ({
			outcome: "create";
			proposal: GroupingProposalCreate;
	  } & ProposeThemeTelemetry)
	| ({
			outcome: "declined";
			proposal: GroupingProposalCreate;
	  } & ProposeThemeTelemetry)
	| { outcome: "update"; proposal: GroupingProposalUpdate }
	| { outcome: "skip"; skipped: GroupingSkippedTheme }
	| { outcome: "failed"; failed: GroupingFailedTheme };

/**
 * Propose one theme. A declined theme is still drafted (so Re-add can create it
 * verbatim later) but returned as `declined`. Otherwise: an existing open
 * ticket with genuinely new findings -> `update` (an incremental comment,
 * drafted but not posted); an existing ticket with nothing new -> `skip`;
 * no ticket -> `create`. Never throws for an AI hiccup — the body degrades to
 * a deterministic fallback.
 */
export async function proposeThemeActivity(
	input: ProposeThemeInput,
): Promise<ProposeThemeOutcome> {
	const { theme, projectId } = input;

	// The declined path skips the existing-ticket lookup: a declined theme is
	// surfaced for Re-add regardless of whether a stale ticket exists.
	if (!theme.declined) {
		const existing = await findOpenStoryByThemeTag(
			projectId,
			theme.themeKey,
		);
		if (existing) {
			return proposeUpdate(input, existing);
		}
	}

	return proposeCreate(input);
}

async function proposeUpdate(
	input: ProposeThemeInput,
	existing: { id: string; identifier: string },
): Promise<ProposeThemeOutcome> {
	const { theme, projectId } = input;
	const findingCount = theme.findings.length;

	const lastKnownArr = await getLastKnownFingerprints(projectId, existing.id);
	const lastKnown = new Set(lastKnownArr);

	// A finding with no fingerprint (legacy row) can never be matched by
	// identity, so it MUST be treated as always-new (never silently omitted).
	const newFindings = theme.findings.filter(
		(f) => !f.fingerprint || !lastKnown.has(f.fingerprint),
	);

	if (newFindings.length === 0) {
		return {
			outcome: "skip",
			skipped: {
				category: theme.category,
				ruleSource: theme.ruleSource,
				themeKey: theme.themeKey,
				findingCount,
				storyId: existing.id,
				storyIdentifier: existing.identifier,
				reason: "no_new_findings",
			},
		};
	}

	const newFingerprints = newFindings
		.map((f) => f.fingerprint)
		.filter(notNull);
	const cumulativeFingerprints = [...lastKnownArr, ...newFingerprints];

	return {
		outcome: "update",
		proposal: {
			category: theme.category,
			ruleSource: theme.ruleSource,
			themeKey: theme.themeKey,
			findingCount,
			storyId: existing.id,
			storyIdentifier: existing.identifier,
			newFindingCount: newFindings.length,
			commentBody: buildNewFindingsSummary(
				newFindings.map(toFindingInput),
			),
			newFingerprints,
			cumulativeFingerprints,
		},
	};
}

async function proposeCreate(
	input: ProposeThemeInput,
): Promise<ProposeThemeOutcome> {
	const { theme, projectId, userId, organizationId, scanCompletedAt } = input;
	const findingInputs = theme.findings.map(toFindingInput);

	heartbeat(`drafting proposal for theme ${theme.themeKey}`);
	const { narrative, telemetry } = await draftNarrative(theme, {
		userId,
		organizationId,
		projectId,
	});

	const tail = buildDeterministicTail({
		category: theme.category,
		ruleSource: theme.ruleSource,
		findings: findingInputs,
		scanCompletedAt,
	});
	const body = `${narrative}\n\n${tail}`;
	const priority = maxSeverityToPriority(findingInputs);

	const rawTitle = await generateThemeTitle(body, theme, {
		userId,
		organizationId,
	});
	const title = `[${categoryLabel(theme.category)}] ${rawTitle}`;

	const fingerprints = theme.findings
		.map((f) => f.fingerprint)
		.filter(notNull);

	const proposal: GroupingProposalCreate = {
		category: theme.category,
		ruleSource: theme.ruleSource,
		themeKey: theme.themeKey,
		findingCount: theme.findings.length,
		severity: theme.severity,
		title,
		body,
		priority,
		fingerprints,
	};

	return theme.declined
		? { outcome: "declined", proposal, ...telemetry }
		: { outcome: "create", proposal, ...telemetry };
}

// =============================================================================
// Drafting — dedicated prompt for the body, shared prompt for the title
// =============================================================================

function fallbackNarrative(theme: GroupingTheme): string {
	const label = categoryLabel(theme.category).toLowerCase();
	return [
		"## Summary",
		`This ticket groups ${theme.findings.length} ${label} finding(s) reported under "${theme.ruleSource}". Review the findings listed below and address them together.`,
		"## Suggested remediation",
		"Apply the remediation guidance specific to each finding below; where possible add a lint rule, CI gate, pre-commit hook, or secret rotation to prevent recurrence.",
	].join("\n\n");
}

/** The findings context handed to the drafting model as the user message. */
export function buildFindingsContext(theme: GroupingTheme): string {
	const total = theme.findings.length;
	const shown = theme.findings.slice(0, MAX_FINDINGS_IN_DRAFT_PROMPT);
	const counts: Record<ScanSeverityValue, number> = {
		CRITICAL: 0,
		HIGH: 0,
		MEDIUM: 0,
		LOW: 0,
	};
	for (const finding of theme.findings) {
		counts[finding.severity as ScanSeverityValue] += 1;
	}
	const breakdown = `Critical ${counts.CRITICAL}, High ${counts.HIGH}, Medium ${counts.MEDIUM}, Low ${counts.LOW}`;
	const findingsBlock = shown
		.map((finding, index) => {
			const location = finding.location
				? ` (Location: ${finding.location})`
				: "";
			return `${index + 1}. [${finding.severity}] ${finding.title}${location}\n   ${finding.description}`;
		})
		.join("\n\n");
	const omitted = total - shown.length;
	const overflowNote =
		omitted > 0
			? `\n\n(+${omitted} more finding(s) under the same rule, omitted for brevity — the same class of issue.)`
			: "";

	return `category: ${theme.category}\nrule: ${theme.ruleSource}\nfindingCount: ${total}\nseverityBreakdown: ${breakdown}\n\n<findings>\n${findingsBlock}${overflowNote}\n</findings>`;
}

async function draftNarrative(
	theme: GroupingTheme,
	context: {
		userId: string;
		organizationId: string | null;
		projectId: string;
	},
): Promise<{ narrative: string; telemetry: ProposeThemeTelemetry }> {
	try {
		const bound = await getBoundPromptForAgent({
			agentName: "security_finding_ticket",
			documentType: "DRAFT",
			storyKind: "BUG",
			userId: context.userId,
			organizationId: context.organizationId ?? undefined,
		});
		const systemPrompt = bound?.version?.content;
		if (!systemPrompt) {
			logger.info(
				"[SecurityFindingGrouping] security_finding_ticket prompt not bound — using deterministic fallback narrative",
			);
			return {
				narrative: fallbackNarrative(theme),
				telemetry: EMPTY_TELEMETRY,
			};
		}

		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: context.userId,
				organizationId: context.organizationId ?? undefined,
				projectId: context.projectId,
				jobType: "security-scan",
			},
		);

		const start = Date.now();
		const result = await generateText({
			model,
			system: systemPrompt,
			prompt: buildFindingsContext(theme),
			temperature: 0.3,
		});

		trackUsage();
		const inputTokens = result.usage?.inputTokens ?? 0;
		const outputTokens = result.usage?.outputTokens ?? 0;
		logModelUsageAsync({
			context: {
				userId: context.userId,
				organizationId: context.organizationId ?? undefined,
			},
			metadata,
			taskType: "COMPLEX",
			usage: {
				inputTokens,
				outputTokens,
				totalTokens: inputTokens + outputTokens,
			},
			latencyMs: Date.now() - start,
			agentId: "security-scan:finding-grouping",
			projectId: context.projectId,
		});

		const narrative = result.text?.trim() || fallbackNarrative(theme);
		return {
			narrative,
			telemetry: {
				modelName: metadata.modelString ?? null,
				inputTokens,
				outputTokens,
			},
		};
	} catch (error) {
		logger.warn(
			"[SecurityFindingGrouping] Ticket body drafting failed — falling back to deterministic narrative",
			{
				category: theme.category,
				ruleSource: theme.ruleSource,
				error: errorMessage(error),
			},
		);
		return {
			narrative: fallbackNarrative(theme),
			telemetry: EMPTY_TELEMETRY,
		};
	}
}

/**
 * The shared title generator occasionally emits a literal "Untitled" (its
 * insufficient-context sentinel, sometimes with a " – <timestamp>" suffix).
 * Treat any such value as "no usable title".
 */
function isUntitled(value: string): boolean {
	return /^untitled\b/i.test(value.trim());
}

/**
 * Deterministic rule-based title used whenever the generated one is unusable.
 * The caller prepends the `[Security]/[Accessibility]` label, so this must never
 * be empty or "Untitled" — fall back to a generic label when even the rule is
 * blank.
 */
function fallbackTitle(theme: GroupingTheme): string {
	const severitySuffix = theme.severity
		? ` — ${theme.severity.charAt(0)}${theme.severity.slice(1).toLowerCase()}`
		: "";
	const rule = theme.ruleSource?.trim();
	const base = rule && !isUntitled(rule) ? rule : "Other findings";
	return `${base}${severitySuffix}`;
}

/**
 * Choose the ticket title: use the generated one unless it's empty, flagged
 * insufficient, or a literal "Untitled" — otherwise fall back to a deterministic
 * rule-based title so a ticket is never headlined "Untitled". Pure + exported
 * for unit testing.
 */
export function chooseThemeTitle(
	generated: string | null | undefined,
	isInsufficient: boolean,
	theme: GroupingTheme,
): string {
	const title = generated?.trim();
	if (title && !isInsufficient && !isUntitled(title)) {
		return title;
	}
	return fallbackTitle(theme);
}

/** Title via the shared `story_title_generator`; `[Security]/[Accessibility]` is prefixed by the caller. */
async function generateThemeTitle(
	body: string,
	theme: GroupingTheme,
	context: { userId: string; organizationId: string | null },
): Promise<string> {
	try {
		const result = await generateStoryTitleFromDescription(body, "BUG", {
			userId: context.userId,
			organizationId: context.organizationId ?? undefined,
		});
		return chooseThemeTitle(
			result.title,
			result.isInsufficient ?? false,
			theme,
		);
	} catch (error) {
		logger.warn(
			"[SecurityFindingGrouping] Title generation failed — using rule-based fallback",
			{ ruleSource: theme.ruleSource, error: errorMessage(error) },
		);
		return fallbackTitle(theme);
	}
}

// =============================================================================
// persistGroupingProposalsActivity — persist proposals + AWAITING_REVIEW
// =============================================================================

export interface PersistGroupingProposalsInput {
	groupingId: string;
	proposedCreate: GroupingProposalCreate[];
	proposedUpdate: GroupingProposalUpdate[];
	declinedThemes: GroupingProposalCreate[];
	skippedThemes: GroupingSkippedTheme[];
	failedThemes: GroupingFailedTheme[];
	themeCount: number;
	findingCount: number;
	modelName: string | null;
	inputTokens: number;
	outputTokens: number;
}

export interface PersistGroupingProposalsOutput {
	proposedCreateCount: number;
	proposedUpdateCount: number;
	declinedCount: number;
	skippedCount: number;
	failedCount: number;
}

async function estimateGroupingCostUsd(
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

/**
 * Persist the run's proposals and flip it to `AWAITING_REVIEW`. Drafting
 * telemetry (tokens/cost/duration) is recorded now — the apply phase does no
 * LLM work. Applied counts (`createdCount`/`updatedCount`) stay 0 until apply.
 */
export async function persistGroupingProposalsActivity(
	input: PersistGroupingProposalsInput,
): Promise<PersistGroupingProposalsOutput> {
	const {
		groupingId,
		proposedCreate,
		proposedUpdate,
		declinedThemes,
		skippedThemes,
		failedThemes,
		themeCount,
		findingCount,
		modelName,
		inputTokens,
		outputTokens,
	} = input;

	let durationMs: number | null = null;
	try {
		const grouping = await db.scanFindingGrouping.findUnique({
			where: { id: groupingId },
			select: { startedAt: true },
		});
		if (grouping?.startedAt) {
			durationMs = Date.now() - grouping.startedAt.getTime();
		}
	} catch {
		/* telemetry only */
	}

	const costUsd = await estimateGroupingCostUsd(
		modelName,
		inputTokens,
		outputTokens,
	);

	const results: GroupingRunResults = {
		proposedCreate,
		proposedUpdate,
		declinedThemes,
		skippedThemes,
		failedThemes,
	};

	await updateScanFindingGrouping(groupingId, {
		status: "AWAITING_REVIEW",
		results,
		// Applied counts remain 0 until apply; these summarize what was scanned.
		skippedCount: skippedThemes.length,
		failedCount: failedThemes.length,
		themeCount,
		findingCount,
		modelName,
		inputTokens,
		outputTokens,
		costUsd,
		durationMs,
	});

	return {
		proposedCreateCount: proposedCreate.length,
		proposedUpdateCount: proposedUpdate.length,
		declinedCount: declinedThemes.length,
		skippedCount: skippedThemes.length,
		failedCount: failedThemes.length,
	};
}
