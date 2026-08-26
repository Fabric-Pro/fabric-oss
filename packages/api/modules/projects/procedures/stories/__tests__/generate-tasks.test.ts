/**
 * FR-25: the "generate tasks" flow receives the feature body
 * (title/description/AC) and must carry the shared locked-attachment rule so a
 * generated task never claims to have seen or analysed a locked attachment.
 * `buildTaskGenerationPrompt` is the pure prompt assembler; the procedure
 * module's oRPC/DB deps are stubbed so this stays a hermetic unit test.
 *
 * Fizzy #1767 Stage 4: `generateTasksProcedure`'s handler also splices the
 * project's function-tag role-composition clause onto the pure
 * `buildTaskGenerationPrompt(story)` output before handing it to the AI call
 * (`generateTasksWithAI` → `generateText`). The handler is wired via the same
 * `handlers.generateTasks = fn` capture pattern used by the other story
 * procedure test files so this file can invoke it directly and inspect the
 * prompt actually sent to the model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		userStoryFindFirst: vi.fn(),
		generateTaskIdentifier: vi.fn(),
		storyTaskCreate: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		generateText: vi.fn(),
		getProjectFunctionTagClause: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@orpc/client", () => ({ ORPCError: class extends Error {} }));
vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
}));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: mocks.getProjectFunctionTagClause,
}));
vi.mock("ai", () => ({
	generateText: mocks.generateText,
}));
vi.mock("@repo/database", () => ({
	db: {
		userStory: { findFirst: mocks.userStoryFindFirst },
		storyTask: { create: mocks.storyTaskCreate },
	},
	generateTaskIdentifier: mocks.generateTaskIdentifier,
}));
vi.mock("@repo/payments", () => ({
	AiCreditLimitExceededError: class extends Error {},
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.generateTasks = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
	};
});

const { buildTaskGenerationPrompt } = await import("../generate-tasks");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const PROJECT_ID = "project-gt";
const STORY_ID = "story-gt";

function storyFixture() {
	return {
		id: STORY_ID,
		projectId: PROJECT_ID,
		title: "Add MFA",
		description: "Add MFA support.",
		acceptanceCriteria: null,
		identifier: "F-1",
		tasks: [],
	};
}

describe("buildTaskGenerationPrompt — the locked-attachment rule", () => {
	it("includes the DEDICATED ATTACHMENTS scope marker", () => {
		const prompt = buildTaskGenerationPrompt({
			identifier: "F-1",
			title: "MFA",
			description: "Add MFA.",
			acceptanceCriteria: null,
		});
		expect(prompt).toContain("DEDICATED ATTACHMENTS");
	});
});

describe("generateTasksProcedure — function-tag role clause (Fizzy #1767 Stage 4)", () => {
	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
		mocks.userStoryFindFirst.mockResolvedValue(storyFixture());
		mocks.getAIModelWithMetadata.mockResolvedValue({
			model: { id: "stub-model" },
			metadata: { providerKey: "stub" },
		});
		mocks.generateText.mockResolvedValue({ text: "[]" });
		mocks.generateTaskIdentifier.mockResolvedValue("T-1");
		mocks.storyTaskCreate.mockResolvedValue({ id: "task-1" });

		// Fizzy #1767 Stage 4: default to flag-OFF (no clause).
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
	});

	const ROLE_CLAUSE_SENTINEL =
		"PROJECT CONTRIBUTOR ROLES — sentinel-test-clause-generate-tasks";

	it("flag ON: resolves the role clause with the story's project/user and appends it to the AI prompt", async () => {
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);

		await handlers.generateTasks({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.getProjectFunctionTagClause).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			requesterUserId: "user-1",
			surface: "generate-tasks",
		});
		const prompt = mocks.generateText.mock.calls[0][0].prompt as string;
		expect(prompt).toContain(ROLE_CLAUSE_SENTINEL);
	});

	it("flag OFF: prompt is byte-for-byte identical to the no-clause assembly (no dangling separator)", async () => {
		// Capture the with-clause shape first...
		mocks.getProjectFunctionTagClause.mockResolvedValue(
			ROLE_CLAUSE_SENTINEL,
		);
		await handlers.generateTasks({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});
		const withClause = mocks.generateText.mock.calls[0][0].prompt as string;

		// ...then the flag-OFF shape, from an otherwise-identical invocation.
		mocks.generateText.mockClear();
		mocks.getProjectFunctionTagClause.mockResolvedValue("");
		await handlers.generateTasks({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				organizationId: null,
			},
			context: ctx,
		});
		const withoutClause = mocks.generateText.mock.calls[0][0]
			.prompt as string;

		expect(withoutClause).not.toContain(ROLE_CLAUSE_SENTINEL);
		expect(withoutClause).toBe(
			buildTaskGenerationPrompt(
				storyFixture() as unknown as Parameters<
					typeof buildTaskGenerationPrompt
				>[0],
			),
		);
		// The splice is `buildTaskGenerationPrompt(story) + (roleClause ? "\n\n"
		// + roleClause : "")` — so the no-clause prompt must be exactly the
		// with-clause prompt minus its trailing "\n\n" + sentinel.
		expect(withClause).toBe(`${withoutClause}\n\n${ROLE_CLAUSE_SENTINEL}`);
	});
});
