/**
 * Graph-grounded AI chat (R3). Builds the system prompt from BOTH analysed
 * lenses — the business capability map AND the technical module graph, plus the
 * capability→code coverage map — so a business question can be answered from the
 * real code and a technical question can be tied back to business value. Streams
 * a provider-agnostic completion; the oRPC procedure wraps it with
 * `streamToEventIterator`.
 */
import { buildChatSystemPromptHeader } from "./prompts";
import * as queries from "./queries";
import type { AtlasContext, GraphEdge, GraphMode, GraphNode } from "./types";

const MAX_CONTEXT_NODES = 80;
const MAX_CONTEXT_EDGES = 60;
const MAX_CROSS_NODES = 60;
const MAX_CROSS_EDGES = 40;
const MAX_COVERAGE_MODULES = 12;
const MAX_SOLO_CROSS_REFS = 40;

/**
 * One concise instruction telling the assistant to surface the relationships it
 * relies on. Shared verbatim by the solo and system-map prompts so a reference
 * is always cited the same way.
 */
const REFERENCE_CITATION_INSTRUCTION =
	'When your answer relies on a relationship or reference (X → Y, such as "calls", "depends on", "uses", "shares library with", or a cross-repository connection), state it explicitly and label it as a reference, e.g. `Reference: A → B (calls api)`.';

/**
 * A cross-repository reference that involves the solo chat's repository — one
 * endpoint sits in THIS analysis, the other in a sibling repo. The keys are
 * canonical node keys within their analysis (or null for a repo-level endpoint);
 * the prompt builder resolves them to labels where it can.
 */
export interface ChatCrossRef {
	sourceAnalysisId: string;
	sourceKey: string | null;
	targetAnalysisId: string;
	targetKey: string | null;
	kind: string;
	description: string | null;
}

export interface GraphChatInput {
	analysisId: string;
	mode: GraphMode;
	focusNodeKey?: string;
	repositoryName: string | null;
	projectName: string | null;
	/** Owning project — threaded so chat AI usage attributes to the project. */
	projectId?: string;
	/**
	 * Cross-repository references that involve THIS repository's analysis, in a
	 * multi-repo project. Empty/omitted for a single-repo project, so the prompt
	 * degrades to exactly today's behaviour. The caller (service `chat`) overlays
	 * user edits/manual edges before passing them in.
	 */
	crossRefs?: ChatCrossRef[];
	/** Maps each cross-ref endpoint's analysis id to its repository name. */
	repoNameByAnalysisId?: Record<string, string>;
	/** This chat's own analysis id — its endpoints are labelled with the repo itself. */
	thisAnalysisId?: string;
	messages: { role: "user" | "assistant" | "system"; content: string }[];
}

/** Render a node list (label + optional path + description), under a heading. */
function appendNodes(
	lines: string[],
	nodes: GraphNode[],
	cap: number,
	heading?: string,
): void {
	if (heading) {
		lines.push("", heading);
	}
	for (const node of nodes.slice(0, cap)) {
		lines.push(
			`- ${node.label}${node.filePath ? ` (${node.filePath})` : ""}: ${
				node.description ?? "(no description)"
			}`,
		);
	}
	if (nodes.length > cap) {
		lines.push(`…and ${nodes.length - cap} more.`);
	}
}

/**
 * Render up to `cap` relations as "source → target (kind)" under a heading.
 * When an edge carries an effective description (a team-edited note or AI
 * rationale that `getGraph` already overlaid), it is appended after the kind so
 * the assistant can ground its reference explanations in that note.
 */
function appendRelations(
	lines: string[],
	graph: { nodes: GraphNode[]; edges: GraphEdge[] },
	heading: string,
	cap: number,
): void {
	const labelByKey = new Map(graph.nodes.map((n) => [n.key, n.label]));
	const relations: string[] = [];
	for (const edge of graph.edges) {
		const source = labelByKey.get(edge.source);
		const target = labelByKey.get(edge.target);
		if (source && target) {
			const kind = edge.kind.toLowerCase().replace(/_/g, " ");
			const description = edge.description?.trim();
			relations.push(
				`- ${source} → ${target} (${kind})${
					description ? `: ${description}` : ""
				}`,
			);
		}
		if (relations.length >= cap) {
			break;
		}
	}
	if (relations.length) {
		lines.push("", heading, ...relations);
	}
}

/**
 * Build the graph-grounded system prompt. Grounds the conversation in BOTH
 * lenses (so either assistant can reason across code and business value) plus
 * the capability→code coverage map and any focused-node neighbourhood. Exported
 * so the persisting chat path in the facade grounds with the exact same context.
 */
export async function buildSystemPrompt(
	ctx: AtlasContext,
	input: Omit<GraphChatInput, "messages">,
): Promise<string> {
	const lines: string[] = buildChatSystemPromptHeader({
		repositoryName: input.repositoryName,
		projectName: input.projectName,
		mode: input.mode,
	});

	// When an answer leans on a relationship or reference between two areas
	// (X → Y; "calls", "depends on", "uses", "shares library with", or a
	// cross-repository connection), state it explicitly and label it.
	lines.push(REFERENCE_CITATION_INSTRUCTION);

	// Both lenses every session: the mode the user is viewing PLUS the other one,
	// so business answers can cite the real code and technical answers can
	// explain business value. The canvas graphs are small (modules / capabilities,
	// not files), so fetching both + the coverage map is cheap.
	const otherMode: GraphMode =
		input.mode === "BUSINESS" ? "TECHNICAL" : "BUSINESS";
	const [primary, secondary, coverage] = await Promise.all([
		queries.getGraph(ctx, input.analysisId, input.mode),
		queries.getGraph(ctx, input.analysisId, otherMode),
		queries.getCapabilityCoverage(ctx, input.analysisId),
	]);
	const business = input.mode === "BUSINESS" ? primary : secondary;
	const technical = input.mode === "TECHNICAL" ? primary : secondary;

	// Primary lens (its "## …" section title was already added by the header).
	appendNodes(lines, primary.nodes, MAX_CONTEXT_NODES);
	appendRelations(
		lines,
		primary,
		input.mode === "BUSINESS"
			? "## How these capabilities relate (use these to explain flows)"
			: "## How these modules relate (use these to explain data/control flow)",
		MAX_CONTEXT_EDGES,
	);

	// The other lens, for cross-referencing.
	appendNodes(
		lines,
		secondary.nodes,
		MAX_CROSS_NODES,
		input.mode === "BUSINESS"
			? "## Underlying code modules (cite these to ground business answers in the real implementation)"
			: "## Business capabilities this code delivers (use these to explain the user-facing value each area serves)",
	);
	appendRelations(
		lines,
		secondary,
		input.mode === "BUSINESS"
			? "## How those modules relate"
			: "## How those capabilities relate",
		MAX_CROSS_EDGES,
	);

	// The business↔code bridge: which modules implement each capability. Lets the
	// assistant answer "what code powers X?" and "what value does module Y serve?".
	const capLabel = new Map(business.nodes.map((n) => [n.key, n.label]));
	const modLabel = new Map(technical.nodes.map((n) => [n.key, n.label]));
	const byCapability = new Map<string, string[]>();
	for (const { capabilityKey, moduleKey } of coverage) {
		const cap = capLabel.get(capabilityKey);
		const mod = modLabel.get(moduleKey);
		if (!cap || !mod) {
			continue;
		}
		const mods = byCapability.get(cap) ?? [];
		if (mods.length < MAX_COVERAGE_MODULES) {
			mods.push(mod);
		}
		byCapability.set(cap, mods);
	}
	if (byCapability.size) {
		lines.push(
			"",
			"## Which code each capability covers (the business↔code map)",
		);
		for (const [cap, mods] of byCapability) {
			lines.push(`- ${cap}: ${mods.join(", ")}`);
		}
	}

	if (input.focusNodeKey) {
		const focus = await queries.getNodeDetail(ctx, {
			analysisId: input.analysisId,
			mode: input.mode,
			key: input.focusNodeKey,
		});
		if (focus) {
			lines.push("", `## Focused node: ${focus.label}`);
			if (focus.description) {
				lines.push(focus.description);
			}
			if (focus.neighbors.length) {
				lines.push(
					`Related: ${focus.neighbors
						.map((n) => `${n.label} (${n.edgeKind.toLowerCase()})`)
						.slice(0, 20)
						.join(", ")}`,
				);
			}
		}
	}

	appendCrossRefs(lines, input, {
		thisRepoLabel: input.repositoryName ?? "this repository",
		// Both lenses' nodes resolve labels for THIS repo's cross-ref endpoints;
		// the sibling repo's nodes aren't loaded here, so those fall back to the
		// repo name + raw key.
		thisRepoLabelByKey: new Map(
			[...primary.nodes, ...secondary.nodes].map((n) => [n.key, n.label]),
		),
	});

	return lines.join("\n");
}

/**
 * Append the cross-repository references that involve THIS repository, so a
 * solo-chat answer can reach into a sibling repo when a question spans them.
 * Each reference is resolved to node labels where they are known (this repo's
 * loaded graphs); a repo-level endpoint (null key) and any sibling node fall
 * back to the repository name. No-op when there are no cross-refs — a single-repo
 * project adds nothing.
 */
function appendCrossRefs(
	lines: string[],
	input: Pick<
		GraphChatInput,
		"crossRefs" | "repoNameByAnalysisId" | "thisAnalysisId"
	>,
	resolve: { thisRepoLabel: string; thisRepoLabelByKey: Map<string, string> },
): void {
	const crossRefs = input.crossRefs ?? [];
	if (crossRefs.length === 0) {
		return;
	}
	const repoNameByAnalysisId = input.repoNameByAnalysisId ?? {};
	const endpointLabel = (analysisId: string, key: string | null): string => {
		const repoName =
			analysisId === input.thisAnalysisId
				? resolve.thisRepoLabel
				: (repoNameByAnalysisId[analysisId] ?? "another repository");
		if (key === null) {
			return repoName;
		}
		if (analysisId === input.thisAnalysisId) {
			const label = resolve.thisRepoLabelByKey.get(key) ?? key;
			return `${repoName}:${label}`;
		}
		return `${repoName}:${key}`;
	};

	lines.push(
		"",
		"## Cross-repository references (this repository connects to other repos in the system — use these when a question touches another repo)",
	);
	for (const ref of crossRefs.slice(0, MAX_SOLO_CROSS_REFS)) {
		const kind = ref.kind.toLowerCase().replace(/_/g, " ");
		const description = ref.description?.trim();
		lines.push(
			`- ${endpointLabel(ref.sourceAnalysisId, ref.sourceKey)} → ${endpointLabel(
				ref.targetAnalysisId,
				ref.targetKey,
			)} (${kind})${description ? `: ${description}` : ""}`,
		);
	}
}

// ── Multi-repo "System map" chat ─────────────────────────────────────────────

const MAX_SYSTEM_NODES_PER_REPO = 28;
const MAX_SYSTEM_EDGES_PER_REPO = 24;
const MAX_SYSTEM_CROSS_EDGES = 60;

/** One repo participating in a System-map chat. */
interface SystemChatRepo {
	repoName: string;
	analysisId: string;
}

/** A persisted cross-repo edge, for grounding the System-map chat. */
interface SystemChatCrossEdge {
	kind: string;
	sourceAnalysisId: string;
	sourceKey: string | null; // null = the source repo itself
	targetAnalysisId: string;
	targetKey: string | null;
	description: string | null;
}

export interface SystemChatPromptInput {
	repos: SystemChatRepo[];
	mode: GraphMode;
	crossEdges: SystemChatCrossEdge[];
	projectName: string | null;
}

/**
 * Build the system prompt for multi-repo Q&A. Grounds the assistant in EACH
 * selected repo's graph (primary lens + the other lens, capped per repo) under
 * repo-labelled headings, then the cross-repository relationships, and tells it
 * to cite which repository each part of an answer refers to.
 */
export async function buildSystemChatPrompt(
	ctx: AtlasContext,
	input: SystemChatPromptInput,
): Promise<string> {
	const repoNames = input.repos.map((r) => r.repoName).join(", ");
	const lines: string[] = [
		`You are an expert assistant for a multi-repository system${
			input.projectName ? ` in the project "${input.projectName}"` : ""
		}.`,
		`It spans these repositories: ${repoNames}.`,
		"Answer questions that may require reasoning ACROSS repositories. Always make clear WHICH repository each part of your answer refers to (prefix with the repo name). Ground every claim in the modules, capabilities, and cross-repository relationships below; if something isn't covered, say so.",
		REFERENCE_CITATION_INSTRUCTION,
	];

	const otherMode: GraphMode =
		input.mode === "BUSINESS" ? "TECHNICAL" : "BUSINESS";
	const repoNameById = new Map(
		input.repos.map((r) => [r.analysisId, r.repoName]),
	);
	const labelByRepoKey = new Map<string, string>();

	for (const repo of input.repos) {
		const [primary, secondary] = await Promise.all([
			queries.getGraph(ctx, repo.analysisId, input.mode),
			queries.getGraph(ctx, repo.analysisId, otherMode),
		]);
		for (const n of [...primary.nodes, ...secondary.nodes]) {
			labelByRepoKey.set(`${repo.analysisId}::${n.key}`, n.label);
		}
		lines.push("", `## Repository: ${repo.repoName}`);
		appendNodes(
			lines,
			primary.nodes,
			MAX_SYSTEM_NODES_PER_REPO,
			input.mode === "BUSINESS"
				? `### ${repo.repoName} — capabilities`
				: `### ${repo.repoName} — modules`,
		);
		appendRelations(
			lines,
			primary,
			`### ${repo.repoName} — how they relate`,
			MAX_SYSTEM_EDGES_PER_REPO,
		);
		appendNodes(
			lines,
			secondary.nodes,
			Math.floor(MAX_SYSTEM_NODES_PER_REPO / 2),
			input.mode === "BUSINESS"
				? `### ${repo.repoName} — underlying code`
				: `### ${repo.repoName} — business value`,
		);
	}

	if (input.crossEdges.length) {
		lines.push(
			"",
			"## Cross-repository relationships (use these for any question that spans repos)",
		);
		for (const e of input.crossEdges.slice(0, MAX_SYSTEM_CROSS_EDGES)) {
			const srcRepo = repoNameById.get(e.sourceAnalysisId) ?? "?";
			const tgtRepo = repoNameById.get(e.targetAnalysisId) ?? "?";
			const src =
				e.sourceKey === null
					? srcRepo
					: (labelByRepoKey.get(
							`${e.sourceAnalysisId}::${e.sourceKey}`,
						) ?? e.sourceKey);
			const tgt =
				e.targetKey === null
					? tgtRepo
					: (labelByRepoKey.get(
							`${e.targetAnalysisId}::${e.targetKey}`,
						) ?? e.targetKey);
			const kind = e.kind.toLowerCase().replace(/_/g, " ");
			lines.push(
				`- ${srcRepo}:${src} → ${tgtRepo}:${tgt} (${kind})${
					e.description ? `: ${e.description}` : ""
				}`,
			);
		}
	}

	return lines.join("\n");
}
