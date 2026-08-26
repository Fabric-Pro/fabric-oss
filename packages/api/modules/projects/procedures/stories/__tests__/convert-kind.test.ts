/**
 * Unit tests for `convertStoryKindProcedure`.
 *
 * Covers the flip itself (kind + the DRAFT stage snap), the two tenant questions
 * the procedure has to answer before it reads anything, the regeneration it now
 * starts, and the job row the front end polls.
 *
 * Mocks `@repo/database`, `@repo/temporal` and the oRPC procedure base so the
 * raw handler is invoked directly.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		updateStory: vi.fn(),
		userStoryFindUnique: vi.fn(),
		projectFindUnique: vi.fn(),
		createBackgroundJob: vi.fn(),
		failBackgroundJob: vi.fn(),
		requireOrganizationMembership: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findUnique: mocks.userStoryFindUnique },
		project: { findUnique: mocks.projectFindUnique },
	},
	updateStory: mocks.updateStory,
	createBackgroundJob: mocks.createBackgroundJob,
	failBackgroundJob: mocks.failBackgroundJob,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.convertKind = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requireOrganizationMembership: mocks.requireOrganizationMembership,
	};
});

// Trigger registration of the handler by importing the procedure module.
import "../convert-kind";

const baseContext = {
	user: { id: "user-1", name: "Alice" },
	session: {},
};

const baseInput = {
	projectId: "proj-1",
	storyId: "story-1",
	organizationId: null,
	targetKind: "BUG" as const,
};

/** The deterministic per-item id the dedup relies on. */
const WORKFLOW_ID = "regenerate-body-for-kind-story-1";

/** Options bag `client.workflow.start` was called with. */
function startOptions(call = 0) {
	return mocks.workflowStart.mock.calls[call]?.[1] as {
		taskQueue: string;
		workflowId: string;
		args: Array<Record<string, unknown>>;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: null });
	mocks.workflowStart.mockResolvedValue({ firstExecutionRunId: "run-1" });
	mocks.createBackgroundJob.mockResolvedValue("job-1");
});

describe("convertStoryKindProcedure — the flip", () => {
	it("flips kind FEATURE → BUG and snaps draftingStage to DRAFT", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "SANITY_CHECK",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			draftingStage: "DRAFT",
		});

		const result = await handlers.convertKind({
			input: baseInput,
			context: baseContext,
		});

		expect(mocks.updateStory).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			expect.objectContaining({ kind: "BUG", draftingStage: "DRAFT" }),
			expect.objectContaining({
				userId: "user-1",
				changedBy: "user-1",
				changeDescription: expect.stringContaining("FEATURE"),
			}),
		);
		expect((result as { story: { kind: string } }).story.kind).toBe("BUG");
	});

	it("flips kind BUG → FEATURE and snaps draftingStage to DRAFT", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			title: "Add a bulk export",
			draftingStage: "PLACEHOLDER",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			draftingStage: "DRAFT",
		});

		const result = await handlers.convertKind({
			input: { ...baseInput, targetKind: "FEATURE" as const },
			context: baseContext,
		});

		expect(mocks.updateStory).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			expect.objectContaining({
				kind: "FEATURE",
				draftingStage: "DRAFT",
			}),
			expect.any(Object),
		);
		expect((result as { story: { kind: string } }).story.kind).toBe(
			"FEATURE",
		);
	});

	/**
	 * The stage snap is not cosmetic: the per-kind stage envelope differs, so a
	 * feature sitting in a feature-only stage would be invalid the moment it
	 * became a bug. DRAFT is valid for both.
	 */
	it("snaps the drafting stage so the item cannot land in a stage invalid for its new type", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Passive analysis feature",
			draftingStage: "PASSIVE_ANALYSIS",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });

		await handlers.convertKind({ input: baseInput, context: baseContext });

		const payload = mocks.updateStory.mock.calls[0]?.[2] as Record<
			string,
			unknown
		>;
		expect(payload.draftingStage).toBe("DRAFT");
	});

	it("throws NOT_FOUND when the story doesn't exist, and starts nothing", async () => {
		mocks.userStoryFindUnique.mockResolvedValue(null);

		await expect(
			handlers.convertKind({
				input: baseInput,
				context: baseContext,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.createBackgroundJob).not.toHaveBeenCalled();
	});
});

describe("convertStoryKindProcedure — the regeneration", () => {
	/**
	 * ═══════════════════════════════════════════════════════════════════════
	 * A DELIBERATE CONTRACT CHANGE — NOT A WEAKENED TEST.
	 *
	 * This replaces a test named "leaves the body columns untouched — conversion
	 * re-chains no prompt", whose assertion was an EXACT key-set match on the
	 * update payload (`expect(Object.keys(payload).sort()).toEqual(["draftingStage",
	 * "kind"])`) precisely so that any added field would fail it.
	 *
	 * That test was correct for the decision it pinned. F-171 explicitly put
	 * prompt re-chaining on convert out of scope: the new type was to govern the
	 * NEXT AI action, not this one, and the test existed so that a later change
	 * "helpfully" regenerating the body would be caught rather than welcomed.
	 *
	 * Under Fizzy #2048 the PRODUCT OWNER REVERSED THAT DECISION. An item whose
	 * type changed still reading in the old type's shape is the complaint the
	 * ticket was reopened for. Conversion now regenerates the body — so the old
	 * assertion pins a rule the product no longer has, and keeping it would block
	 * the feature it was written to protect.
	 *
	 * This repository's guidance tells reviewers to default to "the test caught a
	 * real issue" before touching an assertion. That default is right, and it is
	 * being overridden here explicitly and on the record: the source is the new
	 * source of truth, the reversal is the requirement, and the replacement below
	 * pins the NEW behaviour just as tightly — the write is still narrow (the
	 * regeneration writes the body, this handler does not), and the rewrite is
	 * asserted to actually start.
	 * ═══════════════════════════════════════════════════════════════════════
	 */
	it("starts the regeneration with the target kind and opens a job row — conversion now rewrites the body", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "SANITY_CHECK",
			description: "## User Story\n\nAs a user…",
			acceptanceCriteria: "- The editor opens",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });

		await handlers.convertKind({ input: baseInput, context: baseContext });

		// The rewrite is asynchronous and lands from the workflow, so THIS write
		// still touches only the type and the stage. What changed is that a
		// rewrite is now started at all.
		const payload = mocks.updateStory.mock.calls[0]?.[2] as Record<
			string,
			unknown
		>;
		expect(Object.keys(payload).sort()).toEqual(["draftingStage", "kind"]);

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart.mock.calls[0]?.[0]).toBe(
			"regenerateBodyForKindWorkflow",
		);
		expect(startOptions().args[0]).toEqual(
			expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				targetKind: "BUG",
			}),
		);

		expect(mocks.createBackgroundJob).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "STORY_KIND_REGENERATION",
				projectId: "proj-1",
				userId: "user-1",
				workflowId: WORKFLOW_ID,
				sourceId: "story-1",
			}),
		);
	});

	/**
	 * The redraft resolves the template binding AND the AI model settings in the
	 * tenant's scope, and the log needs to say which surface asked for it —
	 * NFR1's "from which entry point" has no other source than these arguments.
	 */
	it("carries the project's organization, the user, the target kind and the entry point in the workflow argument", async () => {
		mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-A" });
		mocks.requireOrganizationMembership.mockResolvedValue({
			role: "member",
		});
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });

		await handlers.convertKind({
			input: { ...baseInput, organizationId: "org-A" },
			context: baseContext,
		});

		expect(startOptions().args[0]).toEqual({
			storyId: "story-1",
			projectId: "proj-1",
			organizationId: "org-A",
			userId: "user-1",
			targetKind: "BUG",
			entryPoint: "typeConversionRegeneration",
		});
	});

	/**
	 * Started on the queue that serves interactive AI paths, under a
	 * deterministic per-item id — the id is what claims the slot.
	 */
	it("starts on the ai-chat queue under a deterministic per-item workflow id", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });

		await handlers.convertKind({ input: baseInput, context: baseContext });

		expect(startOptions().taskQueue).toBe("ai-chat");
		expect(startOptions().workflowId).toBe(WORKFLOW_ID);
	});

	/**
	 * Fizzy #2048 (FR4): the LAST type selected is the one that gets regenerated,
	 * however many times the user toggled.
	 *
	 * The deterministic workflow id caps concurrency at one redraft per item —
	 * without it, alternating an item's type queues an unbounded series of
	 * minute-long model calls on a shared queue. But the newest start must win
	 * rather than be refused: an in-flight redraft was written against the type
	 * the user has since moved away from, and the activity's version guard
	 * discards it when it lands. Refuse-then-discard would leave the item on its
	 * NEW type carrying its OLD type's body — the exact mismatch this ticket
	 * exists to close.
	 */
	it("lets the newest conversion supersede an in-flight one", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });

		await handlers.convertKind({ input: baseInput, context: baseContext });

		expect(startOptions().workflowIdConflictPolicy).toBe(
			"TERMINATE_EXISTING",
		);
	});

	/**
	 * Defensive only. With TERMINATE_EXISTING above, Temporal does not reject a
	 * start under a live id — but it can still raise this for a conflict the
	 * policy does not cover (an id whose run has already closed, a race at the
	 * service). If it ever surfaces, the conversion itself must still stand: a
	 * converted item carrying its prior body is a valid, coherent state.
	 */
	it("keeps the conversion when the start is refused as a duplicate", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });
		const alreadyStarted = new Error("Workflow execution already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		mocks.workflowStart.mockRejectedValue(alreadyStarted);

		const result = await handlers.convertKind({
			input: baseInput,
			context: baseContext,
		});

		// The flip still landed; only the duplicate rewrite was refused.
		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
		expect(mocks.createBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.failBackgroundJob).not.toHaveBeenCalled();
		expect(
			(result as { regeneration: { started: boolean } }).regeneration
				.started,
		).toBe(false);
	});

	/**
	 * A converted item with its prior body is a valid state, so a dispatch
	 * failure must not roll the conversion back. It does have to be visible, or
	 * the user waits forever for a rewrite that was never dispatched.
	 */
	it("reports a failed dispatch on the job row rather than failing the conversion", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });
		mocks.workflowStart.mockRejectedValue(new Error("worker unreachable"));

		const result = await handlers.convertKind({
			input: baseInput,
			context: baseContext,
		});

		expect((result as { story: { kind: string } }).story.kind).toBe("BUG");
		expect(mocks.createBackgroundJob).toHaveBeenCalledTimes(1);
		expect(mocks.failBackgroundJob).toHaveBeenCalledWith(
			{ workflowId: WORKFLOW_ID, sourceId: "story-1" },
			expect.objectContaining({ errorClass: "DispatchFailed" }),
		);
	});

	it("writes nothing, starts nothing and opens no job row when the target kind is the current kind", async () => {
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "BUG",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});

		await handlers.convertKind({
			input: baseInput, // targetKind: BUG, current: BUG → no-op
			context: baseContext,
		});

		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.createBackgroundJob).not.toHaveBeenCalled();
		// Single fetch — no-op branch reuses the row from the initial lookup.
		expect(mocks.userStoryFindUnique).toHaveBeenCalledTimes(1);
	});
});

/**
 * TWO DISTINCT QUESTIONS. Membership answers "is the caller in that
 * organization"; it does NOT answer "does that organization own this project".
 * The regeneration made both live: the redraft resolves prompt bindings and AI
 * model settings in the tenant it is handed.
 */
describe("convertStoryKindProcedure — tenant", () => {
	it("refuses a caller-supplied organization the caller is not a member of, before reading anything", async () => {
		mocks.requireOrganizationMembership.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			}),
		);

		await expect(
			handlers.convertKind({
				input: { ...baseInput, organizationId: "org-not-mine" },
				context: baseContext,
			}),
		).rejects.toBeInstanceOf(ORPCError);

		expect(mocks.requireOrganizationMembership).toHaveBeenCalledWith(
			"org-not-mine",
			"user-1",
		);
		// Nothing was read: not the project, not the work item.
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
		expect(mocks.userStoryFindUnique).not.toHaveBeenCalled();
		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	/**
	 * The subtle one. A user who belongs to organizations A and B can pass
	 * membership while naming B for a project A owns — and the redraft would then
	 * run B's prompt bindings and B's model settings over A's content, writing
	 * the result back into A.
	 */
	it("refuses an organization that does not own the project, even with membership", async () => {
		mocks.requireOrganizationMembership.mockResolvedValue({
			role: "owner",
		});
		mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-A" });

		await expect(
			handlers.convertKind({
				input: { ...baseInput, organizationId: "org-B" },
				context: baseContext,
			}),
		).rejects.toBeInstanceOf(ORPCError);

		expect(mocks.userStoryFindUnique).not.toHaveBeenCalled();
		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	/**
	 * The tenant key the workflow receives comes off the PROJECT row, not off the
	 * caller's input — so a personal-context claim cannot redirect an org
	 * project's redraft into personal-scope prompts.
	 */
	it("derives the workflow's organization from the project row, not from the caller", async () => {
		mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-A" });
		mocks.userStoryFindUnique.mockResolvedValue({
			id: "story-1",
			kind: "FEATURE",
			title: "Editor loses focus",
			draftingStage: "DRAFT",
			status: { id: "s1" },
			tasks: [],
		});
		mocks.updateStory.mockResolvedValue({ id: "story-1", kind: "BUG" });

		// No organization claimed at all — the project still supplies one.
		await handlers.convertKind({
			input: { ...baseInput, organizationId: null },
			context: baseContext,
		});

		expect(mocks.requireOrganizationMembership).not.toHaveBeenCalled();
		expect(startOptions().args[0]?.organizationId).toBe("org-A");
		expect(mocks.updateStory.mock.calls[0]?.[3]).toEqual(
			expect.objectContaining({ organizationId: "org-A" }),
		);
	});
});
