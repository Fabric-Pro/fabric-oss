/**
 * Atlas export helpers.
 *
 * Turns a loaded analysis (status + the technical and business graphs) into a
 * portable snapshot the user can download and commit / share — a self-contained
 * JSON document, or a human-readable Markdown report. Everything is computed on
 * the client from data already in memory, so export needs no extra round-trip.
 *
 * Naming is deliberately Fabric-specific ("Atlas snapshot", `fabric-atlas`) and
 * the schema is our own — it is not a drop-in for any third-party graph format.
 */
import type {
	GraphEdge,
	GraphNode,
	TechStackEntry,
	AtlasStatus,
} from "@repo/atlas/types";

const ATLAS_EXPORT_VERSION = 1;

interface AtlasGraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface AtlasExportInput {
	repositoryName: string;
	status: AtlasStatus;
	technical: AtlasGraphData | null;
	business: AtlasGraphData | null;
}

interface AtlasExportSummary {
	nodes: number;
	relationships: number;
	filesAnalyzed: number;
	modules: number;
	capabilities: number;
	languages: number;
}

export interface AtlasExport {
	atlasVersion: number;
	generatedFrom: "fabric-atlas";
	repository: string;
	branch: string | null;
	commit: {
		sha: string | null;
		shortSha: string | null;
		committedAt: string | null;
	};
	analyzedAt: string | null;
	summary: AtlasExportSummary;
	techStack: TechStackEntry[];
	technical: AtlasGraphData;
	business: AtlasGraphData;
}

const EMPTY_GRAPH: AtlasGraphData = { nodes: [], edges: [] };

/** Distinct, non-null languages across a node set. */
function countLanguages(nodes: GraphNode[]): number {
	const set = new Set<string>();
	for (const node of nodes) {
		if (node.language) {
			set.add(node.language.toLowerCase());
		}
	}
	return set.size;
}

function countKind(nodes: GraphNode[], kind: GraphNode["kind"]): number {
	let total = 0;
	for (const node of nodes) {
		if (node.kind === kind) {
			total += 1;
		}
	}
	return total;
}

/** Build the structured JSON snapshot of an analysis. */
export function buildAtlasExport(input: AtlasExportInput): AtlasExport {
	const technical = input.technical ?? EMPTY_GRAPH;
	const business = input.business ?? EMPTY_GRAPH;
	const { status } = input;

	return {
		atlasVersion: ATLAS_EXPORT_VERSION,
		generatedFrom: "fabric-atlas",
		repository: input.repositoryName,
		branch: status.branch,
		commit: {
			sha: status.analyzedCommitSha,
			shortSha: status.analyzedShortSha,
			committedAt: status.analyzedCommitAt,
		},
		analyzedAt: status.analyzedAt,
		summary: {
			// Headline totals come from the analysis status (the full graph
			// across all node kinds) so they match the Overview dashboard cards;
			// the technical/business arrays below carry the graph-level payloads.
			nodes: status.nodeCount,
			relationships: status.edgeCount,
			filesAnalyzed: status.filesAnalyzed,
			modules: countKind(technical.nodes, "MODULE"),
			capabilities: countKind(business.nodes, "CAPABILITY"),
			languages: countLanguages(technical.nodes),
		},
		techStack: status.techStack ?? [],
		technical,
		business,
	};
}

/** Escape a value for safe inclusion in a Markdown table/line. */
function mdEscape(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/** Build a human-readable Markdown report of an analysis. */
export function buildAtlasMarkdown(input: AtlasExportInput): string {
	const snapshot = buildAtlasExport(input);
	const lines: string[] = [];

	lines.push(`# Atlas — ${input.repositoryName}`);
	lines.push("");
	const meta: string[] = ["Generated from Fabric Atlas"];
	if (snapshot.commit.shortSha) {
		meta.push(`commit \`${snapshot.commit.shortSha}\``);
	}
	if (snapshot.branch) {
		meta.push(`branch \`${snapshot.branch}\``);
	}
	lines.push(`> ${meta.join(" · ")}`);
	lines.push("");

	// About (the AI-narrated intro, when available).
	if (input.status.businessTour?.intro) {
		lines.push("## What this codebase does");
		lines.push("");
		lines.push(input.status.businessTour.intro.trim());
		lines.push("");
	}

	// At a glance.
	lines.push("## At a glance");
	lines.push("");
	lines.push(`- Nodes: ${snapshot.summary.nodes}`);
	lines.push(`- Relationships: ${snapshot.summary.relationships}`);
	lines.push(`- Files analysed: ${snapshot.summary.filesAnalyzed}`);
	lines.push(`- Modules: ${snapshot.summary.modules}`);
	lines.push(`- Languages: ${snapshot.summary.languages}`);
	lines.push("");

	// Languages breakdown (modules per language, descending).
	const langCounts = new Map<string, number>();
	for (const node of snapshot.technical.nodes) {
		if (node.kind === "MODULE" && node.language) {
			langCounts.set(
				node.language,
				(langCounts.get(node.language) ?? 0) + 1,
			);
		}
	}
	if (langCounts.size > 0) {
		lines.push("## Languages");
		lines.push("");
		for (const [language, count] of [...langCounts.entries()].sort(
			(a, b) => b[1] - a[1],
		)) {
			lines.push(`- ${mdEscape(language)} — ${count}`);
		}
		lines.push("");
	}

	// Most connected modules — in-degree of dependency edges (how many modules
	// depend on each), computed from the edges so it's meaningful regardless of
	// whether `metrics.dependentCount` is populated.
	const dependentsByKey = new Map<string, number>();
	for (const edge of snapshot.technical.edges) {
		if (edge.kind === "IMPORTS" || edge.kind === "DEPENDS_ON") {
			dependentsByKey.set(
				edge.target,
				(dependentsByKey.get(edge.target) ?? 0) + 1,
			);
		}
	}
	const topModules = snapshot.technical.nodes
		.filter((node) => node.kind === "MODULE")
		.map((node) => ({
			node,
			dependents: dependentsByKey.get(node.key) ?? 0,
		}))
		.sort(
			(a, b) =>
				b.dependents - a.dependents ||
				a.node.label.localeCompare(b.node.label),
		)
		.slice(0, 10);
	if (topModules.length > 0) {
		lines.push("## Most connected modules");
		lines.push("");
		topModules.forEach(({ node, dependents }, index) => {
			const path = node.filePath
				? ` — \`${mdEscape(node.filePath)}\``
				: "";
			lines.push(
				`${index + 1}. **${mdEscape(node.label)}** — ${dependents} dependents${path}`,
			);
		});
		lines.push("");
	}

	// Business capabilities (domains + capabilities with descriptions).
	const capabilities = snapshot.business.nodes.filter(
		(node) => node.kind === "DOMAIN" || node.kind === "CAPABILITY",
	);
	if (capabilities.length > 0) {
		lines.push("## Business capabilities");
		lines.push("");
		for (const node of capabilities) {
			lines.push(`### ${mdEscape(node.label)}`);
			if (node.description) {
				lines.push("");
				lines.push(mdEscape(node.description));
			}
			lines.push("");
		}
	}

	// Tech stack.
	if (snapshot.techStack.length > 0) {
		lines.push("## Tech stack");
		lines.push("");
		for (const entry of snapshot.techStack) {
			const version = entry.version ? ` ${entry.version}` : "";
			lines.push(
				`- **${mdEscape(entry.name)}**${version} (${entry.kind})`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** Slugify a repo name + sha into a safe download filename stem. */
export function atlasExportFilename(
	repositoryName: string,
	shortSha: string | null,
	extension: string,
): string {
	const slug =
		repositoryName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "repository";
	const sha = shortSha ? `-${shortSha}` : "";
	return `atlas-${slug}${sha}.${extension}`;
}

/** Trigger a client-side file download from a string payload. */
export function downloadTextFile(
	filename: string,
	content: string,
	mimeType: string,
): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}
