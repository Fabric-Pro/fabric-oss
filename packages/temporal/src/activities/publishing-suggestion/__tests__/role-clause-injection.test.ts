/**
 * Tests for `summarizeTopicSuggestions` — function-tag role clause splice
 * (Publishing Suite 1B FR2 / Fizzy #1767).
 *
 * `buildTopicSuggestionPrompt()` itself is untouched by FR2; the splice lives
 * in the async activity, between `buildTopicSuggestionPrompt(...)` and the
 * `generateObject()` call, and is asserted here through the prompt
 * `generateObject` actually receives.
 *
 * This is a SEPARATE module from `@repo/ai` (mocked in the sibling
 * `summarize-topic-suggestions.test.ts`), so it needs its own `vi.mock`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so the heartbeat interval needs
// Context mocked (mirrors the sibling summarize-topic-suggestions test).
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

const generateObject = vi.fn();
const getAIModelWithMetadata = vi.fn();
const logModelUsageAsync = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
	logModelUsageAsync: (...a: unknown[]) => logModelUsageAsync(...a),
}));

const { clause } = vi.hoisted(() => ({ clause: vi.fn() }));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: clause,
}));

const mockIsCurrentOrgMember = vi.fn();
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		isCurrentOrgMember: (...a: unknown[]) => mockIsCurrentOrgMember(...a),
	};
});

import { summarizeTopicSuggestions } from "../summarize-topic-suggestions";

const trackUsage = vi.fn();

function stubModel() {
	getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model", provider: "test" },
		trackUsage,
	});
}

beforeEach(() => {
	generateObject.mockReset();
	getAIModelWithMetadata.mockReset();
	logModelUsageAsync.mockReset();
	mockIsCurrentOrgMember.mockReset();
	mockIsCurrentOrgMember.mockResolvedValue(true);
	trackUsage.mockReset();
	clause.mockReset();
	// Default to flag-OFF (no clause) so any test that doesn't override this
	// keeps asserting the pre-FR2 prompt shape.
	clause.mockResolvedValue("");
	stubModel();
	generateObject.mockResolvedValue({
		object: { topics: [] },
		usage: { totalTokens: 1 },
	});
});

describe("summarizeTopicSuggestions — function-tag role clause (FR2 / Fizzy #1767)", () => {
	it("appends the resolved role clause to the prompt handed to generateObject when the helper returns a non-empty string", async () => {
		clause.mockResolvedValue("ROLE CONTEXT: alice is an ENGINEER.");

		await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: {},
		});

		expect(clause).toHaveBeenCalledWith({
			projectId: "proj-a",
			requesterUserId: "user-1",
			surface: "publishing-suite",
		});
		const callArgs = generateObject.mock.calls[0][0] as { prompt: string };
		expect(
			callArgs.prompt.endsWith("ROLE CONTEXT: alice is an ENGINEER."),
		).toBe(true);
	});

	it("leaves the prompt unchanged when the helper resolves to an empty string", async () => {
		clause.mockResolvedValue("");

		await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: {},
		});

		const withoutClause = generateObject.mock.calls[0][0].prompt;

		// Re-run with a non-empty clause from an otherwise-identical invocation
		// to prove the base prompt is byte-for-byte identical (no dangling
		// separator) when the clause is absent.
		generateObject.mockClear();
		clause.mockResolvedValue("ROLE CONTEXT: sentinel");
		await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: {},
		});
		const withClause = generateObject.mock.calls[0][0].prompt;

		expect(withoutClause).not.toContain("ROLE CONTEXT:");
		expect(withClause).toBe(`${withoutClause}\n\nROLE CONTEXT: sentinel`);
	});
});
