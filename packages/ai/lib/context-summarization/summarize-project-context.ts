/**
 * LLM helper for map-reduce compression of a project's raw context into a
 * compact, structured, source-referenced digest.
 *
 * The engine (Temporal workflow + `generateSummaryActivity`) walks ALL eligible
 * raw context chronologically through bounded batches and calls `foldContextBatch`
 * once per batch: the previous running digest plus this batch's raw sources are
 * folded into an updated digest. This function is STATELESS — the activity owns
 * the loop, the keyset cursor, marker assignment, and checkpointing.
 *
 * Design choices that matter:
 *  - Per-call input is bounded (a batch is capped in chars), but total coverage is
 *    NOT — the caller iterates over as many batches as the project requires. No
 *    project-level truncation.
 *  - Sources carry stable citation markers (`S1`, `S2`, …) assigned by the caller.
 *    The model may cite ONLY markers it is given; any invented marker is stripped
 *    post-generation (`sanitizeCitations`), so a hallucinated reference can never
 *    survive into the stored summary.
 *  - The output schema is deliberately LENIENT — every section is an optional
 *    string; empty sections are dropped when the markdown is assembled.
 *  - The output is BOUNDED regardless of input size (hard char cap) so retrieval
 *    always reads a compact digest and the running digest stays small across many
 *    folds.
 *  - Prompt caching is applied to the fixed system guidance so the unchanging
 *    prefix isn't re-billed across the daily fan-out of per-project summaries.
 */

import {
	type ContextSourceReference,
	estimateAiUsageCostUsd,
} from "@repo/database";
import { generateObject } from "ai";
import { z } from "zod";
import { getAIModelWithMetadata } from "../dynamic-model-selector";
import { cacheableSystem } from "../prompt-cache";

/** A raw context source fed to one fold, with its pre-assigned citation marker. */
export interface FoldBatchSource {
	marker: string;
	type: string;
	/** ISO 8601 — the source row's createdAt. */
	timestamp: string;
	label: string | null;
	content: string;
}

/** An ACCEPTED architecture decision fed to the first fold, with its marker. */
export interface FoldBatchDecision {
	marker: string;
	title: string;
	decision: string;
	rationale: string;
}

/** A roadmap item (Feature/Epic/Bug) fed to the first fold — high-level only. */
export interface FoldBatchRoadmapItem {
	marker: string;
	title: string;
	/** Epic / Feature / Bug / … (the item's kind). */
	kind: string;
	/** Human status name (e.g. "In Progress", "Done"). */
	status: string;
	priority?: string;
}

/** A connected code repository (+ optional high-level analysis) for the first fold. */
export interface FoldBatchCodeRepo {
	marker: string;
	/** Repo full name / label (e.g. "Fabric-Pro/fabric"). */
	label: string;
	url?: string;
	provider?: string;
	branch?: string;
	language?: string;
	/** A high-level codebase analysis digest, if one exists (NOT raw code). */
	analysis?: string;
}

export interface FoldContextBatchInput {
	projectName: string;
	/** The project id — attributes AI usage to the project's Usage tab. */
	projectId?: string;
	/** Project XOR tenancy — drives model + provider resolution. */
	tenancy: { userId: string | null; organizationId: string | null };
	/**
	 * System guidance for the fold. When omitted, the built-in `SYSTEM_GUIDANCE`
	 * is used. The activity resolves the admin-editable DB prompt and passes it in.
	 */
	systemPrompt?: string;
	/** Running digest so far (carries prior markers). Null on the first batch. */
	runningSummary: string | null;
	/** New raw sources for this batch (markers pre-assigned by the caller). */
	batchSources: FoldBatchSource[];
	/** References already cited in `runningSummary` (legend only, no content). */
	carriedReferences: ContextSourceReference[];
	/**
	 * NEW decisions / roadmap items / code repos to fold in (ones already cited in
	 * `runningSummary` are omitted upstream to avoid double markers). These are
	 * project-level, non-time-windowed sources folded on the run's LAST fold.
	 */
	decisions: FoldBatchDecision[];
	roadmapItems: FoldBatchRoadmapItem[];
	codeRepos: FoldBatchCodeRepo[];
	/**
	 * Render the decisions/roadmap/repo blocks in this fold. The caller sets it on
	 * the run's LAST fold (not the first): folded early, their citations would be
	 * pruned away by every later fold; folded last, they survive into the digest.
	 */
	includeProjectSources: boolean;
}

/** Real tokens + cost consumed by one fold call (from the model's usage report). */
export interface FoldUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** Estimated cost of this fold in micro-USD (0 when pricing is unknown). */
	costMicroUsd: number;
}

export interface FoldContextBatchResult {
	content: string;
	/** Markers (from the allowed set) that survived into the digest. */
	citedMarkers: string[];
	model: string;
	/** Tokens this fold consumed, so the activity can sum true per-run spend. */
	usage: FoldUsage;
}

/**
 * The compression is a faithful, structured digest of heterogeneous project
 * history — the same shape of task the daily-brief digest runs on, so it uses
 * the same COMPLEX tier. SIMPLE risks silently dropping decisions/constraints,
 * which would defeat the whole point of the summary.
 */
const SUMMARIZATION_TASK_TYPE = "COMPLEX" as const;

/**
 * Prompt budgets. Per-call input is bounded so a single fold can't send unbounded
 * tokens; total coverage is unbounded across folds. The assembled digest is
 * bounded so retrieval always reads a compact summary and the running digest
 * stays small across an arbitrary number of folds.
 */
const BATCH_INPUT_CHAR_CAP = 200_000;
const PER_SOURCE_CHAR_CAP = 60_000;
const DECISION_FIELD_CHAR_CAP = 800;
const RUNNING_SUMMARY_CHAR_CAP = 18_000;
const SUMMARY_CHAR_CAP = 18_000;
const CARRIED_LEGEND_CAP = 200;
/** Roadmap is folded HIGH-LEVEL — a bounded, prioritized slice, not every item. */
const ROADMAP_ITEM_CAP = 120;
const CODE_ANALYSIS_CHAR_CAP = 8_000;

/** Keep the head of `text`, capped at `maxChars`, with a truncation marker. */
function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n[… truncated …]`;
}

/**
 * Lenient model-output schema. Each section is an optional free string —
 * empty/missing sections are dropped when the markdown is assembled below.
 */
const SummarySchema = z
	.object({
		goalsAndScope: z.string().default(""),
		keyDecisions: z.string().default(""),
		technicalContext: z.string().default(""),
		constraintsAndNonGoals: z.string().default(""),
		historyTimeline: z.string().default(""),
		openItems: z.string().default(""),
	})
	.default({
		goalsAndScope: "",
		keyDecisions: "",
		technicalContext: "",
		constraintsAndNonGoals: "",
		historyTimeline: "",
		openItems: "",
	});

const SECTIONS: Array<{
	key: keyof z.infer<typeof SummarySchema>;
	heading: string;
}> = [
	{ key: "goalsAndScope", heading: "Goals & scope" },
	{ key: "keyDecisions", heading: "Key decisions" },
	{ key: "technicalContext", heading: "Technical context / stack" },
	{ key: "constraintsAndNonGoals", heading: "Constraints & non-goals" },
	{ key: "historyTimeline", heading: "History / timeline" },
	{ key: "openItems", heading: "Open items" },
];

/** Assemble the section strings into one markdown digest (unbounded here). */
function assembleSummary(object: z.infer<typeof SummarySchema>): string {
	const blocks: string[] = [];
	for (const { key, heading } of SECTIONS) {
		const body = object[key]?.trim();
		if (body) {
			blocks.push(`## ${heading}\n\n${body}`);
		}
	}
	return blocks.join("\n\n");
}

/**
 * Strip any citation marker the model invented, keeping only markers in
 * `allowed`. Only touches brackets whose entire content is marker-shaped
 * (`[S12]` or `[S12, S13]`) so markdown links/lists are never mangled. Returns
 * the sanitized text and the set of allowed markers that actually survived.
 */
export function sanitizeCitations(
	text: string,
	allowed: Set<string>,
): { content: string; citedMarkers: string[] } {
	const cited = new Set<string>();
	const content = text.replace(
		/\[(S\d+(?:\s*,\s*S\d+)*)\]/g,
		(_match, group: string) => {
			const kept = group
				.split(",")
				.map((m) => m.trim())
				.filter((m) => allowed.has(m));
			for (const m of kept) {
				cited.add(m);
			}
			return kept.map((m) => `[${m}]`).join("");
		},
	);
	return { content, citedMarkers: [...cited] };
}

function buildBatchSourceBlock(sources: FoldBatchSource[]): string {
	const joined = sources
		.map((s) => {
			const label = s.label ? ` · ${s.label}` : "";
			const body = truncate(s.content.trim(), PER_SOURCE_CHAR_CAP);
			return `[${s.marker}] (${s.type} · ${s.timestamp}${label})\n${body}`;
		})
		.join("\n\n---\n\n");
	return truncate(joined, BATCH_INPUT_CHAR_CAP);
}

function buildDecisionBlock(decisions: FoldBatchDecision[]): string {
	if (decisions.length === 0) {
		return "(none logged)";
	}
	return decisions
		.map((d) => {
			const lines = [`[${d.marker}] Title: ${d.title}`];
			const decision = truncate(
				d.decision.trim(),
				DECISION_FIELD_CHAR_CAP,
			);
			if (decision) {
				lines.push(`Decision: ${decision}`);
			}
			const rationale = truncate(
				d.rationale.trim(),
				DECISION_FIELD_CHAR_CAP,
			);
			if (rationale) {
				lines.push(`Rationale: ${rationale}`);
			}
			return lines.join("\n");
		})
		.join("\n\n---\n\n");
}

function buildRoadmapBlock(items: FoldBatchRoadmapItem[]): string {
	if (items.length === 0) {
		return "(none)";
	}
	const lines = items.slice(0, ROADMAP_ITEM_CAP).map((r) => {
		const priority = r.priority ? `, ${r.priority}` : "";
		return `[${r.marker}] (${r.kind} · ${r.status}${priority}) ${r.title}`;
	});
	if (items.length > ROADMAP_ITEM_CAP) {
		lines.push(`(+${items.length - ROADMAP_ITEM_CAP} more roadmap items)`);
	}
	return lines.join("\n");
}

function buildCodeRepoBlock(repos: FoldBatchCodeRepo[]): string {
	if (repos.length === 0) {
		return "(none connected)";
	}
	return repos
		.map((r) => {
			const facts = [
				r.provider && `provider: ${r.provider}`,
				r.branch && `branch: ${r.branch}`,
				r.language && `primary language: ${r.language}`,
				r.url && `url: ${r.url}`,
			]
				.filter(Boolean)
				.join(" · ");
			const lines = [
				`[${r.marker}] ${r.label}${facts ? ` (${facts})` : ""}`,
			];
			if (r.analysis?.trim()) {
				lines.push(
					`High-level analysis: ${truncate(r.analysis.trim(), CODE_ANALYSIS_CHAR_CAP)}`,
				);
			}
			return lines.join("\n");
		})
		.join("\n\n---\n\n");
}

function buildCarriedLegend(refs: ContextSourceReference[]): string {
	if (refs.length === 0) {
		return "(none yet)";
	}
	return refs
		.slice(0, CARRIED_LEGEND_CAP)
		.map((r) => {
			const label = r.label ? ` · ${r.label}` : "";
			return `[${r.marker}] (${r.sourceType} · ${r.sourceTimestamp}${label})`;
		})
		.join("\n");
}

/**
 * Built-in system guidance for the fold. This is the in-code fallback and the
 * canonical text. The admin-editable copy lives in the Prompts DB under the key
 * `context_summarization` (seeded in `seed-prompts-only.ts`) — keep the seed
 * content in sync with this constant when it changes.
 */
export const SYSTEM_GUIDANCE = [
	"You compress a software project's accumulated context into a compact, faithful digest that an AI assistant reads INSTEAD of the full raw history.",
	"You work INCREMENTALLY: you are given the running digest so far and a new batch of raw sources, and you return the UPDATED digest that folds the new batch into the running one. Preserve everything durable from the running digest and add or revise with what the new batch contributes.",
	"Produce a structured summary with these sections (omit a section only if there is genuinely nothing to say):",
	"  - Goals & scope: what the project is trying to achieve and its boundaries — including the high-level product direction implied by the roadmap.",
	"  - Key decisions: the settled architectural/product decisions.",
	"  - Technical context / stack: languages, frameworks, services, integrations, data model notes, and the connected code repository/repositories (codebase, primary language, architecture at a high level).",
	"  - Constraints & non-goals: hard constraints, things explicitly out of scope, things ruled out.",
	"  - History / timeline: how the project has evolved, in rough chronological order.",
	"  - Open items: unresolved questions, known gaps, and the IMPORTANT in-flight / planned roadmap work (themes and significant epics/features — NOT a ticket-by-ticket list).",
	"STAY HIGH-LEVEL AND IMPORTANT: capture the direction, the significant decisions, the codebase shape, and the major roadmap themes/epics. Do NOT enumerate every roadmap item or restate low-level detail — prefer the few things that matter to how the project is understood and steered.",
	"CITATIONS: every source you are given carries a marker like [S12]. When a statement in the digest rests on a specific source, decision, roadmap item, or repository, cite it inline by appending its marker(s) in square brackets, e.g. 'adopted Postgres RLS [S12]'. Cite the important goals, decisions, constraints, technical claims, history entries, roadmap themes, and open items. Preserve markers already present in the running digest when the statement they support survives. Use ONLY markers that appear in AVAILABLE SOURCES, DECISIONS, CODEBASE, ROADMAP, or CARRIED CITATIONS — NEVER invent a marker or cite one you were not given.",
	"Rules: be faithful — never invent facts not supported by the provided context. Prefer durable facts over transient chatter. Be concise; this is a digest, not a transcript.",
].join("\n");

/**
 * Output-formatting contract, ALWAYS appended to whatever guidance is in force
 * (built-in or the admin-editable DB prompt). Formatting is an invariant of the
 * digest, not tunable content — a summary the reader can't skim is a defect. The
 * reader renders GFM markdown, where a single newline is NOT a line break, so a
 * section written as one blob renders as an unbroken wall of text; this steers
 * the model to real markdown structure instead.
 */
export const FORMATTING_GUIDANCE = [
	"FORMATTING — each section must be readable markdown, never one long unbroken paragraph:",
	"  - Use `-` bullet points for any enumerable content (decisions, constraints, open items, timeline entries, distinct scope themes) — one item per bullet.",
	"  - Break genuinely narrative prose into short paragraphs separated by a BLANK line; keep paragraphs to a few sentences.",
	"  - Keep each citation marker attached to the specific claim it supports, rather than piling many markers at the end of a long sentence.",
].join("\n");

/**
 * Fold one batch of raw context into the running digest. Resolves the model for
 * the tenant, runs one structured generation, sanitizes citations against the
 * allowed marker set, and returns the bounded markdown plus the markers that
 * survived and the concrete model id.
 */
export async function foldContextBatch(
	input: FoldContextBatchInput,
): Promise<FoldContextBatchResult> {
	// Org projects carry a null userId; provider/credit/model resolution is
	// org-scoped when an organizationId is present (empty userId is only a
	// personal-config fallback that org context never reaches).
	const context = {
		userId: input.tenancy.userId ?? "",
		organizationId: input.tenancy.organizationId ?? undefined,
		projectId: input.projectId,
	};

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: SUMMARIZATION_TASK_TYPE },
		context,
	);

	const promptParts: string[] = [`PROJECT: ${input.projectName}`, ""];

	if (input.includeProjectSources) {
		if (input.decisions.length > 0) {
			promptParts.push(
				"NEW ACCEPTED ARCHITECTURE DECISIONS (cite by marker):",
				buildDecisionBlock(input.decisions),
				"",
			);
		}
		if (input.codeRepos.length > 0) {
			promptParts.push(
				"CONNECTED CODE REPOSITORY / CODEBASE (high-level technical context; cite by marker):",
				buildCodeRepoBlock(input.codeRepos),
				"",
			);
		}
		if (input.roadmapItems.length > 0) {
			promptParts.push(
				"PROJECT ROADMAP — active work items, excludes hidden/rejected (summarize the DIRECTION and the IMPORTANT epics/features; do NOT enumerate every item; cite by marker):",
				buildRoadmapBlock(input.roadmapItems),
				"",
			);
		}
	}

	promptParts.push(
		"RUNNING DIGEST SO FAR (extend this; the established baseline for an incremental run, or empty for a fresh one):",
		input.runningSummary
			? truncate(input.runningSummary.trim(), RUNNING_SUMMARY_CHAR_CAP)
			: "(none — start fresh)",
		"",
		"CARRIED CITATIONS (markers already used above that you may keep citing):",
		buildCarriedLegend(input.carriedReferences),
		"",
		"AVAILABLE SOURCES FOR THIS BATCH (newest facts supersede older ones on conflict; cite by marker):",
		buildBatchSourceBlock(input.batchSources),
	);

	const result = await generateObject({
		model,
		schema: SummarySchema,
		messages: [
			cacheableSystem(
				`${input.systemPrompt?.trim() || SYSTEM_GUIDANCE}\n${FORMATTING_GUIDANCE}`,
			),
			{ role: "user" as const, content: promptParts.join("\n") },
		],
		// Optional fields make Azure/OpenAI reject a strict JSON schema (Bug
		// #1681); disable strict mode — the AI SDK still validates the object
		// against the Zod schema.
		providerOptions: { openai: { strictJsonSchema: false } },
	});

	trackUsage();

	const inputTokens = result.usage?.inputTokens ?? 0;
	const outputTokens = result.usage?.outputTokens ?? 0;
	// Real cost for this fold, priced from the resolved model. Best-effort — a
	// pricing miss (unknown model) just yields 0, never fails the fold.
	let costMicroUsd = 0;
	try {
		const usd = await estimateAiUsageCostUsd({
			provider: metadata.provider,
			providerModelId: metadata.modelString,
			modelCanonicalName: metadata.canonicalName ?? undefined,
			inputTokens,
			outputTokens,
		});
		costMicroUsd = Math.round(usd * 1_000_000);
	} catch {
		costMicroUsd = 0;
	}

	const allowed = new Set<string>([
		...input.carriedReferences.map((r) => r.marker),
		...input.batchSources.map((s) => s.marker),
		...input.decisions.map((d) => d.marker),
		...input.roadmapItems.map((r) => r.marker),
		...input.codeRepos.map((r) => r.marker),
	]);
	const assembled = truncate(
		assembleSummary(result.object),
		SUMMARY_CHAR_CAP,
	);
	const { content, citedMarkers } = sanitizeCitations(assembled, allowed);

	return {
		content,
		citedMarkers,
		model: metadata.modelString,
		usage: {
			inputTokens,
			outputTokens,
			totalTokens:
				result.usage?.totalTokens ?? inputTokens + outputTokens,
			costMicroUsd,
		},
	};
}
