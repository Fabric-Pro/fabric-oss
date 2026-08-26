import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the assess-risks catch path.
 *
 * Historically the catch block returned a cryptic stub
 * (`"Risk assessment failed - manual review recommended"`) with no clue WHY
 * risk analysis failed. Users couldn't distinguish a bad API key from a
 * transient rate limit from a JSON parse error. These tests pin the new
 * behavior: the underlying error message is surfaced in `recommendations[0]`
 * (truncated to 240 chars to keep the recommendation card readable).
 *
 * Mocks `getAgentModelSync` + `withRetry` via `../utils` so we can
 * deterministically force the LLM call to throw without hitting the network.
 */

const invokeMock = vi.fn();

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return {
		...actual,
		getAgentModelSync: vi.fn(() => ({
			invoke: invokeMock,
		})),
		// withRetry: pass-through so the thrown error reaches the catch
		// without artificial delay. The real implementation already exhausts
		// retries before throwing, so this models the post-retry state.
		withRetry: vi.fn(async (fn: () => unknown) => fn()),
	};
});

// Import AFTER vi.mock so the node sees the stubbed util.
const { assessRisksNode } = await import("../nodes/assess-risks");

const baseState = {
	projectName: "Test Project",
	projectDescription: undefined,
	userStory: "build something",
	techStack: undefined,
	systemPrompt: undefined,
	tools: [],
	document: undefined,
	focusAnchor: undefined,
	currentStage: undefined,
	decomposedTasks: [
		{
			id: "t1",
			title: "Task 1",
			type: "feature",
			description: "stub",
			estimate: 1,
			priority: "medium",
			labels: [],
		},
	],
	riskAnalysis: undefined,
	dependencyGraph: undefined,
	executionPlan: undefined,
	messages: [],
	reasoningByTurn: {},
	error: undefined,
	retryCount: 0,
} as never;

describe("task-planner assessRisksNode — catch path surfaces error", () => {
	beforeEach(() => {
		invokeMock.mockReset();
	});

	it("includes the underlying error message in recommendations[0]", async () => {
		invokeMock.mockRejectedValueOnce(
			new Error("rate_limit_exceeded: 429 Too Many Requests"),
		);

		const command = await assessRisksNode(baseState);
		const update = (
			command as {
				update?: {
					riskAnalysis?: { recommendations?: string[] };
				};
			}
		).update;
		const rec = update?.riskAnalysis?.recommendations?.[0] ?? "";

		// Must NOT be the historical cryptic stub
		expect(rec).not.toBe(
			"Risk assessment failed - manual review recommended",
		);
		// Must reference the actual upstream error so the user can act
		expect(rec).toContain("rate_limit_exceeded");
		expect(rec).toContain("429");
		// Still labelled as a risk-analysis failure for context
		expect(rec.toLowerCase()).toContain("risk assessment");
	});

	it("truncates long error messages from the FRONT and keeps the actionable prefix", async () => {
		// Position-encoded payload (PR 1090 review I-3 fix). A previous
		// version of this test used `"x".repeat(600)` — but with all chars
		// identical, the test could not distinguish `slice(0, 240)` (correct:
		// keep prefix, drop tail) from `slice(-240)` (wrong: keep tail,
		// drop prefix). Provider error prefixes carry the actionable
		// information (`AuthenticationError: Incorrect API key provided…`)
		// so keeping the tail would silently regress UX.
		//
		// Each 5-char block is `"BLK<NNN>"` where NNN is the block index
		// (000..099), so the FIRST blocks are unambiguously identifiable.
		const blockCount = 100; // 500 chars total — well over the 240 cap
		const longError = Array.from(
			{ length: blockCount },
			(_, i) => `BLK${String(i).padStart(2, "0")}`,
		).join("");
		expect(longError.length).toBe(500);
		invokeMock.mockRejectedValueOnce(new Error(longError));

		const command = await assessRisksNode(baseState);
		const update = (
			command as {
				update?: {
					riskAnalysis?: { recommendations?: string[] };
				};
			}
		).update;
		const rec = update?.riskAnalysis?.recommendations?.[0] ?? "";

		// Ellipsis sentinel from the truncation branch (also pinned as a
		// named constant in the production code — keep both sides aligned).
		expect(rec).toContain("…");
		// The recommendation must be bounded — we allow some prefix overhead
		// (label + "Reason:" prose) but no more than ~400 chars total.
		expect(rec.length).toBeLessThan(400);
		// Direction pin: FIRST block ("BLK00") must be kept; LATER block
		// past the 240-char cap (e.g. "BLK60", well beyond 240/5 = 48) must
		// be dropped. If the implementation flips to slice(-240) this fails.
		expect(rec).toContain("BLK00");
		expect(rec).toContain("BLK01");
		expect(rec).not.toContain("BLK60");
		expect(rec).not.toContain("BLK99");
	});

	it("redacts API keys and bearer tokens before surfacing the error (PR 1090 review I-2)", async () => {
		// Provider/gateway SDKs sometimes echo the failing request inside
		// their error body — including auth headers. Surfacing that string
		// to the user (in `recommendations[0]` → A2A artifact → UI card)
		// would leak the customer's own credential. The catch path runs
		// every surfaced error through redactSecretsInError first.
		const sneakyError = new Error(
			"401 Unauthorized — request was Authorization: Bearer sk-proj-AbCdEf1234567890XyZ and api_key=sk-ant-OtherSecret9999999999",
		);
		invokeMock.mockRejectedValueOnce(sneakyError);

		const command = await assessRisksNode(baseState);
		const update = (
			command as {
				update?: {
					riskAnalysis?: { recommendations?: string[] };
				};
			}
		).update;
		const rec = update?.riskAnalysis?.recommendations?.[0] ?? "";

		// Token bodies must be gone
		expect(rec).not.toContain("sk-proj-AbCdEf1234567890XyZ");
		expect(rec).not.toContain("sk-ant-OtherSecret9999999999");
		// Redaction sentinel present
		expect(rec).toContain("[REDACTED]");
		// Non-secret context survives so the user still has actionable info
		expect(rec).toContain("401");
		expect(rec.toLowerCase()).toContain("unauthorized");
	});

	it("surfaces non-Error throws via String() coercion (defensive)", async () => {
		// Defense-in-depth: some library code throws plain strings or
		// objects. `error instanceof Error ? error.message : String(error)`
		// must still produce something readable.
		invokeMock.mockRejectedValueOnce("provider returned null");

		const command = await assessRisksNode(baseState);
		const update = (
			command as {
				update?: {
					riskAnalysis?: { recommendations?: string[] };
				};
			}
		).update;
		const rec = update?.riskAnalysis?.recommendations?.[0] ?? "";

		expect(rec).toContain("provider returned null");
		expect(rec.toLowerCase()).toContain("risk assessment");
	});

	it("still routes to build_dependencies (does not abort the graph)", async () => {
		invokeMock.mockRejectedValueOnce(new Error("boom"));

		const command = await assessRisksNode(baseState);
		const goto = (command as { goto?: string | string[] }).goto;
		const gotoStr = Array.isArray(goto) ? goto[0] : goto;
		// Aborting the graph here would deny the user any output — the rest
		// of the planner (build_dependencies, generate_document) can produce
		// a useful plan without risk analysis, so the catch path MUST keep
		// the graph moving.
		expect(gotoStr).toBe("build_dependencies");
	});
});
