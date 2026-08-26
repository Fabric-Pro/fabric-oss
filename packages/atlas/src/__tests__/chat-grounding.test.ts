/**
 * Chat grounding (cross-repo awareness + edge descriptions).
 *
 * Locks the prompt contract for the SOLO chat:
 *  - `appendRelations` (via `buildSystemPrompt`) renders an edge's effective
 *    description after the kind, so the assistant can ground a reference
 *    explanation in a team-edited note;
 *  - when `crossRefs` are supplied (a multi-repo project), the prompt adds a
 *    "Cross-repository references" section resolving THIS repo's endpoints to
 *    node labels and labelling sibling endpoints by repo name;
 *  - with no `crossRefs` (a single-repo project) the prompt degrades to exactly
 *    today's output — no cross-repo section;
 *  - BOTH the solo and the system-map prompts carry the explicit
 *    reference-citation instruction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphMode, GraphNode } from "../types";

const mockGetGraph = vi.fn();
const mockGetCapabilityCoverage = vi.fn();
const mockGetNodeDetail = vi.fn();

vi.mock("../queries", () => ({
	getGraph: (...args: unknown[]) => mockGetGraph(...args),
	getCapabilityCoverage: (...args: unknown[]) =>
		mockGetCapabilityCoverage(...args),
	getNodeDetail: (...args: unknown[]) => mockGetNodeDetail(...args),
}));

// chat.ts pulls @repo/ai + ./usage at module load; only the prompt builders are
// under test, so stub the streaming surface.
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
	streamText: vi.fn(),
}));
vi.mock("../usage", () => ({ recordAtlasUsage: vi.fn() }));

import { buildSystemChatPrompt, buildSystemPrompt } from "../chat";

const ctx = { userId: "user-1", organizationId: "org-1" };

function node(
	over: Partial<GraphNode> & { key: string; label: string },
): GraphNode {
	return {
		kind: "MODULE",
		filePath: null,
		language: null,
		parentKey: null,
		description: null,
		category: null,
		isUserCategory: false,
		metrics: null,
		layout: null,
		...over,
	} as GraphNode;
}

function graph(
	nodes: GraphNode[],
	edges: {
		source: string;
		target: string;
		kind: string;
		description?: string | null;
	}[],
) {
	return {
		mode: "TECHNICAL" as GraphMode,
		analysisId: "an-this",
		nodes,
		edges: edges.map((e) => ({
			source: e.source,
			target: e.target,
			kind: e.kind,
			weight: null,
			description: e.description ?? null,
		})),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Primary (TECHNICAL) lens: two modules with a described edge between them.
	// Secondary (BUSINESS) lens: empty. Coverage: empty.
	mockGetGraph.mockImplementation(
		(_ctx: unknown, _analysisId: string, mode: GraphMode) => {
			if (mode === "TECHNICAL") {
				return Promise.resolve(
					graph(
						[
							node({ key: "checkout", label: "Checkout" }),
							node({ key: "payments", label: "Payments" }),
						],
						[
							{
								source: "checkout",
								target: "payments",
								kind: "CALLS",
								description:
									"Checkout invokes the Payments charge flow",
							},
						],
					),
				);
			}
			return Promise.resolve(graph([], []));
		},
	);
	mockGetCapabilityCoverage.mockResolvedValue([]);
	mockGetNodeDetail.mockResolvedValue(null);
});

describe("buildSystemPrompt — edge descriptions", () => {
	it("appends a non-empty edge description after the kind", async () => {
		const prompt = await buildSystemPrompt(ctx, {
			analysisId: "an-this",
			mode: "TECHNICAL",
			repositoryName: "acme/web",
			projectName: null,
		});
		expect(prompt).toContain(
			"- Checkout → Payments (calls): Checkout invokes the Payments charge flow",
		);
	});

	it("renders a bare relation (no colon) when the edge has no description", async () => {
		mockGetGraph.mockImplementation(
			(_ctx: unknown, _id: string, mode: GraphMode) =>
				mode === "TECHNICAL"
					? Promise.resolve(
							graph(
								[
									node({ key: "a", label: "Alpha" }),
									node({ key: "b", label: "Beta" }),
								],
								[{ source: "a", target: "b", kind: "IMPORTS" }],
							),
						)
					: Promise.resolve(graph([], [])),
		);
		const prompt = await buildSystemPrompt(ctx, {
			analysisId: "an-this",
			mode: "TECHNICAL",
			repositoryName: "acme/web",
			projectName: null,
		});
		expect(prompt).toContain("- Alpha → Beta (imports)");
		expect(prompt).not.toContain("- Alpha → Beta (imports):");
	});
});

describe("buildSystemPrompt — cross-repository references", () => {
	it("adds a cross-ref section resolving this repo's labels and naming siblings", async () => {
		const prompt = await buildSystemPrompt(ctx, {
			analysisId: "an-this",
			mode: "TECHNICAL",
			repositoryName: "acme/web",
			projectName: null,
			thisAnalysisId: "an-this",
			repoNameByAnalysisId: {
				"an-this": "acme/web",
				"an-api": "acme/api",
			},
			crossRefs: [
				{
					sourceAnalysisId: "an-this",
					sourceKey: "checkout",
					targetAnalysisId: "an-api",
					targetKey: "charges",
					kind: "CALLS_API",
					description: "Checkout calls the charges endpoint",
				},
			],
		});
		expect(prompt).toContain("## Cross-repository references");
		// This repo's endpoint resolves to its node LABEL (Checkout, not key);
		// the sibling endpoint falls back to repo name + raw key.
		expect(prompt).toContain(
			"- acme/web:Checkout → acme/api:charges (calls api): Checkout calls the charges endpoint",
		);
	});

	it("uses the repo name for a repo-level (null key) endpoint", async () => {
		const prompt = await buildSystemPrompt(ctx, {
			analysisId: "an-this",
			mode: "TECHNICAL",
			repositoryName: "acme/web",
			projectName: null,
			thisAnalysisId: "an-this",
			repoNameByAnalysisId: {
				"an-this": "acme/web",
				"an-api": "acme/api",
			},
			crossRefs: [
				{
					sourceAnalysisId: "an-this",
					sourceKey: null,
					targetAnalysisId: "an-api",
					targetKey: null,
					kind: "SHARES_LIBRARY",
					description: "Both depend on @acme/ui-kit",
				},
			],
		});
		expect(prompt).toContain(
			"- acme/web → acme/api (shares library): Both depend on @acme/ui-kit",
		);
	});

	it("degrades to no cross-repo section for a single-repo project", async () => {
		const prompt = await buildSystemPrompt(ctx, {
			analysisId: "an-this",
			mode: "TECHNICAL",
			repositoryName: "acme/web",
			projectName: null,
		});
		expect(prompt).not.toContain("## Cross-repository references");
	});
});

describe("explicit reference-citation instruction", () => {
	it("appears in the solo prompt", async () => {
		const prompt = await buildSystemPrompt(ctx, {
			analysisId: "an-this",
			mode: "TECHNICAL",
			repositoryName: "acme/web",
			projectName: null,
		});
		expect(prompt).toContain("label it as a reference");
		expect(prompt).toContain("Reference: A → B (calls api)");
	});

	it("appears in the system-map prompt", async () => {
		mockGetGraph.mockResolvedValue(graph([], []));
		const prompt = await buildSystemChatPrompt(ctx, {
			repos: [{ repoName: "acme/web", analysisId: "an-this" }],
			mode: "TECHNICAL",
			crossEdges: [],
			projectName: null,
		});
		expect(prompt).toContain("label it as a reference");
		expect(prompt).toContain("Reference: A → B (calls api)");
	});
});
