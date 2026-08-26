import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateObject,
	mockGetAIModelWithMetadata,
	mockTrackUsage,
	mockLogModelUsageAsync,
	mockLoggerWarn,
	mockGetBoundPromptForAgent,
	mockRenderTemplate,
	MockNoObjectGeneratedError,
} = vi.hoisted(() => ({
	mockGenerateObject: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockTrackUsage: vi.fn(),
	mockLogModelUsageAsync: vi.fn(),
	mockLoggerWarn: vi.fn(),
	mockGetBoundPromptForAgent: vi.fn(),
	mockRenderTemplate: vi.fn(),
	// Stands in for the AI SDK's `NoObjectGeneratedError`. The module under test
	// gates its repair retry on `NoObjectGeneratedError.isInstance`, so the mock
	// has to carry that static + the `text` / `finishReason` the failure log reads.
	MockNoObjectGeneratedError: class NoObjectGeneratedError extends Error {
		readonly text: string | undefined;
		readonly finishReason: string | undefined;
		constructor(options: {
			message?: string;
			text?: string;
			finishReason?: string;
		}) {
			super(options.message ?? "No object generated");
			this.text = options.text;
			this.finishReason = options.finishReason;
		}
		static isInstance(error: unknown): boolean {
			return error instanceof NoObjectGeneratedError;
		}
	},
}));

// Mock `ai` — `zodSchema` is a passthrough (the schema value is irrelevant
// because `generateObject` itself is mocked).
vi.mock("ai", () => ({
	generateObject: (args: unknown) => mockGenerateObject(args),
	zodSchema: (schema: unknown) => schema,
	NoObjectGeneratedError: MockNoObjectGeneratedError,
}));

// The prompt is resolved from the Prompt Library binding and rendered; mock both
// so the test never pulls in `@repo/database` / the template engine.
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: (...args: unknown[]) =>
		mockGetBoundPromptForAgent(...args),
}));
vi.mock("@repo/utils", () => ({
	renderTemplate: (...args: unknown[]) => mockRenderTemplate(...args),
}));

// Fully mock the model selector (no `importActual`) so the test never pulls in
// the real provider stack / `@repo/database`. The error class declared here is
// the SAME reference the module under test sees, so its `instanceof` check
// matches errors we throw from the mock.
vi.mock("../lib/dynamic-model-selector", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	getAIModelWithMetadata: (...args: unknown[]) =>
		mockGetAIModelWithMetadata(...args),
}));

vi.mock("../lib/usage-logging", () => ({
	logModelUsageAsync: (...args: unknown[]) => mockLogModelUsageAsync(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: mockLoggerWarn,
		error: vi.fn(),
	},
}));

import { AIProviderNotConfiguredError } from "../lib/dynamic-model-selector";
import {
	ABSOLUTE_MAX_DRAFTED_TEST_CASES,
	boundAcceptanceCriteria,
	countAcceptanceCriteria,
	describeQaPolicy,
	draftMaxOutputTokens,
	draftTestCases,
	extractOpenQuestions,
	MAX_DRAFTED_TEST_CASES,
	normalizeDraftedTestCases,
	TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY,
} from "../lib/prompts/test-case-drafting";

const STUB_MODEL = { provider: "test" } as const;
const STUB_METADATA = {
	provider: "OPENAI_DIRECT",
	configId: "cfg",
	modelString: "gpt-4o",
	canonicalName: "gpt-4o",
	billingMode: "external_byok",
	billingCustomerId: null,
} as const;
const STUB_USAGE = { inputTokens: 100, outputTokens: 40, totalTokens: 140 };

/** A minimal well-formed case — the fields the schema now asks the model for. */
const rawCase = (overrides: Record<string, unknown> = {}) => ({
	title: "Case",
	preconditions: "Signed in as Admin in org Acme",
	acceptanceCriterionRef: "AC 1",
	priority: "HIGH",
	steps: [{ action: "a", expected: "b" }],
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	// Defaults: prompt unbound → in-memory fallback; render is a passthrough.
	mockGetBoundPromptForAgent.mockResolvedValue(null);
	mockRenderTemplate.mockImplementation(
		async ({ template }: { template: string }) => ({ rendered: template }),
	);
});

describe("normalizeDraftedTestCases — JSON-string payloads", () => {
	// Both shapes were observed live against a real provider: the model answers
	// a structured-output request with the right cases wrapped one level too
	// deep. The schema rightly rejects it, and re-asking reproduced the same
	// wrapper — so the cases were lost and the generation was billed twice.
	it("unwraps a stringified `testCases` array (the shape seen in production)", () => {
		const inner = JSON.stringify({
			testCases: [rawCase({ title: "Migration blocks on ADR conflict" })],
		});

		const result = normalizeDraftedTestCases({ testCases: inner });

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			title: "Migration blocks on ADR conflict",
			state: "DRAFT",
		});
	});

	it("unwraps a whole response returned as a JSON string", () => {
		const raw = JSON.stringify({
			testCases: [rawCase({ title: "Login succeeds" })],
		});

		expect(normalizeDraftedTestCases(raw)).toHaveLength(1);
	});

	it("leaves a well-formed object untouched", () => {
		const result = normalizeDraftedTestCases({
			testCases: [rawCase({ title: "Plain object still works" })],
		});

		expect(result).toHaveLength(1);
	});

	it("yields nothing for a string that is not JSON, rather than throwing", () => {
		expect(
			normalizeDraftedTestCases("I could not generate any cases."),
		).toEqual([]);
		expect(normalizeDraftedTestCases("{ truncated json…")).toEqual([]);
	});
});

describe("normalizeDraftedTestCases", () => {
	it("forces every case to DRAFT — never READY/CLOSED — with default automation", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				{
					// The model is not asked for state/automation, but even if it
					// volunteered them they must be overridden.
					...rawCase({ title: "Login succeeds" }),
					state: "READY",
					automationStatus: "AUTOMATED",
				},
			],
		});

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			title: "Login succeeds",
			state: "DRAFT",
			automationStatus: "NOT_AUTOMATED",
		});
		for (const testCase of result) {
			expect(testCase.state).toBe("DRAFT");
			expect(testCase.state).not.toBe("READY");
			expect(testCase.state).not.toBe("CLOSED");
		}
	});

	// The pyramid level is asked of the model so a drafted case arrives
	// classified instead of landing as UNSET for a person to set by hand — and so
	// the depth tier has something to check a case against.
	it("takes the model's pyramid level, mapped case-insensitively onto the enum", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({ title: "a", coverageType: "E2E" }),
				rawCase({ title: "b", coverageType: "integration" }),
				rawCase({ title: "c", coverageType: "  Unit  " }),
				rawCase({ title: "d", coverageType: "MANUAL" }),
			],
		});

		expect(result.map((c) => c.coverageType)).toEqual([
			"E2E",
			"INTEGRATION",
			"UNIT",
			"MANUAL",
		]);
	});

	it("leaves the pyramid level unset rather than guessing at it", () => {
		// Absent, blank, invented and non-string all become null. A wrong
		// classification is worse than none: null shows as UNSET and invites a
		// person to fix it, whereas a confident "UNIT" on an end-to-end case
		// quietly corrupts the coverage matrix.
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({ title: "a" }),
				rawCase({ title: "b", coverageType: "" }),
				rawCase({ title: "c", coverageType: "SMOKE" }),
				rawCase({ title: "d", coverageType: 3 }),
			],
		});

		expect(result).toHaveLength(4);
		for (const testCase of result) {
			expect(testCase.coverageType).toBeNull();
		}
	});

	// An off-tier case becomes a PROPOSAL rather than being dropped or silently
	// counted. PROPOSED already means "an AI suggested this, a human decides" and
	// is already excluded from coverage totals, so the tier gets teeth without a
	// new state, a new UI, or discarding work the customer paid for.
	it("proposes an off-tier case on a light project instead of drafting it", () => {
		const result = normalizeDraftedTestCases(
			{
				testCases: [
					rawCase({ title: "unit one", coverageType: "UNIT" }),
					rawCase({ title: "e2e one", coverageType: "E2E" }),
					rawCase({
						title: "integration one",
						coverageType: "INTEGRATION",
					}),
				],
			},
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);

		expect(result.map((c) => [c.title, c.state])).toEqual([
			["unit one", "DRAFT"],
			["e2e one", "PROPOSED"],
			["integration one", "PROPOSED"],
		]);
		// Nothing is discarded — all three survive, reviewable.
		expect(result).toHaveLength(3);
	});

	// The dimension axis. `coverageType` says how far up the stack a case reaches;
	// this says what it is looking FOR. Until it existed, a spontaneous security
	// case on a light project was indistinguishable from a functional one, so the
	// half of the tier that says "security only where a criterion or lens asks"
	// was unenforceable.
	it("proposes a spontaneous security case on a light project", () => {
		const result = normalizeDraftedTestCases(
			{
				testCases: [
					rawCase({
						title: "sql injection on login",
						coverageType: "UNIT",
						dimension: "SECURITY",
					}),
				],
			},
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);

		// UNIT is an allowed pyramid level on EASY — it is the DIMENSION that
		// makes this off-tier, which is the whole point of the second axis.
		expect(result[0]?.state).toBe("PROPOSED");
	});

	it("proposes an off-dimension case on the middle tier too", () => {
		const result = normalizeDraftedTestCases(
			{
				testCases: [
					rawCase({ title: "contrast", dimension: "ACCESSIBILITY" }),
				],
			},
			MAX_DRAFTED_TEST_CASES,
			"AVERAGE",
		);

		expect(result[0]?.state).toBe("PROPOSED");
	});

	it("leaves a functional case alone on every tier", () => {
		for (const depth of ["EASY", "AVERAGE", "HARD"]) {
			const result = normalizeDraftedTestCases(
				{
					testCases: [
						rawCase({ title: "login", dimension: "FUNCTIONAL" }),
					],
				},
				MAX_DRAFTED_TEST_CASES,
				depth,
			);
			expect(result[0]?.state).toBe("DRAFT");
		}
	});

	it("asks for every dimension on the deepest tier", () => {
		for (const d of ["SECURITY", "ACCESSIBILITY", "PERFORMANCE"]) {
			const result = normalizeDraftedTestCases(
				{ testCases: [rawCase({ title: "x", dimension: d })] },
				MAX_DRAFTED_TEST_CASES,
				"HARD",
			);
			expect(result[0]?.state).toBe("DRAFT");
		}
	});

	it("checks each axis independently, and each fails safe", () => {
		// A model that classifies the level but declines the dimension must still
		// be checked on the level — and vice versa. Neither absent answer may
		// suppress the other axis, and neither may itself cause a demotion.
		const levelOnly = normalizeDraftedTestCases(
			{ testCases: [rawCase({ title: "e2e", coverageType: "E2E" })] },
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);
		expect(levelOnly[0]?.state).toBe("PROPOSED");

		const neither = normalizeDraftedTestCases(
			{ testCases: [rawCase({ title: "plain" })] },
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);
		expect(neither[0]?.state).toBe("DRAFT");
	});

	it("does not demote a lens-authored security case", () => {
		// Enabling the Security Reviewer is the documented exception, and it
		// outranks BOTH axes.
		const result = normalizeDraftedTestCases(
			{
				testCases: [
					rawCase({
						title: "authz",
						dimension: "SECURITY",
						scepticRole: "security",
					}),
				],
			},
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);

		expect(result[0]?.scepticRole).toBe("security");
	});

	it("leaves the deeper tiers alone — they ask for the whole pyramid", () => {
		for (const depth of ["AVERAGE", "HARD"]) {
			const result = normalizeDraftedTestCases(
				{ testCases: [rawCase({ title: "e2e", coverageType: "E2E" })] },
				MAX_DRAFTED_TEST_CASES,
				depth,
			);
			expect(result[0]?.state).toBe("DRAFT");
		}
	});

	it("does not demote a case an enabled lens deliberately asked for", () => {
		// The sceptic lens is the documented exception to the tier. Judging it a
		// violation would contradict the instruction the model was given — and it
		// is PROPOSED anyway, for being lens-authored rather than for being
		// off-tier.
		const result = normalizeDraftedTestCases(
			{
				testCases: [
					rawCase({
						title: "security e2e",
						coverageType: "E2E",
						scepticRole: "security",
					}),
				],
			},
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);

		expect(result[0]?.state).toBe("PROPOSED");
		expect(result[0]?.scepticRole).toBe("security");
	});

	it("fails safe when the model did not classify the case", () => {
		// An absent classification is not evidence of a violation. Treating it as
		// one would demote ordinary cases every time a model declined to answer.
		const result = normalizeDraftedTestCases(
			{ testCases: [rawCase({ title: "unclassified" })] },
			MAX_DRAFTED_TEST_CASES,
			"EASY",
		);

		expect(result[0]?.coverageType).toBeNull();
		expect(result[0]?.state).toBe("DRAFT");
	});

	it("runs no tier check at all when no tier was given", () => {
		// Every caller before the check existed passed no depth, and must keep
		// getting exactly what it got then.
		const result = normalizeDraftedTestCases({
			testCases: [rawCase({ title: "e2e", coverageType: "E2E" })],
		});

		expect(result[0]?.state).toBe("DRAFT");
	});

	it("takes the model's priority, mapped case-insensitively onto the enum", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({ title: "a", priority: "CRITICAL" }),
				rawCase({ title: "b", priority: "high" }),
				rawCase({ title: "c", priority: "  Low  " }),
				rawCase({ title: "d", priority: "MEDIUM" }),
			],
		});

		expect(result.map((c) => c.priority)).toEqual([
			"CRITICAL",
			"HIGH",
			"LOW",
			"MEDIUM",
		]);
	});

	it("falls back to MEDIUM for a priority the model invents, rather than failing the draft", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({ title: "a", priority: "P1" }),
				rawCase({ title: "b", priority: "" }),
				rawCase({ title: "c", priority: 3 }),
				rawCase({ title: "d", priority: undefined }),
				rawCase({ title: "e", priority: "highest possible" }),
			],
		});

		expect(result).toHaveLength(5);
		for (const testCase of result) {
			expect(testCase.priority).toBe("MEDIUM");
		}
	});

	it("keeps preconditions and the AC ref, trimming both", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({
					preconditions: "  Org Acme, user is a Viewer  ",
					acceptanceCriterionRef: "  AC 4  ",
				}),
			],
		});

		expect(result[0].preconditions).toBe("Org Acme, user is a Viewer");
		expect(result[0].acceptanceCriterionRef).toBe("AC 4");
	});

	it("nulls a blank/absent AC ref and bounds an over-long one", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({ title: "a", acceptanceCriterionRef: "   " }),
				rawCase({ title: "b", acceptanceCriterionRef: undefined }),
				rawCase({
					title: "c",
					acceptanceCriterionRef: "x".repeat(500),
				}),
			],
		});

		expect(result[0].acceptanceCriterionRef).toBeNull();
		expect(result[1].acceptanceCriterionRef).toBeNull();
		expect(result[2].acceptanceCriterionRef).toHaveLength(120);
	});

	it("tolerates omitted, empty, and wrong-typed fields without throwing", () => {
		expect(normalizeDraftedTestCases(undefined)).toEqual([]);
		expect(normalizeDraftedTestCases(null)).toEqual([]);
		expect(normalizeDraftedTestCases({})).toEqual([]);
		expect(
			normalizeDraftedTestCases({ testCases: "not-an-array" }),
		).toEqual([]);
		expect(
			normalizeDraftedTestCases({ testCases: [null, 42, "x"] }),
		).toEqual([]);

		// A case missing `steps` entirely, and one whose steps have non-string
		// fields, are handled (former dropped, latter coerced to "").
		const result = normalizeDraftedTestCases({
			testCases: [
				{ title: "No steps" },
				{
					title: "Coerced",
					steps: [{ action: 123, expected: null }, { action: "Go" }],
				},
			],
		});
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Coerced");
		// `{action:123, expected:null}` → both coerce to "" → dropped;
		// `{action:"Go"}` → kept with expected defaulted to "".
		expect(result[0].steps).toEqual([{ action: "Go", expected: "" }]);
		// A case that omits preconditions entirely still normalizes rather than
		// throwing — the prompt demands them, the schema cannot enforce them.
		expect(result[0].preconditions).toBe("");
	});

	it("trims strings and drops empty titles, empty steps, and step-less cases", () => {
		const result = normalizeDraftedTestCases({
			testCases: [
				rawCase({ title: "   " }), // empty title → drop
				rawCase({
					title: "Only blank steps",
					steps: [{ action: " ", expected: "" }],
				}), // no real steps → drop
				rawCase({
					title: "  Padded title  ",
					steps: [
						{ action: "  do thing  ", expected: "  see thing  " },
						{ action: "", expected: "" }, // empty step → drop
					],
				}),
			],
		});

		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Padded title");
		expect(result[0].steps).toEqual([
			{ action: "do thing", expected: "see thing" },
		]);
	});

	it("caps the count at MAX_DRAFTED_TEST_CASES and honors a smaller explicit cap", () => {
		const many = {
			testCases: Array.from({ length: 20 }, (_, i) =>
				rawCase({ title: `Case ${i}` }),
			),
		};

		expect(normalizeDraftedTestCases(many)).toHaveLength(
			MAX_DRAFTED_TEST_CASES,
		);
		expect(normalizeDraftedTestCases(many, 3)).toHaveLength(3);
		// An over-large cap clamps to the ABSOLUTE ceiling: explicit caps may
		// exceed the default 12 up to the ceiling, so per-criterion coverage
		// stays satisfiable. 20 < 30, so all 20 survive; a 40-case payload
		// clamps at the ceiling.
		expect(normalizeDraftedTestCases(many, 999)).toHaveLength(20);
		const tooMany = {
			testCases: Array.from({ length: 40 }, (_, i) =>
				rawCase({ title: `Case ${i}` }),
			),
		};
		expect(normalizeDraftedTestCases(tooMany, 999)).toHaveLength(
			ABSOLUTE_MAX_DRAFTED_TEST_CASES,
		);
		expect(normalizeDraftedTestCases(many, 0)).toHaveLength(1);
	});
});

describe("extractOpenQuestions", () => {
	it("collects the bullets under an open-questions heading", () => {
		expect(
			extractOpenQuestions(
				[
					"## Feature Narrative",
					"Some narrative.",
					"",
					"## Open Questions",
					"- Q: What is the quota ceiling?",
					"  - Why it matters: sizing",
					"",
					"## Dependencies",
					"- Billing service",
				].join("\n"),
			),
		).toBe("- Q: What is the quota ceiling?\n- Why it matters: sizing");
	});

	it("matches every heading the feature-drafting stages emit", () => {
		for (const heading of [
			"## Open Questions (Discovery)",
			"## Questions (Prioritized)",
			"### Critical & High Outstanding Questions",
		]) {
			expect(extractOpenQuestions(`${heading}\n- Q: Which role?`)).toBe(
				"- Q: Which role?",
			);
		}
	});

	it("skips the placeholder stage's Initial Questions draft list", () => {
		expect(
			extractOpenQuestions("## Initial Questions\n- Q: placeholder?"),
		).toBe("");
	});

	it("stops at a sibling or parent heading but keeps subheadings", () => {
		expect(
			extractOpenQuestions(
				[
					"## Open Questions",
					"- Q: one",
					"### Sub group",
					"- Q: two",
					"## Acceptance Criteria",
					"- AC 1: not a question",
				].join("\n"),
			),
		).toBe("- Q: one\n- Q: two");
	});

	it("returns empty for a body with no question section", () => {
		expect(extractOpenQuestions(null)).toBe("");
		expect(extractOpenQuestions(undefined)).toBe("");
		expect(extractOpenQuestions("## Scope\n- In scope: everything")).toBe(
			"",
		);
	});
});

describe("draftMaxOutputTokens", () => {
	it("scales with the case count so a full 12-case response is not truncated", () => {
		// The old flat budget was 2500 tokens, which cut a rich 12-case response
		// mid-object and surfaced as a schema failure.
		expect(draftMaxOutputTokens(MAX_DRAFTED_TEST_CASES)).toBe(5000);
		expect(draftMaxOutputTokens(MAX_DRAFTED_TEST_CASES)).toBeGreaterThan(
			2500,
		);
		expect(draftMaxOutputTokens(6)).toBe(2600);
	});

	it("floors small requests and clamps oversized ones", () => {
		expect(draftMaxOutputTokens(1)).toBe(1200);
		expect(draftMaxOutputTokens(0)).toBe(1200);
		// Beyond the ABSOLUTE ceiling the budget stops growing — the count is
		// clamped. (Deliberate contract change: callers that know the criteria
		// count may raise the cap past the default 12, up to the absolute
		// ceiling, so per-criterion coverage is satisfiable.)
		expect(draftMaxOutputTokens(999)).toBe(
			draftMaxOutputTokens(ABSOLUTE_MAX_DRAFTED_TEST_CASES),
		);
		expect(draftMaxOutputTokens(999)).toBeGreaterThan(
			draftMaxOutputTokens(MAX_DRAFTED_TEST_CASES),
		);
	});
});

// The stored AC blob shape observed on staging: criteria as one
// continuous numbered list, GROUPED under H3 sub-headings, followed by leaked
// sibling H2 sections that are NOT criteria.
const STAGED_AC_BLOB = `### Muting

1.  GIVEN a member WHEN they toggle mute on THEN the project is muted.

2.  GIVEN a member WHEN they set an auto-unmute date THEN it unmutes then.

### Digest Emails

3.  GIVEN a muted project WHEN the digest is generated THEN it is excluded.

## Release Planning

-   Rollout approach: TBD

-   Migration/backfill: none needed

## Release Notes

You can now mute notifications per project.`;

describe("boundAcceptanceCriteria", () => {
	it("truncates at the first H1/H2 sibling section, keeping H3 sub-groups", () => {
		const bounded = boundAcceptanceCriteria(STAGED_AC_BLOB);
		expect(bounded).toContain("### Muting");
		expect(bounded).toContain("### Digest Emails");
		expect(bounded).toContain("digest is generated");
		expect(bounded).not.toContain("Release Planning");
		expect(bounded).not.toContain("Rollout approach");
		expect(bounded).not.toContain("Release Notes");
	});

	it("returns the blob unchanged when no sibling section exists", () => {
		const clean = "- one criterion\n- another criterion";
		expect(boundAcceptanceCriteria(clean)).toBe(clean);
	});

	it("tolerates up to three leading spaces on the boundary heading", () => {
		expect(boundAcceptanceCriteria("- ac\n   ## Ops\n- leaked")).toBe(
			"- ac",
		);
	});

	it("treats a LEADING H2 as a heading of the criteria, not a boundary", () => {
		const blob =
			"## Acceptance Criteria\n- only item\n\n## Rollout\n- leaked";
		const bounded = boundAcceptanceCriteria(blob);
		expect(bounded).toContain("only item");
		expect(bounded).not.toContain("leaked");
	});
});

describe("countAcceptanceCriteria", () => {
	it("counts only the bounded list items — leaked bullets are excluded", () => {
		// 3 numbered criteria; the 2 "Rollout"/"Migration" bullets sit past the
		// H2 boundary and must not inflate the count (they would inflate the
		// maxTestCases spend ceiling).
		expect(countAcceptanceCriteria(STAGED_AC_BLOB)).toBe(3);
	});

	it("falls back to paragraph blocks when there is no list", () => {
		expect(
			countAcceptanceCriteria("Given A then B.\n\nGiven C then D."),
		).toBe(2);
	});

	it("excludes thematic breaks and letterless debris — lock-step with the QA matrix parser", () => {
		// `* * *` matches the bullet regex as marker `*` + content `* *`; it
		// must not count (it would size maxTestCases for a phantom criterion
		// the matrix no longer shows).
		expect(
			countAcceptanceCriteria(
				"- First criterion\n- Second criterion\n\n* * *\n- **",
			),
		).toBe(2);
		// Paragraph mode: an hr-only block is not a criterion either.
		expect(
			countAcceptanceCriteria(
				"Given A then B.\n\n---\n\nGiven C then D.",
			),
		).toBe(2);
	});
});

describe("test_case_drafter prompt resolution", () => {
	const readyModel = () => {
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: STUB_MODEL,
			metadata: STUB_METADATA,
			trackUsage: mockTrackUsage,
		});
		mockGenerateObject.mockResolvedValue({
			object: { testCases: [] },
			usage: STUB_USAGE,
		});
	};

	it("fallback body carries the QA instructions + non-escaped feature slots", () => {
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"senior QA engineer",
		);
		// Triple-stache so a feature body with <, & or quotes isn't HTML-escaped.
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"{{{featureDescription}}}",
		);
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"{{{openQuestions}}}",
		);
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"up to {{maxTestCases}}",
		);
	});

	it("fallback body demands the coverage the drafter was scored down for", () => {
		// Access + tenant isolation, grounded in the product's XOR tenant model.
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain("(XOR)");
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"without the required permission is denied",
		);
		// Test-design techniques.
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"just below it, and just above it",
		);
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"equivalence class",
		);
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"decision table",
		);
		// Negative / failure paths.
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"no partial write surviving",
		);
		// Non-falsifiable oracles are banned by name.
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"if the UI allows",
		);
		expect(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY).toContain(
			"meaningfully revised",
		);
	});

	it("renders the fallback body with truncated variables when the prompt is unbound", async () => {
		readyModel();

		await draftTestCases(
			{
				title: "Password reset",
				description: "x".repeat(10_000),
				acceptanceCriteria: null,
				maxTestCases: 50,
			},
			{ userId: "u1", organizationId: "o1" },
		);

		expect(mockRenderTemplate).toHaveBeenCalledTimes(1);
		const call = mockRenderTemplate.mock.calls[0][0];
		expect(call.template).toBe(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY);
		expect(call.variables.featureTitle).toBe("Password reset");
		expect(call.variables.acceptanceCriteria).toBe(
			"(no acceptance criteria provided)",
		);
		expect(call.variables.openQuestions).toBe("(none recorded)");
		// Oversized description truncated (…) and never passed whole.
		expect(call.variables.featureDescription.endsWith("...")).toBe(true);
		expect(call.variables.featureDescription).not.toBe("x".repeat(10_000));
		// Requested count clamped to the ABSOLUTE ceiling (deliberate contract
		// change).
		expect(call.variables.maxTestCases).toBe(
			String(ABSOLUTE_MAX_DRAFTED_TEST_CASES),
		);
	});

	it("surfaces open questions that fall past the description truncation cap", async () => {
		readyModel();
		// Open questions sit near the END of a generated feature body, so on a
		// real (long) description the truncated `featureDescription` never
		// reaches them. They must still arrive as their own coverage target.
		const description = [
			"## Feature Narrative",
			"lorem ipsum ".repeat(500),
			"## Open Questions",
			"- Q: What happens when the quota is exactly 0?",
		].join("\n");

		await draftTestCases(
			{ title: "Quotas", description },
			{ userId: "u1" },
		);

		const call = mockRenderTemplate.mock.calls[0][0];
		expect(call.variables.featureDescription).not.toContain(
			"quota is exactly 0",
		);
		expect(call.variables.openQuestions).toContain("quota is exactly 0");
	});

	it("prefers the bound SYSTEM prompt content over the fallback", async () => {
		readyModel();
		mockGetBoundPromptForAgent.mockResolvedValue({
			format: "HANDLEBARS",
			version: { content: "CUSTOM {{{featureTitle}}}" },
		});

		await draftTestCases({ title: "Auth" }, { userId: "u1" });

		const call = mockRenderTemplate.mock.calls[0][0];
		expect(call.template).toBe("CUSTOM {{{featureTitle}}}");
		expect(call.format).toBe("HANDLEBARS");
	});
});

describe("draftTestCases", () => {
	const readyModel = () => {
		mockGetAIModelWithMetadata.mockResolvedValue({
			model: STUB_MODEL,
			metadata: STUB_METADATA,
			trackUsage: mockTrackUsage,
		});
	};

	it("attributes the generation to the project it drafted for", async () => {
		// The usage row is stamped with whatever project scope reaches the
		// model resolver, and the same value decides whether project-scoped
		// usage limits apply. Dropping it does not lose the spend — it files
		// it under no project, so drafting bills the workspace while the
		// project's Usage tab stays flat and reads as "this run was free".
		readyModel();
		mockGenerateObject.mockResolvedValue({
			object: { testCases: [] },
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		await draftTestCases(
			{ title: "Quotas", acceptanceCriteria: "AC 1: enforce it" },
			{ userId: "u1", organizationId: "org1", projectId: "proj1" },
		);

		expect(mockGetAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: "u1",
				organizationId: "org1",
				projectId: "proj1",
			}),
		);
	});

	// Was "DRAFT-only". The AI may now also PROPOSE a case (when it attributes
	// one to a sceptic lens), so the invariant is that it never returns READY —
	// deciding a case is finished remains a person's call either way.
	it("normalizes model output to a non-READY state and records usage", async () => {
		readyModel();
		mockGenerateObject.mockResolvedValue({
			object: {
				testCases: [
					rawCase({
						title: "  Sign in works  ",
						preconditions: "  Org Acme, Admin role  ",
						acceptanceCriterionRef: "AC 1",
						priority: "critical",
						steps: [
							{
								action: " enter creds ",
								expected: " dashboard ",
							},
							{ action: "", expected: "" },
						],
					}),
					rawCase({ title: "" }),
				],
			},
			usage: STUB_USAGE,
		});

		const result = await draftTestCases(
			{
				title: "Auth",
				description: "Sign in flow",
				acceptanceCriteria: "AC1",
			},
			{ userId: "u1", organizationId: "o1", projectId: "p1" },
		);

		expect(result).toEqual([
			{
				title: "Sign in works",
				preconditions: "Org Acme, Admin role",
				acceptanceCriterionRef: "AC 1",
				// Not attributed to a sceptic lens, so it is an ordinary draft.
				scepticRole: null,
				state: "DRAFT",
				priority: "CRITICAL",
				automationStatus: "NOT_AUTOMATED",
				// The model did not classify this one, so it stays unset rather
				// than being guessed. The coverage matrix renders that as UNSET.
				coverageType: null,
				steps: [{ action: "enter creds", expected: "dashboard" }],
			},
		]);
		expect(mockTrackUsage).toHaveBeenCalledTimes(1);
		expect(mockLogModelUsageAsync).toHaveBeenCalledTimes(1);
		expect(mockLogModelUsageAsync.mock.calls[0][0]).toMatchObject({
			taskType: "COMPLEX",
			projectId: "p1",
		});
	});

	it("asks for a completion budget scaled to the requested case count", async () => {
		readyModel();
		mockGenerateObject.mockResolvedValue({
			object: { testCases: [] },
			usage: STUB_USAGE,
		});

		await draftTestCases(
			{ title: "Auth", maxTestCases: 12 },
			{ userId: "u1" },
		);

		expect(mockGenerateObject.mock.calls[0][0].maxOutputTokens).toBe(
			draftMaxOutputTokens(12),
		);
	});

	it("returns null when no AI provider is configured", async () => {
		mockGetAIModelWithMetadata.mockRejectedValue(
			new AIProviderNotConfiguredError("no provider"),
		);

		const result = await draftTestCases(
			{ title: "Auth" },
			{ userId: "u1" },
		);

		expect(result).toBeNull();
		expect(mockGenerateObject).not.toHaveBeenCalled();
		expect(mockLoggerWarn).not.toHaveBeenCalled();
	});

	it("re-throws (and logs) a genuine generation error instead of mislabelling it as no-provider", async () => {
		// A configured provider that fails at call time (billing/credits, rate
		// limit, auth) must NOT be collapsed into `null` — `null` means "no
		// provider configured" and would make the UI tell the user to configure a
		// provider they already have. The error propagates so the caller can
		// surface the real reason.
		readyModel();
		mockGenerateObject.mockRejectedValue(new Error("gateway exploded"));

		await expect(
			draftTestCases({ title: "Auth" }, { userId: "u1" }),
		).rejects.toThrow("gateway exploded");
		expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
		expect(mockLogModelUsageAsync).not.toHaveBeenCalled();
	});

	it("does NOT burn a retry on a failure a retry cannot fix", async () => {
		// Billing / rate-limit / auth failures are re-thrown on the first attempt:
		// re-asking the same provider only doubles the bill and the latency.
		readyModel();
		mockGenerateObject.mockRejectedValue(
			new Error("credit balance too low"),
		);

		await expect(
			draftTestCases({ title: "Auth" }, { userId: "u1" }),
		).rejects.toThrow("credit balance too low");
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
	});

	it("repairs a non-conforming completion with one retry, and logs the raw completion", async () => {
		readyModel();
		mockGenerateObject
			.mockRejectedValueOnce(
				new MockNoObjectGeneratedError({
					message: "response did not match schema",
					text: '{"testCases":[{"title":"cut off mid-ob',
					finishReason: "length",
				}),
			)
			.mockResolvedValueOnce({
				object: { testCases: [rawCase({ title: "Repaired" })] },
				usage: STUB_USAGE,
			});

		const result = await draftTestCases(
			{ title: "Auth" },
			{ userId: "u1" },
		);

		expect(result).toHaveLength(1);
		expect(result?.[0].title).toBe("Repaired");
		expect(mockGenerateObject).toHaveBeenCalledTimes(2);

		// The retry re-sends the prompt with a repair instruction appended.
		const retryPrompt = mockGenerateObject.mock.calls[1][0].prompt;
		expect(retryPrompt).toContain(TEST_CASE_DRAFTER_PROMPT_FALLBACK_BODY);
		expect(retryPrompt).toContain("could not be parsed");
		expect(retryPrompt).toContain(
			"return fewer test cases rather than an incomplete one",
		);

		// The raw completion is logged — it is the only way to tell a truncation
		// apart from a model that ignored the schema.
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			// No longer promises a retry: a rejection is now salvaged from the
			// text when it can be, and only re-asked when it cannot.
			"[test-case-drafting] structured output rejected",
			expect.objectContaining({
				finishReason: "length",
				rawCompletion: '{"testCases":[{"title":"cut off mid-ob',
			}),
		);
		// A repaired draft is a success — no "generation failed" log.
		expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
	});

	// Regression: observed live against a real provider. The model answered with
	// the right cases wrapped one level too deep, the schema refused it, and the
	// retry reproduced the same wrapper — so the run was billed twice and still
	// returned nothing. The text was already paid for and was perfectly good.
	it("recovers a wrapped completion from the text instead of paying for a retry", async () => {
		readyModel();
		mockGenerateObject.mockRejectedValueOnce(
			new MockNoObjectGeneratedError({
				message: "No object generated: response did not match schema.",
				// The exact shape seen in production: the envelope kept, the
				// payload stringified.
				text: JSON.stringify({
					testCases: JSON.stringify({
						testCases: [rawCase({ title: "Recovered from text" })],
					}),
				}),
				finishReason: "stop",
			}),
		);

		const result = await draftTestCases(
			{ title: "Auth" },
			{ userId: "u1" },
		);

		expect(result).toHaveLength(1);
		expect(result?.[0].title).toBe("Recovered from text");
		// The whole point: no second generation was bought.
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
	});

	// The exact live sequence, and the reason the salvage runs on BOTH attempts:
	// attempt 1 truncated to "{}" (nothing to mine, so the retry is right), and
	// the RETRY then came back with twelve good cases wrapped in a string. A
	// first-attempt-only salvage throws that away after paying for both.
	it("salvages the RETRY's completion when the first attempt truncated", async () => {
		readyModel();
		mockGenerateObject
			.mockRejectedValueOnce(
				new MockNoObjectGeneratedError({
					message:
						"No object generated: response did not match schema.",
					text: "{}",
					finishReason: "length",
				}),
			)
			.mockRejectedValueOnce(
				new MockNoObjectGeneratedError({
					message:
						"No object generated: response did not match schema.",
					text: JSON.stringify({
						testCases: JSON.stringify({
							testCases: [
								rawCase({ title: "Salvaged from retry" }),
							],
						}),
					}),
					finishReason: "stop",
				}),
			);

		const result = await draftTestCases(
			{ title: "Auth" },
			{ userId: "u1" },
		);

		expect(result).toHaveLength(1);
		expect(result?.[0].title).toBe("Salvaged from retry");
		// Still exactly two generations — the salvage never adds a third.
		expect(mockGenerateObject).toHaveBeenCalledTimes(2);
	});

	it("surfaces the error when the repair retry also fails", async () => {
		readyModel();
		mockGenerateObject.mockRejectedValue(
			new MockNoObjectGeneratedError({
				message: "No object generated: response did not match schema",
			}),
		);

		await expect(
			draftTestCases({ title: "Auth" }, { userId: "u1" }),
		).rejects.toThrow("response did not match schema");
		// Exactly one retry — never a loop.
		expect(mockGenerateObject).toHaveBeenCalledTimes(2);
	});
});

describe("describeQaPolicy", () => {
	it("falls back to neutral guidance with no policy", () => {
		expect(describeQaPolicy(undefined)).toContain("no project QA policy");
	});

	it("turns the stored enums into instructions a model can act on", () => {
		// "HARD" tells a model nothing; the prompt needs the consequence.
		const text = describeQaPolicy({
			strategyDepth: "HARD",
			evidencePolicy: "SCREENSHOT_REQUIRED",
			scepticRoles: ["security", "accessibility"],
		});
		expect(text).toContain("Go deep");
		expect(text).toContain("screenshotable");
		expect(text).toContain("security lens");
		expect(text).toContain("accessibility lens");
	});

	it("keeps the tier's own sentence when the project has not set a list", () => {
		// The load-bearing compatibility case. Every project that predates the
		// required-test-types control stores an empty list, and its prompt must
		// be exactly what it was before the control existed — including the
		// tier's proactivity wording, which a composed list sentence would lose.
		const before = describeQaPolicy({ strategyDepth: "EASY" });
		const after = describeQaPolicy({
			strategyDepth: "EASY",
			requiredTestTypes: [],
		});
		expect(after).toBe(before);
		expect(after).toContain("do not reach for");
	});

	it("treats a list identical to the tier as no override", () => {
		const tierWords = describeQaPolicy({ strategyDepth: "AVERAGE" });
		expect(
			describeQaPolicy({
				strategyDepth: "AVERAGE",
				requiredTestTypes: ["e2e", "functional", "integration"],
			}),
		).toBe(tierWords);
	});

	it("states an explicit list INSTEAD of the tier sentence, never beside it", () => {
		// Two sentences about which types to write is how a prompt comes to
		// contradict the settings page that produced it.
		const text = describeQaPolicy({
			strategyDepth: "EASY",
			requiredTestTypes: ["functional", "security"],
		});
		expect(text).toContain("This project requires these kinds of test");
		expect(text).toContain("functional/acceptance and security");
		expect(text).not.toContain("do not reach for integration");
	});

	it("still carries the tier's rigour sentence alongside an explicit list", () => {
		// Depth and required types answer different questions — how hard to look
		// versus what to look at — so overriding one must not silence the other.
		const text = describeQaPolicy({
			strategyDepth: "HARD",
			requiredTestTypes: ["functional"],
		});
		expect(text).toContain("Go deep");
		expect(text).toContain("This project requires these kinds of test");
	});

	it("omits sceptic lenses when none are enabled", () => {
		const text = describeQaPolicy({
			strategyDepth: "EASY",
			scepticRoles: [],
		});
		expect(text).toContain("Keep it light");
		expect(text).not.toContain("lens");
	});

	it("ignores role keys this build does not know", () => {
		const text = describeQaPolicy({ scepticRoles: ["from-a-newer-build"] });
		expect(text).toContain("no project QA policy");
	});

	// The depth tier has to change WHICH test types get written, not only how
	// thoroughly each one is explored. Settings ▸ Testing tells the reader that
	// Easy is functional-only and Hard reaches security and accessibility; these
	// four assertions are what make that claim true rather than decorative.
	it("restricts a light project to functional cases, and says so as an exclusion", () => {
		const text = describeQaPolicy({ strategyDepth: "EASY" });

		expect(text).toContain("functional/acceptance cases by default");
		// The exclusion carries the weight. Told only what to include, a model
		// reads the list as a floor and adds end-to-end and security cases back
		// in — which is exactly the behaviour this tier exists to avoid.
		expect(text).toContain(
			"do not reach for integration, end-to-end, security, performance or accessibility",
		);
	});

	// The contradiction this pins shut: roles used to be independent of depth and
	// defaulted to ALL FIVE ON, so a default project set to Easy was told not to
	// write security cases and then asked to apply a security lens, four times
	// over. The prompt carried a clause explaining the exception away.
	//
	// Depth now CAPS the roles (2026-07-31), so the contradiction cannot be
	// stated at all — and the capping happens inside `describeQaPolicy` as well
	// as at the call site, deliberately, because a broken sentence is a property
	// of the sentence rather than of whoever assembled the arguments.
	it("issues no lens a light tier excludes, so it cannot contradict itself", () => {
		const text = describeQaPolicy({
			strategyDepth: "EASY",
			scepticRoles: ["security", "performance", "accessibility"],
		});

		expect(text).not.toContain("a security lens");
		expect(text).not.toContain("a performance lens");
		expect(text).not.toContain("an accessibility lens");
		// No lens survived, so nothing dangles either.
		expect(text).not.toContain("Additionally apply");
	});

	it("keeps a lens the project explicitly required, even at a light tier", () => {
		// The escape hatch. Capping against the tier's DEFAULT rather than the
		// project's effective types would silently overrule somebody who ticked
		// the box, and they would have no way to get the lens back.
		const text = describeQaPolicy({
			strategyDepth: "EASY",
			requiredTestTypes: ["functional", "security"],
			scepticRoles: ["security", "performance"],
		});

		expect(text).toContain("a security lens");
		expect(text).not.toContain("a performance lens");
	});

	it("says nothing about exceptions when no lens is enabled", () => {
		// The override must not dangle. An Easy project with no sceptic roles
		// should read as a plain, unqualified scope restriction — a sentence
		// referring to lenses that are not there is noise the model has to
		// resolve, and the reason this clause rides with the lenses instead of
		// living in the tier text.
		const text = describeQaPolicy({
			strategyDepth: "EASY",
			scepticRoles: [],
		});

		expect(text).not.toContain("lens");
		expect(text).not.toContain("exceptions to the scope");
	});

	it("asks a deep project for security and accessibility dimensions", () => {
		const text = describeQaPolicy({ strategyDepth: "HARD" });

		expect(text).toContain("integration");
		expect(text).toContain("end-to-end");
		expect(text).toContain("security");
		expect(text).toContain("accessibility");
	});

	it("keeps the middle tier off security and accessibility unless asked", () => {
		const text = describeQaPolicy({ strategyDepth: "AVERAGE" });

		expect(text).toContain(
			"functional/acceptance, integration and end-to-end",
		);
		expect(text).toContain(
			"add a security, performance or accessibility case only where an acceptance criterion names one",
		);
	});

	it("keeps the exception clause out of the tier sentences entirely", () => {
		// Guards the split: the tier text must stay a plain scope statement so
		// it reads correctly with and without lenses.
		for (const depth of ["EASY", "AVERAGE", "HARD"]) {
			const withoutLenses = describeQaPolicy({
				strategyDepth: depth,
				scepticRoles: [],
			});
			expect(withoutLenses).not.toContain("lens");
		}
	});

	it("states scope and rigour as separate sentences", () => {
		// Two axes, deliberately not conflated: how hard to look, and where to
		// look at all. A tier that only changed the adjectives is the defect
		// this pairing fixes.
		const text = describeQaPolicy({ strategyDepth: "EASY" });

		expect(text).toContain("Keep it light");
		expect(text).toContain("functional/acceptance cases by default");
	});
});
