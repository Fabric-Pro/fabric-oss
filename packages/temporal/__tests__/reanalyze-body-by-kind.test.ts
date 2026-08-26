/**
 * Tests for the type-aware, structure-preserving re-analysis core.
 *
 * Verifies: bug + feature happy paths preserve structure; the bug
 * "Original Description (Do Not Modify)" guard splices verbatim and falls back
 * when dropped; destructive output safe-holds; AC is never wiped; and every
 * failure mode (no prompt bound, provider not configured, LLM throw) safe-holds
 * with the ORIGINAL body and fallbackUsed=true.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, FakeAIProviderNotConfiguredError } = vi.hoisted(() => {
	class FakeAIProviderNotConfiguredError extends Error {
		constructor() {
			super("AI provider not configured");
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return {
		mocks: {
			generateObject: vi.fn(),
			getAIModelWithMetadata: vi.fn(),
			logModelUsageAsync: vi.fn(),
			getBoundPromptForAgent: vi.fn(),
			renderTemplate: vi.fn(),
			getProjectFunctionTagClause: vi.fn(),
		},
		FakeAIProviderNotConfiguredError,
	};
});

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: FakeAIProviderNotConfiguredError,
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));

vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils", async () => {
	// Keep the REAL entity decoder: it is pure, and stubbing it would leave the
	// markdown-entity cleanup on the merge output untested.
	const actual =
		await vi.importActual<typeof import("@repo/utils")>("@repo/utils");
	return { ...actual, renderTemplate: mocks.renderTemplate };
});

import { reanalyzeBodyByKind } from "../src/lib/reanalyze-body-by-kind";

const BUG_BODY = `## Bug: Login fails
## Steps to Reproduce
1. Open /login
2. Click sign in
## Expected Result
Signed in.
## Actual Result
Nothing.
## Environment
Chrome 120
## Root Cause
Unknown.
## Original Description from User (Do Not Modify)
login is broken`;

const BASE = {
	title: "Login fails",
	identifier: "F-101",
	existingDescription: BUG_BODY,
	existingAcceptanceCriteria: "",
	newInfo: "Root cause confirmed: null form ref.",
	userId: "u1",
	organizationId: null as string | null,
	projectId: "p1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
	mocks.renderTemplate.mockResolvedValue({ rendered: "PROMPT", error: null });
	mocks.getBoundPromptForAgent.mockResolvedValue({
		version: { content: "TEMPLATE" },
		format: "HANDLEBARS",
	});
	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so this pre-existing
	// suite keeps asserting the pre-Stage-4 prompt shape unchanged.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("reanalyzeBodyByKind — BUG", () => {
	it("returns the merged markdown on a structure-preserving edit", async () => {
		const merged = BUG_BODY.replace(
			"Unknown.",
			"Null form ref on first render.",
		);
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: merged },
			usage: {},
		});
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(false);
		expect(res.description).toContain("Null form ref on first render.");
		expect(res.needsMoreInfo).toBe(false);
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_reanalyzer",
				storyKind: "BUG",
			}),
		);
	});

	it("splices the Original Description back verbatim if the model mutated it", async () => {
		const mutated = BUG_BODY.replace(
			"login is broken",
			"user says login broke",
		);
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: mutated },
			usage: {},
		});
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(false);
		expect(res.description).toContain("login is broken");
		expect(res.description).not.toContain("user says login broke");
	});

	it("safe-holds when the model drops the Original Description section", async () => {
		const dropped = "## Steps to Reproduce\n1. x\n## Actual Result\ny";
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: dropped },
			usage: {},
		});
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(true);
		expect(res.description).toBe(BUG_BODY);
	});

	it("safe-holds on a destructive (cross-type) rewrite", async () => {
		const reformatted =
			"## Feature Narrative\nAs a user...\n## Acceptance Criteria\nGIVEN...";
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: reformatted },
			usage: {},
		});
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(true);
		expect(res.description).toBe(BUG_BODY);
	});
});

describe("reanalyzeBodyByKind — FEATURE", () => {
	const FEATURE_BODY =
		"As a user, I want bulk export, so that I can archive.\n\n## Overview\nExport to CSV.\n\n## Open Questions\n- Which formats?";

	it("returns merged description + AC and uses the feature prompt", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				description: `${FEATURE_BODY}\n- Add: rate limits?`,
				acceptanceCriteria: "GIVEN export WHEN large THEN paginates",
			},
			usage: {},
		});
		const res = await reanalyzeBodyByKind({
			...BASE,
			kind: "FEATURE",
			existingDescription: FEATURE_BODY,
			existingAcceptanceCriteria:
				"GIVEN export WHEN clicked THEN downloads",
		});
		expect(res.fallbackUsed).toBe(false);
		expect(res.description).toContain("rate limits?");
		expect(res.acceptanceCriteria).toContain("paginates");
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_reanalyzer",
				storyKind: "FEATURE",
			}),
		);
	});

	it("does not wipe existing AC when the model returns blank AC", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				description: `${FEATURE_BODY}\nmore`,
				acceptanceCriteria: "  ",
			},
			usage: {},
		});
		const res = await reanalyzeBodyByKind({
			...BASE,
			kind: "FEATURE",
			existingDescription: FEATURE_BODY,
			existingAcceptanceCriteria: "GIVEN x WHEN y THEN z",
		});
		expect(res.fallbackUsed).toBe(false);
		// undefined => "leave acceptance criteria unchanged"
		expect(res.acceptanceCriteria).toBeUndefined();
	});
});

describe("reanalyzeBodyByKind — FR-25 locked-attachment rule", () => {
	it("appends the DEDICATED ATTACHMENTS rule to the BUG re-analysis prompt", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: BUG_BODY },
			usage: {},
		});
		await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain("DEDICATED ATTACHMENTS");
	});

	it("appends the DEDICATED ATTACHMENTS rule to the FEATURE re-analysis prompt", async () => {
		const body = "As a user, I want X, so that Y.";
		mocks.generateObject.mockResolvedValue({
			object: { description: body },
			usage: {},
		});
		await reanalyzeBodyByKind({
			...BASE,
			kind: "FEATURE",
			existingDescription: body,
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain("DEDICATED ATTACHMENTS");
	});
});

describe("reanalyzeBodyByKind — failure modes safe-hold", () => {
	it("safe-holds when no prompt is bound", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(null);
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(true);
		expect(res.fallbackReason).toBe("prompt_not_bound");
		expect(res.description).toBe(BUG_BODY);
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("safe-holds when the provider is not configured", async () => {
		mocks.generateObject.mockRejectedValue(
			new FakeAIProviderNotConfiguredError(),
		);
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(true);
		expect(res.fallbackReason).toBe("ai_not_configured");
		expect(res.description).toBe(BUG_BODY);
	});

	it("safe-holds when the LLM call throws", async () => {
		mocks.generateObject.mockRejectedValue(new Error("boom"));
		const res = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		expect(res.fallbackUsed).toBe(true);
		expect(res.fallbackReason).toBe("llm_error");
		expect(res.description).toBe(BUG_BODY);
	});
});

describe("reanalyzeBodyByKind — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-reanalyze-body";

	beforeEach(() => {
		mocks.generateObject.mockResolvedValue({
			object: { needsMoreInfo: false, markdown: BUG_BODY },
			usage: {},
		});
	});

	it("flag ON: resolves the role clause with the params' project/user and appends it to the prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "p1",
			requesterUserId: "u1",
			surface: "reanalyze-body",
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		const withClause = mocks.generateObject.mock.calls[0][0]
			.prompt as string;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });
		const withoutClause = mocks.generateObject.mock.calls[0][0]
			.prompt as string;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});

describe("reanalyzeBodyByKind — markdown entity cleanup", () => {
	/**
	 * Work-item bodies are markdown, rendered through a markdown component, so
	 * an HTML entity is literal text the reader sees. Models emit them anyway,
	 * and escape the ampersand of an entity they were SHOWN — so enriching the
	 * same ticket repeatedly compounds the damage:
	 *
	 *     it's → it&#x27;s → it&amp;#x27;s → …
	 *
	 * Observed on staging: a ticket enriched twice went 0 → 15 → 27 occurrences
	 * having never contained an entity. Create-vs-Enrich routing makes repeat
	 * enrichment of one ticket the normal case, so this is not hypothetical.
	 */
	it("decodes entities a model emitted into a BUG body", async () => {
		const merged = BUG_BODY.replace(
			"Unknown.",
			"The team&#x27;s null form ref, per QA&#x27;s repro.",
		);
		mocks.generateObject.mockResolvedValue({
			object: { markdown: merged, needsMoreInfo: false },
			usage: {},
		});

		const result = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });

		expect(result.fallbackUsed).toBe(false);
		expect(result.description).toContain("The team's null form ref");
		expect(result.description).toContain("per QA's repro");
		expect(result.description).not.toContain("&#x27;");
	});

	it("unwinds compounding rather than escalating it", async () => {
		const merged = BUG_BODY.replace(
			"Unknown.",
			"The team&amp;#x27;s decision stands.",
		);
		mocks.generateObject.mockResolvedValue({
			object: { markdown: merged, needsMoreInfo: false },
			usage: {},
		});

		const result = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });

		expect(result.description).toContain("The team's decision stands.");
		expect(result.description).not.toMatch(/&amp;|&#x27;/);
	});

	it("cleans a FEATURE description and its acceptance criteria", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				description: "## Story\nThe user&#x27;s workspace loads.",
				acceptanceCriteria:
					"GIVEN the user&#x27;s session THEN it works.",
			},
			usage: {},
		});

		const result = await reanalyzeBodyByKind({
			...BASE,
			kind: "FEATURE",
			existingDescription: "## Story\nOld body.",
			existingAcceptanceCriteria: "GIVEN something THEN it works.",
		});

		expect(result.description).toContain("The user's workspace loads.");
		expect(result.acceptanceCriteria).toContain("GIVEN the user's session");
		expect(
			`${result.description}${result.acceptanceCriteria}`,
		).not.toContain("&#x27;");
	});

	it("leaves a literal ampersand in the body alone", async () => {
		const merged = BUG_BODY.replace(
			"Unknown.",
			"Affects R&D and Q&A flows.",
		);
		mocks.generateObject.mockResolvedValue({
			object: { markdown: merged, needsMoreInfo: false },
			usage: {},
		});

		const result = await reanalyzeBodyByKind({ ...BASE, kind: "BUG" });

		expect(result.description).toContain("Affects R&D and Q&A flows.");
	});
});
