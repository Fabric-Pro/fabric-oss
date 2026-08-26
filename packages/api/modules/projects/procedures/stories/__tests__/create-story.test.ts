/**
 * Unit tests for `createStoryProcedure`.
 *
 * Mocks the AI title-generator helper, `createStoryFromProposal`, and the
 * lifecycle dispatcher so the procedure handler can be invoked directly.
 *
 * Covers:
 *   - Title omitted → procedure calls the generator, persists resolvedTitle,
 *     aiGeneratedTitle = true, titleSource = AI on the row.
 *   - Generator throws (mock) → story still created; titleSource =
 *     DESCRIPTION_FALLBACK, aiGeneratedTitle = false.
 *   - Telemetry update throws → story creation still succeeds; logger.warn fires.
 *   - Regression: title provided → no generator call; aiGeneratedTitle = false;
 *     titleSource = null.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		generateStoryTitleFromDescription: vi.fn(),
		createStoryFromProposal: vi.fn(),
		dispatchLifecycleEvent: vi.fn(),
		userStoryUpdate: vi.fn(),
		loggerWarn: vi.fn(),
		maybeAutoDraftOnStageChange: vi.fn(),
	};
	return { handlers, mocks };
});

// Mocked at the trigger so this suite never loads the Temporal client behind it.
vi.mock("../../../lib/auto-draft-test-cases", () => ({
	maybeAutoDraftOnStageChange: mocks.maybeAutoDraftOnStageChange,
}));

vi.mock("@repo/ai/lib/story-title-generator", () => ({
	generateStoryTitleFromDescription: mocks.generateStoryTitleFromDescription,
	mapStoryTitleSourceToEnum: (source: string) => {
		switch (source) {
			case "ai":
				return "AI";
			case "description-fallback":
				return "DESCRIPTION_FALLBACK";
			case "untitled-fallback":
				return "UNTITLED_FALLBACK";
			default:
				return null;
		}
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: { update: mocks.userStoryUpdate },
	},
	StoryKindSchema: z.enum(["FEATURE", "BUG"]),
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
}));

vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.create = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

vi.mock("../../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

await import("../create-story");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const baseInput = {
	projectId: "project-1",
	organizationId: null,
	description: "Users need a button to log in via Google or Microsoft SSO.",
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.createStoryFromProposal.mockResolvedValue({
		story: {
			id: "story-1",
			title: "Add SSO login",
			statusId: "status-1",
		},
		aiDrafted: false,
	});
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.dispatchLifecycleEvent.mockResolvedValue({});
	// `runInBackground` hands this to `waitUntil`, which rejects anything that
	// is not a Promise — a bare `vi.fn()` returning undefined throws there.
	mocks.maybeAutoDraftOnStageChange.mockResolvedValue(undefined);
});

describe("createStoryProcedure — title generation", () => {
	it("title omitted → calls generator, persists resolvedTitle + AI metadata", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Add SSO login",
			source: "ai",
		});

		await handlers.create({ input: baseInput, context: ctx });

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			baseInput.description.trim(),
			"FEATURE",
			expect.objectContaining({
				userId: "user-1",
				projectId: "project-1",
				// 2026-05-14 spec: manual UI submits with creationSource="UI",
				// no originContext (no chat surface), no projectName.
				creationSource: "UI",
				originContext: undefined,
				projectName: undefined,
			}),
		);

		// resolvedTitle flows into createStoryFromProposal
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Add SSO login" }),
		);

		// telemetry persistence: aiGeneratedTitle = true, titleSource = AI
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: { aiGeneratedTitle: true, titleSource: "AI" },
		});

		// lifecycle event includes the new fields
		expect(mocks.dispatchLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					aiGeneratedTitle: true,
					titleSource: "ai",
				}),
			}),
		);
	});

	it("generator returns description-fallback → titleSource = DESCRIPTION_FALLBACK, aiGeneratedTitle = false", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: baseInput.description,
			source: "description-fallback",
		});

		await handlers.create({ input: baseInput, context: ctx });

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				aiGeneratedTitle: false,
				titleSource: "DESCRIPTION_FALLBACK",
			},
		});
	});

	it("telemetry update throws → story creation still succeeds; logger.warn fires", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Add SSO login",
			source: "ai",
		});
		mocks.userStoryUpdate.mockRejectedValueOnce(
			new Error("DB write failed"),
		);

		const result = await handlers.create({
			input: baseInput,
			context: ctx,
		});

		// Story creation completed (the procedure returned)
		expect(result).toEqual(
			expect.objectContaining({
				story: expect.objectContaining({ id: "story-1" }),
			}),
		);
		// telemetry failure was warned, not thrown
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("AI-title telemetry"),
			expect.any(Error),
		);
	});

	it("title provided → no generator call; aiGeneratedTitle = false; titleSource = null", async () => {
		await handlers.create({
			input: { ...baseInput, title: "User-supplied title" },
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ title: "User-supplied title" }),
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: { aiGeneratedTitle: false, titleSource: null },
		});
	});

	it("title omitted, description also empty → generator still invoked with empty string (untitled fallback path)", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Untitled feature",
			source: "untitled-fallback",
		});

		await handlers.create({
			input: { projectId: "project-1", organizationId: null },
			context: ctx,
		});

		expect(mocks.generateStoryTitleFromDescription).toHaveBeenCalledWith(
			"",
			"FEATURE",
			expect.any(Object),
		);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				aiGeneratedTitle: false,
				titleSource: "UNTITLED_FALLBACK",
			},
		});
	});

	it("generator returns untitled-fallback with isInsufficient=false (system-failure path) → titleSource UNTITLED_FALLBACK", async () => {
		// 2026-05-14 spec §7.1: isInsufficient flag flows through
		// logModelUsageAsync metadata, NOT through UserStory columns. Both
		// is_insufficient and system failures persist the same row shape.
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Untitled – 2026-05-14 12:00",
			source: "untitled-fallback",
			isInsufficient: false,
		});

		await handlers.create({ input: baseInput, context: ctx });

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				aiGeneratedTitle: false,
				titleSource: "UNTITLED_FALLBACK",
			},
		});
	});

	it("generator returns untitled-fallback with isInsufficient=true → same row shape (flag is metadata-only)", async () => {
		mocks.generateStoryTitleFromDescription.mockResolvedValue({
			title: "Untitled – 2026-05-14 12:00",
			source: "untitled-fallback",
			isInsufficient: true,
		});

		await handlers.create({ input: baseInput, context: ctx });

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				aiGeneratedTitle: false,
				titleSource: "UNTITLED_FALLBACK",
			},
		});
	});
});

describe("createStoryProcedure — auto-draft on creation", () => {
	// A feature can be CREATED at Ready for Dev: the input accepts a stage AND
	// acceptance criteria. No stage procedure ever runs for it, so if this call
	// site is wrong the feature arrives eligible and nothing ever drafts — the
	// original reported symptom, through the one door with no transition.
	it("runs the trigger with the stage the story was created at", async () => {
		mocks.createStoryFromProposal.mockResolvedValue({
			story: {
				id: "story-1",
				title: "Add SSO login",
				statusId: "status-1",
				draftingStage: "PUBLISHED",
			},
			aiDrafted: false,
		});

		await handlers.create({
			// Title supplied so the generator is not part of this test.
			input: {
				...baseInput,
				title: "Add SSO login",
				draftingStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(mocks.maybeAutoDraftOnStageChange).toHaveBeenCalledWith({
			projectId: "project-1",
			storyId: "story-1",
			userId: "user-1",
			// Nothing existed before — that is what makes this the creation case
			// rather than a transition.
			previousStage: null,
			targetStage: "PUBLISHED",
		});
	});

	it("reads the stage off the created record, not the request", async () => {
		// The request is only a hint; the record is what the feature actually
		// landed on. Taking the input would mis-fire whenever they differ.
		mocks.createStoryFromProposal.mockResolvedValue({
			story: {
				id: "story-1",
				title: "Add SSO login",
				statusId: "status-1",
				draftingStage: "DRAFT",
			},
			aiDrafted: false,
		});

		await handlers.create({
			input: {
				...baseInput,
				title: "Add SSO login",
				draftingStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(mocks.maybeAutoDraftOnStageChange).toHaveBeenCalledWith(
			expect.objectContaining({ targetStage: "DRAFT" }),
		);
	});
});
