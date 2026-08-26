/**
 * Cross-repository relationship detection for the multi-repo "System map".
 *
 * Works entirely from ALREADY-PERSISTED per-repo analysis data (nodes, their
 * descriptions, and the `techStack` parsed from dependency manifests) — it never
 * re-clones or changes the Temporal analysis workflow. Two passes:
 *
 *  • STRUCTURAL (deterministic, cheap): shared significant libraries (techStack
 *    overlap) and cross-repo dependency (repo A depends on a package named after
 *    repo B). Emitted at the repository level (null endpoint keys → the repo's
 *    System-map group container).
 *  • AI-assisted (semantic): an LLM pass over each repo's module/capability
 *    summaries to surface API client→server (`CALLS_API`) and shared-domain
 *    (`RELATES_TO`) relationships that aren't expressed as a package import.
 *    Validated against real node keys (hallucinated endpoints are dropped).
 *
 * The structural + signature helpers are pure (dependency-free) and unit-tested;
 * the AI pass mirrors `describe.ts` (provider-agnostic, degrades to no-op when no
 * AI provider is configured).
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
import type {
	AtlasContext,
	AtlasNodeKind,
	CrossEdgeDetection,
	GraphMode,
	SystemCrossEdgeKind,
	TechStackEntry,
} from "./types";
import { recordAtlasUsage } from "./usage";

const AI_TASK_TYPE = "SIMPLE" as const;

/** A node lite-projection fed to detection (one per real analysis node). */
export interface RepoNodeLite {
	key: string;
	label: string;
	kind: AtlasNodeKind;
	description: string | null;
	filePath: string | null;
}

/** One repository's persisted analysis, as consumed by detection. */
export interface RepoAnalysisData {
	analysisId: string;
	repoId: string | null;
	repoName: string;
	repoUrl: string;
	commitSha: string | null;
	techStack: TechStackEntry[];
	/**
	 * Package identities this repo PUBLISHES (workspace package names, Go module
	 * path, .NET package id…). Drives the precise cross-repo `DEPENDS_ON`: another
	 * repo depending on one of these genuinely consumes this repo's code. Empty
	 * for analyses captured before this was recorded (falls back to the heuristic).
	 */
	publishedPackages: string[];
	/** Technical-lens nodes (modules/directories). */
	technicalNodes: RepoNodeLite[];
	/** Business-lens nodes (capabilities/domains). */
	businessNodes: RepoNodeLite[];
}

/** A detected cross-repo edge prior to persistence. */
export interface DetectedCrossEdge {
	mode: GraphMode;
	kind: SystemCrossEdgeKind;
	detection: CrossEdgeDetection;
	sourceAnalysisId: string;
	sourceKey: string | null; // null = the source repo (group) itself
	targetAnalysisId: string;
	targetKey: string | null; // null = the target repo (group) itself
	weight: number | null;
	description: string | null;
}

export interface AiDetectionResult {
	edges: DetectedCrossEdge[];
	usage: TokenTotals;
	model: string | null;
}

// ── Significance filter (shared-library noise control) ───────────────────────

/**
 * Ubiquitous dependencies whose presence in two repos says nothing interesting
 * about a relationship between them (everyone uses them). Matched case-insensitively
 * on the unscoped package name.
 */
const UBIQUITOUS_DEPS = new Set<string>([
	"react",
	"react-dom",
	"react-native",
	"vue",
	"svelte",
	"angular",
	"next",
	"nuxt",
	"express",
	"koa",
	"fastify",
	"typescript",
	"tslib",
	"eslint",
	"prettier",
	"biome",
	"vite",
	"webpack",
	"rollup",
	"babel",
	"jest",
	"vitest",
	"mocha",
	"chai",
	"lodash",
	"underscore",
	"ramda",
	"axios",
	"node-fetch",
	"cross-fetch",
	"dotenv",
	"chalk",
	"commander",
	"zod",
	"yup",
	"classnames",
	"clsx",
	"uuid",
	"moment",
	"dayjs",
	"date-fns",
	"rxjs",
	"redux",
	"zustand",
	"tailwindcss",
	"postcss",
	"autoprefixer",
	"jquery",
	"bootstrap",
	"numpy",
	"pandas",
	"requests",
	"flask",
	"django",
	"pytest",
	"gin",
	"echo",
	"junit",
	"spring-boot",
	"spring-core",
]);

/** Drop the npm/maven-style scope, returning the bare package name, lowercased. */
export function unscopedName(name: string): string {
	const trimmed = name.trim().toLowerCase();
	// npm scope: @org/pkg → pkg. maven: group:artifact → artifact. go: host/a/b → b.
	if (trimmed.startsWith("@") && trimmed.includes("/")) {
		return trimmed.slice(trimmed.indexOf("/") + 1);
	}
	if (trimmed.includes(":")) {
		return trimmed.slice(trimmed.lastIndexOf(":") + 1);
	}
	if (trimmed.includes("/")) {
		return trimmed.slice(trimmed.lastIndexOf("/") + 1);
	}
	return trimmed;
}

/**
 * A dependency is "significant" for shared-library detection when it is NOT a
 * ubiquitous framework/util AND is a real name (length ≥ 3). Scoped packages
 * (`@org/...`) are always significant — a shared first-party package is the
 * strongest shared-library signal.
 */
export function isSignificantDep(name: string): boolean {
	const raw = name.trim().toLowerCase();
	if (raw.length < 3) {
		return false;
	}
	if (raw.startsWith("@") && raw.includes("/")) {
		return true; // scoped → first-party signal
	}
	return !UBIQUITOUS_DEPS.has(unscopedName(raw));
}

/** Normalise a repo identity token (lowercase, strip non-alphanumerics). */
function normalizeIdentity(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

/** Identity tokens for a repo: repo name + last URL path segment, normalised. */
function repoIdentityTokens(repo: RepoAnalysisData): Set<string> {
	const tokens = new Set<string>();
	if (repo.repoName) {
		tokens.add(normalizeIdentity(repo.repoName));
	}
	try {
		const last = repo.repoUrl
			.replace(/\.git$/, "")
			.split("/")
			.filter(Boolean)
			.pop();
		if (last) {
			tokens.add(normalizeIdentity(last));
		}
	} catch {
		// best-effort
	}
	tokens.delete("");
	return tokens;
}

// ── Structural detection ─────────────────────────────────────────────────────

const MAX_SHARED_LIBS_LISTED = 8;

/**
 * Deterministic cross-repo edges from manifests:
 *  • SHARES_LIBRARY — one aggregated edge per repo pair that shares ≥1 significant
 *    library (weight = count, description = the shared libs).
 *  • DEPENDS_ON — repo A lists a dependency whose unscoped name matches repo B's
 *    identity (A imports B's published package).
 * Repo-level (null endpoint keys). Emitted for BOTH lenses so the container-level
 * relationship shows in the Business and Technical System maps alike.
 */
export function detectStructuralEdges(
	repos: RepoAnalysisData[],
): DetectedCrossEdge[] {
	const modes: GraphMode[] = ["TECHNICAL", "BUSINESS"];
	const edges: DetectedCrossEdge[] = [];

	const significantByRepo = repos.map(
		(r) =>
			new Map(
				r.techStack
					.map((t) => t.name)
					.filter((n) => n && isSignificantDep(n))
					.map((n) => [unscopedName(n), n] as const),
			),
	);
	const identityByRepo = repos.map((r) => repoIdentityTokens(r));

	for (let i = 0; i < repos.length; i++) {
		for (let j = i + 1; j < repos.length; j++) {
			const a = repos[i];
			const b = repos[j];

			// Shared significant libraries (unordered pair).
			const shared: string[] = [];
			for (const [unscoped, original] of significantByRepo[i]) {
				if (significantByRepo[j].has(unscoped)) {
					shared.push(original);
				}
			}
			if (shared.length > 0) {
				const listed = shared.slice(0, MAX_SHARED_LIBS_LISTED);
				const extra = shared.length - listed.length;
				const desc = `Both repositories depend on ${listed.join(", ")}${
					extra > 0 ? ` and ${extra} more` : ""
				}.`;
				for (const mode of modes) {
					edges.push({
						mode,
						kind: "SHARES_LIBRARY",
						detection: "STRUCTURAL",
						sourceAnalysisId: a.analysisId,
						sourceKey: null,
						targetAnalysisId: b.analysisId,
						targetKey: null,
						weight: shared.length,
						description: desc,
					});
				}
			}
		}
	}

	// Published-package identity per repo (lowercased), for the PRECISE match.
	const publishedByRepo = repos.map(
		(r) =>
			new Set(
				r.publishedPackages
					.map((p) => p.trim().toLowerCase())
					.filter(Boolean),
			),
	);

	// Directed dependency: A lists a dependency that B publishes. Prefer the
	// precise published-package match (A depends on B's own package → a real
	// cross-repo code dependency); fall back to the repo-name identity heuristic
	// for analyses with no captured package identities.
	for (let i = 0; i < repos.length; i++) {
		for (let j = 0; j < repos.length; j++) {
			if (i === j) {
				continue;
			}
			const a = repos[i];
			const b = repos[j];

			// Precise: a dependency of A whose exact name is one B publishes.
			const bPublished = publishedByRepo[j];
			let matched =
				bPublished.size > 0
					? a.techStack.find((dep) =>
							bPublished.has(dep.name.trim().toLowerCase()),
						)
					: undefined;
			const viaPublished = matched !== undefined;

			// Fallback: a dependency named after B's repo identity.
			if (!matched) {
				const bIdentity = identityByRepo[j];
				if (bIdentity.size > 0) {
					matched = a.techStack.find((dep) =>
						bIdentity.has(
							normalizeIdentity(unscopedName(dep.name)),
						),
					);
				}
			}

			if (matched) {
				const desc = viaPublished
					? `${a.repoName} depends on ${b.repoName}'s published package "${matched.name}".`
					: `${a.repoName} depends on ${b.repoName}'s package "${matched.name}".`;
				for (const mode of modes) {
					edges.push({
						mode,
						kind: "DEPENDS_ON",
						detection: "STRUCTURAL",
						sourceAnalysisId: a.analysisId,
						sourceKey: null,
						targetAnalysisId: b.analysisId,
						targetKey: null,
						weight: null,
						description: desc,
					});
				}
			}
		}
	}

	return edges;
}

// ── Signature (freshness) ────────────────────────────────────────────────────

/** Tiny deterministic 32-bit FNV-1a hash → hex (dependency-free, stable). */
export function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/**
 * Freshness signature for a set of analyses: changes whenever the participating
 * repos OR their analysed commits change, so the cross-link is recomputed only
 * when stale. Order-independent (sorted).
 */
export function computeSignature(
	repos: ReadonlyArray<{ analysisId: string; commitSha: string | null }>,
): string {
	const parts = repos
		.map((r) => `${r.analysisId}:${r.commitSha ?? ""}`)
		.sort();
	return fnv1a(parts.join("|"));
}

// ── AI-assisted detection ────────────────────────────────────────────────────

const MAX_AI_NODES_PER_REPO = 24;
const MAX_AI_DESC_CHARS = 160;
// Cap on PERSISTED relationships. Precision over recall: a microservices map is
// only useful if every edge is real, so we keep this tight and lean on the
// confidence filter below rather than letting the model flood soft links.
const MAX_AI_EDGES = 30;

const aiEdgeSchema = z.object({
	edges: z.array(
		z.object({
			sourceRef: z.string(),
			sourceKey: z.string(),
			targetRef: z.string(),
			targetKey: z.string(),
			kind: z.enum(["CALLS_API", "RELATES_TO"]),
			mode: z.enum(["TECHNICAL", "BUSINESS"]),
			/**
			 * How directly the relationship is evidenced by the node descriptions.
			 * `high` = stated/clearly implied; `medium` = strongly suggested;
			 * `low` = speculative. Drives the precision filter in `validateAiEdges`.
			 */
			confidence: z.enum(["high", "medium", "low"]),
			rationale: z.string(),
		}),
	),
});

/**
 * Keep an edge only when the evidence is strong enough that it helps rather than
 * clutters the map. Concrete call/dependency relationships (`CALLS_API`) survive
 * at medium+ confidence; the softer "shared domain" (`RELATES_TO`) must be
 * high-confidence — that's what filters out vague "both do X" similarities.
 */
function passesConfidence(
	kind: "CALLS_API" | "RELATES_TO",
	confidence: "high" | "medium" | "low",
): boolean {
	if (confidence === "low") {
		return false;
	}
	return kind === "CALLS_API" || confidence === "high";
}

function truncate(value: string | null, max: number): string {
	if (!value) {
		return "";
	}
	return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

/** Render one repo's node block for the prompt (capped). */
function renderRepoBlock(
	ref: string,
	repo: RepoAnalysisData,
	nodes: RepoNodeLite[],
): string {
	const lines = [`### ${ref} — repository "${repo.repoName}"`];
	for (const node of nodes.slice(0, MAX_AI_NODES_PER_REPO)) {
		lines.push(
			`- key=${node.key} | ${node.label}${
				node.description
					? `: ${truncate(node.description, MAX_AI_DESC_CHARS)}`
					: ""
			}`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the cross-repo AI prompt. Each repo gets a stable `ref` (repo1, repo2…)
 * so the model references repos unambiguously regardless of name collisions.
 */
export function buildCrossRepoAiPrompt(repos: RepoAnalysisData[]): {
	prompt: string;
	refByAnalysisId: Map<string, string>;
} {
	const refByAnalysisId = new Map<string, string>();
	const blocks: string[] = [];
	repos.forEach((repo, idx) => {
		const ref = `repo${idx + 1}`;
		refByAnalysisId.set(repo.analysisId, ref);
		blocks.push(
			[
				renderRepoBlock(
					`${ref} (TECHNICAL modules)`,
					repo,
					repo.technicalNodes,
				),
				renderRepoBlock(
					`${ref} (BUSINESS capabilities)`,
					repo,
					repo.businessNodes,
				),
			].join("\n"),
		);
	});

	const prompt = [
		"You are mapping how the repositories in ONE software system connect (microservices / multi-repo).",
		"The goal is a map an engineer can trust: every relationship must be real and specific enough to explain how these services fit together. Precision matters far more than coverage — a few correct edges beat many speculative ones.",
		"Below are the repositories, each with its technical modules and business capabilities (with stable `key=` identifiers).",
		"",
		blocks.join("\n\n"),
		"",
		"Identify relationships that CROSS repository boundaries only. For each, output:",
		"- sourceRef/targetRef: the repoN label of each side (e.g. repo1). sourceRef must differ from targetRef.",
		"- sourceKey/targetKey: the EXACT `key=` value of a node listed under that repo. Never invent keys.",
		"- kind:",
		"   • CALLS_API — one repo's code/client invokes the OTHER repo's API, endpoint, tool, service, or published package (a runtime dependency from one service to another). Prefer this; it is the backbone of a microservices map.",
		"   • RELATES_TO — the two repos collaborate on the SAME concrete domain: the same data/entity, a shared API contract, or a directly complementary responsibility (e.g. one defines a model the other consumes).",
		"- mode: TECHNICAL for module-level relationships; BUSINESS for capability-level ones.",
		"- confidence: high = the descriptions state or clearly imply it; medium = strongly suggested; low = a guess.",
		"- rationale: one sentence naming the SPECIFIC evidence (the endpoint/client/tool/entity/contract involved) — not a restatement of the kind.",
		"",
		"Do NOT emit RELATES_TO for superficial similarity — two repos both having auth, logging, middleware, config, tests, schemas, or 'both are written in X' is NOT a relationship. Only link them when they act on the same concrete thing.",
		"Omit anything speculative. If two repos have no real cross-boundary relationship, return no edges for that pair.",
		"Return at most ~" +
			String(MAX_AI_EDGES) +
			" of the strongest, most specific relationships.",
	].join("\n");

	return { prompt, refByAnalysisId };
}

/**
 * Validate raw AI edges against the real node sets and map repo refs back to
 * analysis ids, dropping anything hallucinated or non-cross-repo.
 */
export function validateAiEdges(
	raw: z.infer<typeof aiEdgeSchema>["edges"],
	repos: RepoAnalysisData[],
	refByAnalysisId: Map<string, string>,
): DetectedCrossEdge[] {
	const analysisIdByRef = new Map(
		[...refByAnalysisId.entries()].map(([id, ref]) => [ref, id]),
	);
	const keysByAnalysisMode = new Map<string, Set<string>>();
	for (const repo of repos) {
		keysByAnalysisMode.set(
			`${repo.analysisId}:TECHNICAL`,
			new Set(repo.technicalNodes.map((n) => n.key)),
		);
		keysByAnalysisMode.set(
			`${repo.analysisId}:BUSINESS`,
			new Set(repo.businessNodes.map((n) => n.key)),
		);
	}

	const seen = new Set<string>();
	const out: DetectedCrossEdge[] = [];
	for (const e of raw) {
		const sourceAnalysisId = analysisIdByRef.get(e.sourceRef);
		const targetAnalysisId = analysisIdByRef.get(e.targetRef);
		if (
			!sourceAnalysisId ||
			!targetAnalysisId ||
			sourceAnalysisId === targetAnalysisId
		) {
			continue; // unknown ref or not cross-repo
		}
		if (!passesConfidence(e.kind, e.confidence)) {
			continue; // too weak to be meaningful — keeps the map trustworthy
		}
		const srcKeys = keysByAnalysisMode.get(`${sourceAnalysisId}:${e.mode}`);
		const tgtKeys = keysByAnalysisMode.get(`${targetAnalysisId}:${e.mode}`);
		if (!srcKeys?.has(e.sourceKey) || !tgtKeys?.has(e.targetKey)) {
			continue; // hallucinated endpoint
		}
		const dedupe = `${e.mode}|${e.kind}|${sourceAnalysisId}|${e.sourceKey}|${targetAnalysisId}|${e.targetKey}`;
		if (seen.has(dedupe)) {
			continue;
		}
		seen.add(dedupe);
		out.push({
			mode: e.mode,
			kind: e.kind,
			detection: "AI",
			sourceAnalysisId,
			sourceKey: e.sourceKey,
			targetAnalysisId,
			targetKey: e.targetKey,
			weight: null,
			description: e.rationale.trim() || null,
		});
		if (out.length >= MAX_AI_EDGES) {
			break;
		}
	}
	return out;
}

/**
 * Run the AI cross-repo pass. Degrades to an empty result (no edges) when no AI
 * provider is configured or the call fails — detection must never hard-fail the
 * link run (structural edges still persist).
 */
export async function detectAiEdges(
	ctx: AtlasContext,
	repos: RepoAnalysisData[],
	projectId?: string,
): Promise<AiDetectionResult> {
	if (repos.length < 2) {
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
			logger.warn("[atlas] no AI provider for cross-repo detection");
			return { edges: [], usage: EMPTY_TOKEN_TOTALS, model: null };
		}
		throw error;
	}

	const { prompt, refByAnalysisId } = buildCrossRepoAiPrompt(repos);
	const startedAt = Date.now();
	try {
		const { object, usage } = await generateObject({
			model: resolution.model,
			schema: aiEdgeSchema,
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
			edges: validateAiEdges(object.edges, repos, refByAnalysisId),
			usage: addTokenTotals(
				EMPTY_TOKEN_TOTALS,
				tokenTotalsFromUsage(usage),
			),
			model: resolution.metadata?.canonicalName ?? null,
		};
	} catch (error) {
		logger.warn("[atlas] cross-repo AI detection failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { edges: [], usage: EMPTY_TOKEN_TOTALS, model: null };
	}
}
