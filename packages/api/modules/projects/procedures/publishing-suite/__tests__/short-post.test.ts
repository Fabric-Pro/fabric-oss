import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `generateShortPost` and `selectShortPostOption` (Fizzy #1853, Phase 2B-2).
 *
 * Handler-level, mirroring `topic-drafts.test.ts`: the procedure chain, the DB
 * layer and Temporal are all mocked, so what is under test is the handler's own
 * contract — which permission gates it, what it refuses, what it passes down,
 * and which of its several "did not start" answers each situation produces.
 */

const dbMocks = vi.hoisted(() => ({
	startTopicDraftAttempt: vi.fn(),
	failTopicDraft: vi.fn(),
	logDraftRefusal: vi.fn(),
	listTopicDrafts: vi.fn(),
	saveWorkingDraft: vi.fn(),
}));
const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	...dbMocks,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));

const temporalMocks = vi.hoisted(() => ({
	isTemporalAvailable: vi.fn(async () => true),
	workflowStart: vi.fn(async () => undefined),
}));
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: temporalMocks.isTemporalAvailable,
	getTemporalClient: async () => ({
		workflow: { start: temporalMocks.workflowStart },
	}),
}));

const projectMocks = vi.hoisted(() => ({
	requireEligibleProjectForTopic: vi.fn(async () => ({
		id: "project-1",
		organizationId: "org-1",
	})),
}));
vi.mock("../../../lib/publishing-topic-project", () => projectMocks);

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import {
	generateShortPostProcedure,
	selectShortPostOptionProcedure,
} from "../short-post";

type Handled = { handler: Function; __permission: string };
const generate = generateShortPostProcedure as unknown as Handled;
const select = selectShortPostOptionProcedure as unknown as Handled;

const CONTEXT = { user: { id: "user-1" } };
const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};

const READY_DRAFT = {
	id: "draft-1",
	postType: "TWEET",
	version: 2,
	status: "READY",
	content: {
		options: [
			{
				label: "Direct",
				text: "Builds are faster.",
				estimatedCharacters: 18,
			},
			{
				label: "Question-led",
				text: "Tired of slow builds?",
				estimatedCharacters: 21,
			},
			{
				label: "Story-led",
				text: "We shaved minutes off CI.",
				estimatedCharacters: 25,
			},
		],
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	// The rollback writer returns an outcome the handler reads. A bare
	// `vi.fn()` resolves to `undefined`, which is a shape the real writer
	// cannot produce — and a fixture that encodes an impossible shape is how
	// a handler change gets found by CI instead of by a test.
	dbMocks.failTopicDraft.mockResolvedValue({ persisted: true });
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "user-1",
	});
	temporalMocks.isTemporalAvailable.mockResolvedValue(true);
	temporalMocks.workflowStart.mockResolvedValue(undefined);
	projectMocks.requireEligibleProjectForTopic.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	dbMocks.startTopicDraftAttempt.mockResolvedValue({
		status: "started",
		draftId: "draft-1",
		version: 1,
	});
	dbMocks.listTopicDrafts.mockResolvedValue({
		drafts: [
			{
				postType: "TWEET",
				latestAttempt: READY_DRAFT,
				latestReady: READY_DRAFT,
			},
		],
		workingDrafts: [],
	});
	dbMocks.saveWorkingDraft.mockResolvedValue({
		status: "saved",
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	});
});

describe("generateShortPost", () => {
	it("requires the UPDATE permission, not READ", () => {
		// Generation spends the actor's provider quota and writes a row. A read
		// permission would let a viewer do both.
		expect(generate.__permission).toBe("publishing-topic:update");
	});

	it("checks Temporal BEFORE creating the row", async () => {
		temporalMocks.isTemporalAvailable.mockResolvedValue(false);

		const result = await generate.handler({
			input: INPUT,
			context: CONTEXT,
		});

		// Creating the row first and discovering the outage second would leave a
		// GENERATING row holding the partial unique index, so the button would go
		// on refusing for ten minutes over an outage that may already be over.
		expect(result).toEqual({ started: false, reason: "unavailable" });
		expect(dbMocks.startTopicDraftAttempt).not.toHaveBeenCalled();
	});

	it("derives the tenant from the loaded Project row, never from the input", async () => {
		projectMocks.requireEligibleProjectForTopic.mockResolvedValue({
			id: "project-1",
			organizationId: "org-REAL",
		});

		await generate.handler({
			input: { ...INPUT, organizationId: "org-CLAIMED" },
			context: CONTEXT,
		});

		const args = temporalMocks.workflowStart.mock.calls[0][1].args[0];
		expect(args.organizationId).toBe("org-REAL");
	});

	it("stores trimmed guidance, and stores blank guidance as null", async () => {
		await generate.handler({
			input: { ...INPUT, guidance: "  keep it short  " },
			context: CONTEXT,
		});
		expect(dbMocks.startTopicDraftAttempt.mock.calls[0][0].guidance).toBe(
			"keep it short",
		);

		vi.clearAllMocks();
		dbMocks.startTopicDraftAttempt.mockResolvedValue({
			status: "started",
			draftId: "d",
			version: 1,
		});
		await generate.handler({
			input: { ...INPUT, guidance: "   " },
			context: CONTEXT,
		});
		// An empty string would render as a guidance section containing nothing,
		// which reads to the model as an instruction it failed to understand
		// rather than as no instruction.
		expect(
			dbMocks.startTopicDraftAttempt.mock.calls[0][0].guidance,
		).toBeNull();
	});

	it("keys the workflow on the ATTEMPT, not the topic", async () => {
		await generate.handler({ input: INPUT, context: CONTEXT });

		// Reusing a topic-keyed id would make a second run collide with a
		// finished one's history.
		expect(temporalMocks.workflowStart.mock.calls[0][1].workflowId).toBe(
			"publishing-topic-sp:draft-1",
		);
	});

	it("reports an in-flight attempt as an answer, not an error", async () => {
		dbMocks.startTopicDraftAttempt.mockResolvedValue({
			status: "in_flight",
		});

		const result = await generate.handler({
			input: INPUT,
			context: CONTEXT,
		});

		expect(result).toEqual({ started: false, reason: "in-progress" });
		expect(temporalMocks.workflowStart).not.toHaveBeenCalled();
	});

	it("distinguishes an ineligible project from a missing topic", async () => {
		// Both used to collapse into "topic not found", which is untrue when the
		// topic is fine and the project was archived in another tab.
		dbMocks.startTopicDraftAttempt.mockResolvedValue({
			status: "project_ineligible",
		});
		await expect(
			generate.handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/Project not found/);

		dbMocks.startTopicDraftAttempt.mockResolvedValue({
			status: "not_found",
		});
		await expect(
			generate.handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/Topic not found/);
	});

	it("rolls the row back when the workflow will not start", async () => {
		temporalMocks.workflowStart.mockRejectedValue(new Error("no worker"));

		await expect(
			generate.handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow();

		// Otherwise the UI polls a GENERATING row no workflow will ever complete,
		// and the partial unique index refuses every retry until the deadline
		// sweep clears it.
		expect(dbMocks.failTopicDraft).toHaveBeenCalledWith(
			expect.objectContaining({ id: "draft-1", projectId: "project-1" }),
		);
	});

	it("treats an already-started workflow as in-progress, not a failure", async () => {
		const err = new Error("already started");
		err.name = "WorkflowExecutionAlreadyStartedError";
		temporalMocks.workflowStart.mockRejectedValue(err);

		const result = await generate.handler({
			input: INPUT,
			context: CONTEXT,
		});

		expect(result).toEqual({ started: false, reason: "in-progress" });
		expect(dbMocks.failTopicDraft).not.toHaveBeenCalled();
	});

	it("refuses when the feature flag is off", async () => {
		// resolveProjectTenant still resolves — the project is real, only the
		// flag is off — so this fails for the flag reason, not because the
		// project looked unresolvable to the gate.
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			generate.handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow();
		expect(dbMocks.startTopicDraftAttempt).not.toHaveBeenCalled();
	});
});

describe("selectShortPostOption", () => {
	const SELECT_INPUT = {
		...INPUT,
		draftId: "draft-1",
		optionLabel: "Question-led",
	};

	it("requires the UPDATE permission", () => {
		expect(select.__permission).toBe("publishing-topic:update");
	});

	it("takes the option TEXT from the stored draft, never from the caller", async () => {
		await select.handler({
			input: { ...SELECT_INPUT, body: "attacker supplied" },
			context: CONTEXT,
		});

		// Accepting the body would make this endpoint a way to write arbitrary
		// text into a project's publishing pipeline under the guise of
		// "selecting" a generated option — and the stored draft would stop being
		// evidence of what the model actually produced.
		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "Tired of slow builds?",
				sourceOptionLabel: "Question-led",
			}),
		);
	});

	it("reads the candidate through the same scoped helper the page uses", async () => {
		await select.handler({ input: SELECT_INPUT, context: CONTEXT });

		// So this endpoint cannot see a draft the page could not.
		expect(dbMocks.listTopicDrafts).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "project-1",
		});
	});

	it("refuses a draft id that is not the current READY one", async () => {
		await expect(
			select.handler({
				input: { ...SELECT_INPUT, draftId: "some-other-draft" },
				context: CONTEXT,
			}),
		).rejects.toThrow(/Draft option not found/);
		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
	});

	it("gives the SAME answer for an unknown label as for an unknown draft", async () => {
		// A caller who guessed an id learns nothing about whether it exists.
		const unknownLabel = select
			.handler({
				input: { ...SELECT_INPUT, optionLabel: "Nope" },
				context: CONTEXT,
			})
			.catch((e: Error) => e.message);
		const unknownDraft = select
			.handler({
				input: { ...SELECT_INPUT, draftId: "nope" },
				context: CONTEXT,
			})
			.catch((e: Error) => e.message);

		expect(await unknownLabel).toBe(await unknownDraft);
	});

	it("refuses an option whose stored text is empty", async () => {
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "TWEET",
					latestAttempt: null,
					latestReady: {
						...READY_DRAFT,
						content: {
							options: [{ label: "Direct", text: "   " }],
						},
					},
				},
			],
			workingDrafts: [],
		});

		await expect(
			select.handler({
				input: { ...SELECT_INPUT, optionLabel: "Direct" },
				context: CONTEXT,
			}),
		).rejects.toThrow(/Draft option not found/);
	});

	it("degrades rather than throwing when the stored content has an old shape", async () => {
		// `content` is `Json?`, so a row written by an older shape must produce a
		// NOT_FOUND the client can act on, not a TypeError inside a handler.
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "TWEET",
					latestAttempt: null,
					latestReady: {
						...READY_DRAFT,
						content: { sections: ["old"] },
					},
				},
			],
			workingDrafts: [],
		});

		await expect(
			select.handler({ input: SELECT_INPUT, context: CONTEXT }),
		).rejects.toThrow(/Draft option not found/);
	});

	it("REFUSES a label that matches two stored options rather than picking one", async () => {
		// The schema will not persist colliding labels, so this row cannot be
		// written by this code — but `content` is a JSON column and the harm if it
		// ever holds one is the worst in this feature: silently adopting the FIRST
		// match publishes text the reader did not choose, and nothing reports it.
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "TWEET",
					latestAttempt: null,
					latestReady: {
						...READY_DRAFT,
						content: {
							options: [
								{ label: "Direct", text: "First." },
								{ label: "Direct", text: "Second, different." },
							],
						},
					},
				},
			],
			workingDrafts: [],
		});

		await expect(
			select.handler({
				input: { ...SELECT_INPUT, optionLabel: "Direct" },
				context: CONTEXT,
			}),
		).rejects.toThrow(/ambiguous/i);
		// The assertion that matters: nothing was adopted.
		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
	});

	it("reports a vanished candidate as a CONFLICT, not a 500", async () => {
		dbMocks.saveWorkingDraft.mockResolvedValue({
			status: "source_not_found",
		});

		await expect(
			select.handler({ input: SELECT_INPUT, context: CONTEXT }),
		).rejects.toThrow(/no longer available/);
	});

	it("passes the caller's expectation through for the CAS", async () => {
		await select.handler({
			input: {
				...SELECT_INPUT,
				expectedUpdatedAt: new Date("2026-09-01T11:00:00Z"),
			},
			context: CONTEXT,
		});

		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedUpdatedAt: new Date("2026-09-01T11:00:00Z"),
			}),
		);
	});

	it("opts an older client OUT of the check rather than failing it", async () => {
		// `expectedUpdatedAt` absent means the caller expressed no
		// expectation. Passing null instead would make every save from such a
		// client a CONFLICT the moment any working draft existed — turning a
		// backwards-compatible field into a breaking one.
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "TWEET",
					latestAttempt: READY_DRAFT,
					latestReady: READY_DRAFT,
				},
			],
			workingDrafts: [
				{
					postType: "TWEET",
					hasBody: true,
					updatedAt: new Date("2026-09-01T10:00:00Z"),
				},
			],
		});

		await select.handler({ input: SELECT_INPUT, context: CONTEXT });

		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedUpdatedAt: new Date("2026-09-01T10:00:00Z"),
			}),
		);
	});

	it("reports a STALE working draft as a CONFLICT", async () => {
		dbMocks.saveWorkingDraft.mockResolvedValue({ status: "stale" });

		await expect(
			select.handler({
				input: { ...SELECT_INPUT, expectedUpdatedAt: null },
				context: CONTEXT,
			}),
		).rejects.toThrow(/changed while you were choosing/);
	});

	it("refuses when the feature flag is off", async () => {
		// resolveProjectTenant still resolves — the project is real, only the
		// flag is off — so this fails for the flag reason, not because the
		// project looked unresolvable to the gate.
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			select.handler({ input: SELECT_INPUT, context: CONTEXT }),
		).rejects.toThrow();
		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
	});
});
