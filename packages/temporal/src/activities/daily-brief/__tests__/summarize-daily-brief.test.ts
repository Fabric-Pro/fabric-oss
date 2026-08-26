/**
 * Tests for `summarizeDailyBriefActivity` — function-tag role clause splice.
 *
 * `buildPrompt()` itself is pure and untouched by Stage 4 (this surface has
 * no pre-existing locked-attachment clause); the splice lives in the async
 * activity, between `buildPrompt(...)` and the `generateObject()` call, and
 * is asserted here through the prompt `generateObject` actually receives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getCurrentDateContext: vi.fn(),
	logModelUsageAsync: vi.fn(),
	getProjectFunctionTagClause: vi.fn(),
	heartbeat: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	getCurrentDateContext: mocks.getCurrentDateContext,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
	ApplicationFailure: {
		nonRetryable: (message: string, type: string) => {
			const err = new Error(message) as Error & {
				type: string;
				nonRetryable: boolean;
			};
			err.type = type;
			err.nonRetryable = true;
			return err;
		},
	},
}));

const { summarizeDailyBriefActivity } = await import(
	"../summarize-daily-brief"
);

const baseInput = {
	projectId: "project-1",
	organizationId: null,
	userId: "user-1",
	timeWindowStart: new Date("2026-07-13T00:00:00Z"),
	timeWindowEnd: new Date("2026-07-20T00:00:00Z"),
	sections: {
		github: [
			{
				occurredAt: new Date("2026-07-14T00:00:00Z"),
				title: "Fix bug",
				kind: "pr_opened" as const,
				prNumber: 1,
				repoFullName: "acme/web",
				url: "https://github.com/acme/web/pull/1",
			},
		],
	},
	priorityActions: [],
	partialFailures: [],
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {
			modelString: "test-model",
			provider: "test",
			selectionSource: "test",
		},
		trackUsage: mocks.trackUsage,
	});
	mocks.getCurrentDateContext.mockReturnValue("Today is 2026-07-20.");
	mocks.generateObject.mockResolvedValue({
		object: {
			executiveSummary: "A concise summary.",
			storylineNarratives: [],
			priorityActionExplanations: [],
		},
		usage: { totalTokens: 10 },
	});
	// Fizzy #1767 Stage 4: default to flag-OFF (no clause) so any test that
	// doesn't override this keeps asserting the pre-Stage-4 prompt shape.
	mocks.getProjectFunctionTagClause.mockResolvedValue("");
});

describe("summarizeDailyBriefActivity — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-summarize-daily-brief";

	it("flag ON: resolves the role clause with the input's project/user and appends it to the final prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await summarizeDailyBriefActivity({ ...baseInput });

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: "project-1",
			requesterUserId: "user-1",
			surface: "daily-brief",
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt;
		expect(prompt).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await summarizeDailyBriefActivity({ ...baseInput });
		const withClause = mocks.generateObject.mock.calls[0][0].prompt;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateObject.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await summarizeDailyBriefActivity({ ...baseInput });
		const withoutClause = mocks.generateObject.mock.calls[0][0].prompt;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});

describe("summarizeDailyBriefActivity — usage attribution (Fizzy #1894)", () => {
	it("resolves the model with the project scope and the daily-brief job label", async () => {
		await summarizeDailyBriefActivity({ ...baseInput });

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{
				userId: "user-1",
				organizationId: undefined,
				projectId: "project-1",
				jobType: "daily-brief",
			},
		);
	});
});

describe("summarizeDailyBriefActivity — prompt-cache-stable prefix (date + window placement)", () => {
	it("opens with the stable instruction text, not the per-run window, and places the date context then the window after the static rules", async () => {
		await summarizeDailyBriefActivity({ ...baseInput });

		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;

		// The window used to be interpolated straight into the opening
		// sentence, fragmenting the shared cacheable prefix on every run.
		expect(
			prompt.startsWith("You are writing a morning Daily Brief."),
		).toBe(true);
		expect(prompt).not.toMatch(
			/^You are writing a morning Daily Brief\. Cover/,
		);

		// Index comparison, not just toContain — date then window must both
		// land strictly after the static Rules block.
		const rulesIndex = prompt.indexOf("Rules:");
		const dateIndex = prompt.indexOf("Today is 2026-07-20.");
		const windowIndex = prompt.indexOf(
			"Activity window: 2026-07-13T00:00:00.000Z to 2026-07-20T00:00:00.000Z.",
		);

		expect(rulesIndex).toBeGreaterThan(0);
		expect(dateIndex).toBeGreaterThan(rulesIndex);
		expect(windowIndex).toBeGreaterThan(dateIndex);
	});
});
