/**
 * Intra-repository reference detection for the SOLO graph's "re-map relationships".
 *
 * Where {@link ./cross-repo.ts} maps relationships ACROSS repos, this maps the
 * meaningful semantic relationships BETWEEN one repo's own components — the links
 * a structural import graph misses (two modules that collaborate on the same
 * domain, a capability that depends on another's contract). One AI pass over the
 * repo's module + capability summaries, validated against real node keys; the
 * results are persisted as editable edge overrides so they overlay the structural
 * graph, survive re-analysis, and can be edited/deleted with history.
 *
 * Mirrors the cross-repo AI pass exactly: provider-agnostic, precision-first
 * (confidence-filtered + capped), and degrades to a no-op when no AI provider is
 * configured. The prompt builder + validator are pure and unit-tested.
 */
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	addTokenTotals,
	EMPTY_TOKEN_TOTALS,
	type TokenTotals,
	tokenTotalsFromUsage,
} from "./cost";
import type { RepoNodeLite } from "./cross-repo";
import type { AtlasContext, GraphMode } from "./types";
import { recordAtlasUsage } from "./usage";

const AI_TASK_TYPE = "SIMPLE" as const;

/** One repo's nodes for both lenses, fed to intra-repo detection. */
export interface IntraRepoData {
	analysisId: string;
	repoName: string;
	technicalNodes: RepoNodeLite[];
	businessNodes: RepoNodeLite[];
}

/** Reference kinds the intra-repo pass may emit (a subset shared with the edge
 * colour map: a concrete call/use, a behavioural dependency, or shared-domain
 * collaboration). */
export type IntraEdgeKind = "CALLS" | "DEPENDS_ON" | "RELATES_TO";

/** A detected intra-repo reference prior to persistence (endpoints are node keys
 * within the analysis's own graph for that lens). */
export interface DetectedIntraEdge {
	mode: GraphMode;
	kind: IntraEdgeKind;
	sourceKey: string;
	targetKey: string;
	description: string | null;
}

export interface IntraDetectionResult {
	edges: DetectedIntraEdge[];
	usage: TokenTotals;
	model: string | null;
}

const MAX_NODES_PER_LENS = 40;
const MAX_DESC_CHARS = 160;
// Precision over recall — the same philosophy as the cross-repo cap. A handful of
// genuinely useful "these two collaborate" links beat a flood of soft ones.
const MAX_INTRA_EDGES = 24;

const intraEdgeSchema = z.object({
	edges: z.array(
		z.object({
			sourceKey: z.string(),
			targetKey: z.string(),
			kind: z.enum(["CALLS", "DEPENDS_ON", "RELATES_TO"]),
			mode: z.enum(["TECHNICAL", "BUSINESS"]),
			/**
			 * How directly the relationship is evidenced by the node descriptions.
			 * `high` = stated/clearly implied; `medium` = strongly suggested;
			 * `low` = speculative. Drives the precision filter below.
			 */
			confidence: z.enum(["high", "medium", "low"]),
			rationale: z.string(),
		}),
	),
});

/**
 * Keep a reference only when the evidence is strong enough to help rather than
 * clutter. Concrete `CALLS` / `DEPENDS_ON` survive at medium+ confidence; the
 * softer `RELATES_TO` (shared domain) must be high-confidence — that's what
 * filters out vague "both do X" similarities.
 */
export function passesIntraConfidence(
	kind: IntraEdgeKind,
	confidence: "high" | "medium" | "low",
): boolean {
	if (confidence === "low") {
		return false;
	}
	return kind !== "RELATES_TO" || confidence === "high";
}

function truncate(value: string | null, max: number): string {
	if (!value) {
		return "";
	}
	return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

function renderLensBlock(label: string, nodes: RepoNodeLite[]): string {
	const lines = [`### ${label}`];
	for (const node of nodes.slice(0, MAX_NODES_PER_LENS)) {
		lines.push(
			`- key=${node.key} | ${node.label}${
				node.description
					? `: ${truncate(node.description, MAX_DESC_CHARS)}`
					: ""
			}`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the intra-repo AI prompt: both lenses in one pass, the model tags each
 * reference with the lens (`mode`) it belongs to.
 */
export function buildIntraRepoAiPrompt(repo: IntraRepoData): string {
	return [
		`You are mapping the meaningful relationships BETWEEN the components of ONE codebase ("${repo.repoName}").`,
		"The goal is a map an engineer can trust: every relationship must be real and specific enough to explain how the parts of this codebase fit together. Precision matters far more than coverage — a few correct links beat many speculative ones.",
		"Below are the components in two views, each with stable `key=` identifiers and a short description.",
		"",
		renderLensBlock("TECHNICAL modules", repo.technicalNodes),
		"",
		renderLensBlock("BUSINESS capabilities", repo.businessNodes),
		"",
		"Identify relationships BETWEEN two components in the SAME view. For each, output:",
		"- sourceKey/targetKey: the EXACT `key=` value of two components listed in the same view. sourceKey must differ from targetKey. Never invent keys, and never link a TECHNICAL component to a BUSINESS one.",
		"- kind:",
		"   • CALLS — one component invokes, uses, or drives the other at runtime (a direct dependency).",
		"   • DEPENDS_ON — one component's behaviour depends on the other's contract, configuration, schema, or shared model.",
		"   • RELATES_TO — the two components collaborate on the SAME concrete domain: the same data/entity, workflow, or a directly complementary responsibility.",
		"- mode: TECHNICAL for module-level relationships; BUSINESS for capability-level ones.",
		"- confidence: high = the descriptions state or clearly imply it; medium = strongly suggested; low = a guess.",
		"- rationale: one sentence naming the SPECIFIC evidence (the entity/contract/call involved) — not a restatement of the kind.",
		"",
		"Do NOT emit relationships for superficial similarity — two components both having auth, logging, validation, config, tests, or 'both written in X' is NOT a relationship. Only link them when they act on the same concrete thing.",
		"Avoid restating obvious containment (a folder that merely contains a file). Surface relationships that are NOT already obvious from the names alone.",
		"Omit anything speculative. If two components have no real relationship, do not link them.",
		`Return at most ~${MAX_INTRA_EDGES} of the strongest, most specific relationships.`,
	].join("\n");
}

/**
 * Validate raw AI references against the real per-lens node sets, dropping
 * hallucinated keys, self-loops, weak-confidence links, and duplicates.
 */
export function validateIntraEdges(
	raw: z.infer<typeof intraEdgeSchema>["edges"],
	repo: IntraRepoData,
): DetectedIntraEdge[] {
	const keysByMode = new Map<GraphMode, Set<string>>([
		["TECHNICAL", new Set(repo.technicalNodes.map((n) => n.key))],
		["BUSINESS", new Set(repo.businessNodes.map((n) => n.key))],
	]);

	const seen = new Set<string>();
	const out: DetectedIntraEdge[] = [];
	for (const e of raw) {
		if (e.sourceKey === e.targetKey) {
			continue; // self-loop
		}
		if (!passesIntraConfidence(e.kind, e.confidence)) {
			continue; // too weak to be meaningful
		}
		const keys = keysByMode.get(e.mode);
		if (!keys?.has(e.sourceKey) || !keys.has(e.targetKey)) {
			continue; // hallucinated endpoint (or cross-lens)
		}
		// Undirected dedupe per (mode, kind): A↔B once.
		const [lo, hi] =
			e.sourceKey < e.targetKey
				? [e.sourceKey, e.targetKey]
				: [e.targetKey, e.sourceKey];
		const dedupe = `${e.mode}|${e.kind}|${lo}|${hi}`;
		if (seen.has(dedupe)) {
			continue;
		}
		seen.add(dedupe);
		out.push({
			mode: e.mode,
			kind: e.kind,
			sourceKey: e.sourceKey,
			targetKey: e.targetKey,
			description: e.rationale.trim() || null,
		});
		if (out.length >= MAX_INTRA_EDGES) {
			break;
		}
	}
	return out;
}

/**
 * Run the intra-repo AI pass for one repo. Degrades to an empty result (no
 * references) when no AI provider is configured or the call fails — re-map must
 * never hard-fail on the AI step.
 */
export async function detectIntraRepoReferences(
	ctx: AtlasContext,
	repo: IntraRepoData,
	projectId?: string,
): Promise<IntraDetectionResult> {
	if (repo.technicalNodes.length + repo.businessNodes.length < 2) {
		return { edges: [], usage: EMPTY_TOKEN_TOTALS, model: null };
	}
	let resolution: Awaited<ReturnType<typeof getAIModelWithMetadata>> | null;
	try {
		resolution = await getAIModelWithMetadata(
			{ taskType: AI_TASK_TYPE },
			{
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			},
		);
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			logger.warn("[atlas] no AI provider for intra-repo detection");
			return { edges: [], usage: EMPTY_TOKEN_TOTALS, model: null };
		}
		throw error;
	}

	const prompt = buildIntraRepoAiPrompt(repo);
	const startedAt = Date.now();
	try {
		const { object, usage } = await generateObject({
			model: resolution.model,
			schema: intraEdgeSchema,
			prompt,
		});
		recordAtlasUsage({
			ctx,
			metadata: resolution.metadata,
			taskType: AI_TASK_TYPE,
			usage,
			startedAt,
			projectId,
		});
		resolution.trackUsage();
		return {
			edges: validateIntraEdges(object.edges, repo),
			usage: addTokenTotals(
				EMPTY_TOKEN_TOTALS,
				tokenTotalsFromUsage(usage),
			),
			model: resolution.metadata?.canonicalName ?? null,
		};
	} catch (error) {
		logger.warn("[atlas] intra-repo AI detection failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { edges: [], usage: EMPTY_TOKEN_TOTALS, model: null };
	}
}
