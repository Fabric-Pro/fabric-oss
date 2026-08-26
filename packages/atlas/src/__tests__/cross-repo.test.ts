import { describe, expect, it } from "vitest";
import {
	buildCrossRepoAiPrompt,
	computeSignature,
	detectStructuralEdges,
	isSignificantDep,
	type RepoAnalysisData,
	unscopedName,
	validateAiEdges,
} from "../cross-repo";
import type { TechStackEntry } from "../types";

function dep(name: string): TechStackEntry {
	return {
		ecosystem: "npm",
		name,
		version: null,
		kind: "library",
		dev: false,
	};
}

function repo(over: Partial<RepoAnalysisData>): RepoAnalysisData {
	return {
		analysisId: "a1",
		repoId: "i1",
		repoName: "repo-one",
		repoUrl: "https://github.com/org/repo-one",
		commitSha: "sha1",
		techStack: [],
		publishedPackages: [],
		technicalNodes: [],
		businessNodes: [],
		...over,
	};
}

describe("unscopedName", () => {
	it("strips npm scope, maven group, and path prefixes", () => {
		expect(unscopedName("@org/api-client")).toBe("api-client");
		expect(unscopedName("group:artifact")).toBe("artifact");
		expect(unscopedName("github.com/org/pkg")).toBe("pkg");
		expect(unscopedName("Plain")).toBe("plain");
	});
});

describe("isSignificantDep", () => {
	it("drops ubiquitous frameworks/utils", () => {
		expect(isSignificantDep("react")).toBe(false);
		expect(isSignificantDep("lodash")).toBe(false);
		expect(isSignificantDep("axios")).toBe(false);
		expect(isSignificantDep("typescript")).toBe(false);
	});
	it("keeps scoped (first-party) and non-trivial libraries", () => {
		expect(isSignificantDep("@acme/api-client")).toBe(true);
		expect(isSignificantDep("@acme/ui-kit")).toBe(true);
		expect(isSignificantDep("widget-engine")).toBe(true);
	});
	it("drops too-short names", () => {
		expect(isSignificantDep("ab")).toBe(false);
	});
});

describe("detectStructuralEdges", () => {
	it("emits SHARES_LIBRARY for a shared significant library, in both lenses", () => {
		const a = repo({
			analysisId: "a",
			repoName: "frontend",
			repoUrl: "https://github.com/acme/frontend",
			techStack: [dep("@acme/ui-kit"), dep("react")],
		});
		const b = repo({
			analysisId: "b",
			repoName: "backend",
			repoUrl: "https://github.com/acme/backend",
			techStack: [dep("@acme/ui-kit"), dep("express")],
		});
		const edges = detectStructuralEdges([a, b]);
		const shares = edges.filter((e) => e.kind === "SHARES_LIBRARY");
		// One per lens (TECHNICAL + BUSINESS).
		expect(shares).toHaveLength(2);
		expect(new Set(shares.map((e) => e.mode))).toEqual(
			new Set(["TECHNICAL", "BUSINESS"]),
		);
		for (const e of shares) {
			expect(e.detection).toBe("STRUCTURAL");
			expect(e.sourceKey).toBeNull();
			expect(e.targetKey).toBeNull();
			expect(e.description).toContain("@acme/ui-kit");
		}
	});

	it("does NOT emit SHARES_LIBRARY for only-ubiquitous overlap", () => {
		const a = repo({
			analysisId: "a",
			techStack: [dep("react"), dep("axios")],
		});
		const b = repo({
			analysisId: "b",
			techStack: [dep("react"), dep("axios")],
		});
		expect(
			detectStructuralEdges([a, b]).filter(
				(e) => e.kind === "SHARES_LIBRARY",
			),
		).toHaveLength(0);
	});

	it("emits DEPENDS_ON when one repo depends on another's package", () => {
		const fe = repo({
			analysisId: "fe",
			repoName: "frontend",
			repoUrl: "https://github.com/acme/frontend",
			techStack: [dep("@acme/backend"), dep("react")],
		});
		const be = repo({
			analysisId: "be",
			repoName: "backend",
			repoUrl: "https://github.com/acme/backend",
			techStack: [],
		});
		const deps = detectStructuralEdges([fe, be]).filter(
			(e) => e.kind === "DEPENDS_ON",
		);
		// Directed fe -> be, one per lens.
		expect(deps.length).toBe(2);
		for (const e of deps) {
			expect(e.sourceAnalysisId).toBe("fe");
			expect(e.targetAnalysisId).toBe("be");
		}
	});

	it("emits a PRECISE DEPENDS_ON via published packages, even when the package name doesn't match the repo name", () => {
		// `gateway` depends on a package the `core` repo publishes — but the
		// package is named "@acme/domain-sdk", nothing like the repo "core", so
		// only the published-package match (not the identity heuristic) can find it.
		const gateway = repo({
			analysisId: "gw",
			repoName: "gateway",
			repoUrl: "https://github.com/acme/gateway",
			techStack: [dep("@acme/domain-sdk"), dep("react")],
		});
		const core = repo({
			analysisId: "core",
			repoName: "core",
			repoUrl: "https://github.com/acme/core",
			publishedPackages: ["@acme/domain-sdk", "@acme/core-types"],
		});
		const deps = detectStructuralEdges([gateway, core]).filter(
			(e) => e.kind === "DEPENDS_ON",
		);
		expect(deps.length).toBe(2); // one per lens
		for (const e of deps) {
			expect(e.sourceAnalysisId).toBe("gw");
			expect(e.targetAnalysisId).toBe("core");
			expect(e.description).toContain("published package");
			expect(e.description).toContain("@acme/domain-sdk");
		}
	});

	it("does not emit a cross-repo DEPENDS_ON for a third party both repos use", () => {
		// Both depend on `lodash`; neither publishes it → no DEPENDS_ON.
		const a = repo({
			analysisId: "a",
			repoName: "a",
			repoUrl: "https://github.com/acme/a",
			techStack: [dep("lodash")],
		});
		const b = repo({
			analysisId: "b",
			repoName: "b",
			repoUrl: "https://github.com/acme/b",
			techStack: [dep("lodash")],
			publishedPackages: ["@acme/b-pkg"],
		});
		expect(
			detectStructuralEdges([a, b]).filter(
				(e) => e.kind === "DEPENDS_ON",
			),
		).toHaveLength(0);
	});
});

describe("computeSignature", () => {
	it("is order-independent and changes with commit", () => {
		const s1 = computeSignature([
			{ analysisId: "a", commitSha: "x" },
			{ analysisId: "b", commitSha: "y" },
		]);
		const s2 = computeSignature([
			{ analysisId: "b", commitSha: "y" },
			{ analysisId: "a", commitSha: "x" },
		]);
		expect(s1).toBe(s2);
		const s3 = computeSignature([
			{ analysisId: "a", commitSha: "z" },
			{ analysisId: "b", commitSha: "y" },
		]);
		expect(s3).not.toBe(s1);
	});
});

describe("validateAiEdges", () => {
	const repos: RepoAnalysisData[] = [
		repo({
			analysisId: "a",
			technicalNodes: [
				{
					key: "m1",
					label: "Checkout",
					kind: "MODULE",
					description: null,
					filePath: null,
				},
			],
		}),
		repo({
			analysisId: "b",
			technicalNodes: [
				{
					key: "p1",
					label: "Payments",
					kind: "MODULE",
					description: null,
					filePath: null,
				},
			],
		}),
	];
	const refByAnalysisId = new Map([
		["a", "repo1"],
		["b", "repo2"],
	]);

	it("keeps a valid cross-repo edge with real endpoints", () => {
		const out = validateAiEdges(
			[
				{
					sourceRef: "repo1",
					sourceKey: "m1",
					targetRef: "repo2",
					targetKey: "p1",
					kind: "CALLS_API",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "Checkout calls Payments",
				},
			],
			repos,
			refByAnalysisId,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			detection: "AI",
			kind: "CALLS_API",
			sourceAnalysisId: "a",
			targetAnalysisId: "b",
			sourceKey: "m1",
			targetKey: "p1",
		});
	});

	it("drops hallucinated keys, unknown refs, and same-repo edges", () => {
		const out = validateAiEdges(
			[
				{
					sourceRef: "repo1",
					sourceKey: "ghost",
					targetRef: "repo2",
					targetKey: "p1",
					kind: "CALLS_API",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "x",
				},
				{
					sourceRef: "repo9",
					sourceKey: "m1",
					targetRef: "repo2",
					targetKey: "p1",
					kind: "CALLS_API",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "x",
				},
				{
					sourceRef: "repo1",
					sourceKey: "m1",
					targetRef: "repo1",
					targetKey: "m1",
					kind: "RELATES_TO",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "x",
				},
			],
			repos,
			refByAnalysisId,
		);
		expect(out).toHaveLength(0);
	});

	it("filters weak edges: drops low-confidence and medium RELATES_TO, keeps concrete calls + strong domain links", () => {
		const out = validateAiEdges(
			[
				// low confidence → always dropped, even a call.
				{
					sourceRef: "repo1",
					sourceKey: "m1",
					targetRef: "repo2",
					targetKey: "p1",
					kind: "CALLS_API",
					mode: "TECHNICAL",
					confidence: "low",
					rationale: "maybe calls",
				},
				// medium RELATES_TO → dropped (the "both do X" noise band).
				{
					sourceRef: "repo1",
					sourceKey: "m1",
					targetRef: "repo2",
					targetKey: "p1",
					kind: "RELATES_TO",
					mode: "TECHNICAL",
					confidence: "medium",
					rationale: "both have modules",
				},
				// medium CALLS_API → kept (concrete enough).
				{
					sourceRef: "repo2",
					sourceKey: "p1",
					targetRef: "repo1",
					targetKey: "m1",
					kind: "CALLS_API",
					mode: "TECHNICAL",
					confidence: "medium",
					rationale: "Payments notifies Checkout",
				},
			],
			repos,
			refByAnalysisId,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			kind: "CALLS_API",
			sourceAnalysisId: "b",
			targetAnalysisId: "a",
		});
	});

	it("keeps a high-confidence RELATES_TO (a real shared-domain link)", () => {
		const out = validateAiEdges(
			[
				{
					sourceRef: "repo1",
					sourceKey: "m1",
					targetRef: "repo2",
					targetKey: "p1",
					kind: "RELATES_TO",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "Both operate on the same Order entity",
				},
			],
			repos,
			refByAnalysisId,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: "RELATES_TO" });
	});
});

describe("buildCrossRepoAiPrompt", () => {
	it("assigns stable refs and lists node keys", () => {
		const { prompt, refByAnalysisId } = buildCrossRepoAiPrompt([
			repo({
				analysisId: "a",
				repoName: "frontend",
				technicalNodes: [
					{
						key: "m1",
						label: "Checkout",
						kind: "MODULE",
						description: "checkout flow",
						filePath: null,
					},
				],
			}),
			repo({ analysisId: "b", repoName: "backend" }),
		]);
		expect(refByAnalysisId.get("a")).toBe("repo1");
		expect(refByAnalysisId.get("b")).toBe("repo2");
		expect(prompt).toContain("key=m1");
		expect(prompt).toContain("frontend");
	});
});
