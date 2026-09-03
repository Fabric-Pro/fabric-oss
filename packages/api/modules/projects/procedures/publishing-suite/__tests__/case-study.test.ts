import { composeCaseStudyWorkingDraftBody } from "@repo/utils/publishing-case-study-body";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `generateCaseStudy`, `adoptCaseStudyDraft` and `saveCaseStudyBody`
 * (Fizzy #1854, Phase 2C).
 *
 * Handler-level, mirroring `blog-post.test.ts`: the procedure chain, the DB
 * layer and Temporal are all mocked, so what is under test is the handler's own
 * contract — which permission gates it, what it refuses, what it passes down,
 * and which of its several "did not start" answers each situation produces.
 *
 * `@repo/utils/publishing-case-study-body` is deliberately NOT mocked. The
 * composer is the shared one the generation activity seeds with, and asserting
 * against the real function is what makes "the adopted text is the seeded text"
 * a checked claim rather than a comment.
 */

const dbMocks = vi.hoisted(() => ({
	startTopicDraftAttempt: vi.fn(),
	failTopicDraft: vi.fn(),
	logDraftRefusal: vi.fn(),
	listTopicDrafts: vi.fn(),
	saveWorkingDraft: vi.fn(),
	updateWorkingDraftBody: vi.fn(),
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
	adoptCaseStudyDraftProcedure,
	generateCaseStudyProcedure,
	saveCaseStudyBodyProcedure,
} from "../case-study";

type Handled = { handler: Function; __permission: string };
const generate = generateCaseStudyProcedure as unknown as Handled;
const adopt = adoptCaseStudyDraftProcedure as unknown as Handled;
const saveBody = saveCaseStudyBodyProcedure as unknown as Handled;

const CONTEXT = { user: { id: "user-1" } };
const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};

const SAVED_AT = new Date("2026-09-01T12:00:00Z");

const READY_DRAFT = {
	id: "draft-1",
	postType: "CASE_STUDY",
	version: 2,
	status: "READY",
	content: {
		title: "Cutting release lead time in half",
		body: "## Executive Summary\n\nA client shipped weekly and wanted daily.",
		// The field names `PublishingCaseStudySchema` actually writes. An
		// earlier fixture invented `supportingAssets` / `assetsToConfirm`,
		// which no schema, activity or panel has ever produced — so the
		// "leaves the publishing suggestions out" case below asserted that a
		// body omits text no document would have contained, and would have
		// stayed green through a composer that pasted both real asset lists
		// into the draft.
		confirmedAssets: ["Deployment frequency dashboard"],
		assetsNeedingConfirmation: ["Customer quote pending approval"],
		categories: ["Delivery"],
		keywords: ["lead-time"],
		inputsNeeded: ["[metric TBD]"],
		safetyNote: null,
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
				postType: "CASE_STUDY",
				latestAttempt: READY_DRAFT,
				latestReady: READY_DRAFT,
			},
		],
		workingDrafts: [],
	});
	dbMocks.saveWorkingDraft.mockResolvedValue({
		status: "saved",
		updatedAt: SAVED_AT,
	});
	dbMocks.updateWorkingDraftBody.mockResolvedValue({
		status: "saved",
		updatedAt: SAVED_AT,
	});
});

describe("generateCaseStudy", () => {
	it("requires the UPDATE permission, not READ", () => {
		// Generation spends the actor's provider quota and writes a row. A read
		// permission would let a viewer do both.
		expect(generate.__permission).toBe("publishing-topic:update");
	});

	it("checks Temporal BEFORE creating the row", async () => {
		// Creating the row first would leave it GENERATING and holding the
		// partial unique index for ten minutes over an outage already over.
		temporalMocks.isTemporalAvailable.mockResolvedValue(false);

		const result = await generate.handler({
			input: INPUT,
			context: CONTEXT,
		});

		expect(result).toEqual({ started: false, reason: "unavailable" });
		expect(dbMocks.startTopicDraftAttempt).not.toHaveBeenCalled();
	});

	it("opens the attempt as CASE_STUDY, not BLOG_POST", async () => {
		await generate.handler({ input: INPUT, context: CONTEXT });

		expect(dbMocks.startTopicDraftAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ postType: "CASE_STUDY" }),
		);
	});

	it("keys the workflow on the ATTEMPT and uses the case study workflow", async () => {
		await generate.handler({ input: INPUT, context: CONTEXT });

		expect(temporalMocks.workflowStart).toHaveBeenCalledWith(
			"generatePublishingCaseStudyWorkflow",
			expect.objectContaining({
				workflowId: "publishing-topic-cs:draft-1",
			}),
		);
	});

	it("uses the case study's own workflow-id prefix", async () => {
		// Asserted as a POSITIVE match on `-cs:`, deliberately unlike the blog
		// sibling's `not.toContain("publishing-topic-sp:")`. A negative against
		// one wrong prefix still passes when the id carries a DIFFERENT wrong
		// prefix — copying this file from `blog-post.ts` and leaving `-bp:` in
		// place is exactly the mistake most likely to happen here, and the
		// sibling's form would not catch it.
		await generate.handler({ input: INPUT, context: CONTEXT });

		const [, options] = temporalMocks.workflowStart.mock.calls[0] as [
			string,
			{ workflowId: string },
		];
		expect(options.workflowId).toMatch(/^publishing-topic-cs:/);
	});

	it("reports an in-flight run as an answer rather than an error", async () => {
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

	it("rolls the row back when the workflow cannot start", async () => {
		// Otherwise the UI polls a GENERATING row no workflow will complete,
		// and the partial unique index refuses every retry until the sweep.
		temporalMocks.workflowStart.mockRejectedValue(new Error("no worker"));

		await expect(
			generate.handler({ input: INPUT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

		expect(dbMocks.failTopicDraft).toHaveBeenCalledWith(
			expect.objectContaining({ id: "draft-1" }),
		);
	});

	it("treats an already-started workflow as in-progress, not a failure", async () => {
		const already = new Error("already started");
		already.name = "WorkflowExecutionAlreadyStartedError";
		temporalMocks.workflowStart.mockRejectedValue(already);

		const result = await generate.handler({
			input: INPUT,
			context: CONTEXT,
		});

		expect(result).toEqual({ started: false, reason: "in-progress" });
		// The row belongs to the run that IS in flight — rolling it back would
		// fail the attempt the caller is about to poll.
		expect(dbMocks.failTopicDraft).not.toHaveBeenCalled();
	});

	it("stores whitespace-only guidance as null", async () => {
		await generate.handler({
			input: { ...INPUT, guidance: "   " },
			context: CONTEXT,
		});

		expect(dbMocks.startTopicDraftAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
	});

	it("distinguishes an archived project from a missing topic", async () => {
		dbMocks.startTopicDraftAttempt.mockResolvedValue({
			status: "project_ineligible",
		});

		await expect(
			generate.handler({ input: INPUT, context: CONTEXT }),
		).rejects.toMatchObject({ message: "Project not found" });
	});

	it("never rewrites the draft rows' content — they are evidence of the model's output", async () => {
		// Generation opens an attempt and hands the writing to the activity. If
		// this handler ever started composing content itself, the stored row
		// would stop being a faithful record of what the model produced.
		await generate.handler({ input: INPUT, context: CONTEXT });

		expect(dbMocks.updateWorkingDraftBody).not.toHaveBeenCalled();
		const [attemptArgs] = dbMocks.startTopicDraftAttempt.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(attemptArgs).not.toHaveProperty("content");
		expect(attemptArgs).not.toHaveProperty("body");
	});
});

describe("adoptCaseStudyDraft", () => {
	it("requires the UPDATE permission", () => {
		expect(adopt.__permission).toBe("publishing-topic:update");
	});

	it("reads the body from the STORED draft, never from the request", async () => {
		// The client names a candidate; accepting body text here would make
		// this endpoint a way to write arbitrary content into the publishing
		// pipeline under the guise of adopting a generated version.
		await adopt.handler({
			input: {
				...INPUT,
				draftId: "draft-1",
				expectedUpdatedAt: null,
				// A caller trying to smuggle text in.
				body: "Arbitrary text the model never wrote.",
				title: "A headline the model never wrote",
			},
			context: CONTEXT,
		});

		const call = dbMocks.saveWorkingDraft.mock.calls[0]?.[0] as {
			body: string;
		};
		expect(call.body).not.toContain("Arbitrary text");
		expect(call.body).not.toContain("never wrote");
		expect(call.body).toContain(
			"A client shipped weekly and wanted daily.",
		);
	});

	it("composes the adopted body with the SHARED composer the activity seeds with", async () => {
		// Not a restatement of the expected string: the assertion calls the very
		// function `@repo/temporal` uses to seed the working draft, so a change
		// to that composer cannot leave the adopted text behind.
		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: null },
			context: CONTEXT,
		});

		const call = dbMocks.saveWorkingDraft.mock.calls[0]?.[0] as {
			body: string;
		};
		expect(call.body).toBe(
			composeCaseStudyWorkingDraftBody({
				title: READY_DRAFT.content.title,
				body: READY_DRAFT.content.body,
			}),
		);
	});

	it("leaves the publishing suggestions out of the adopted body", async () => {
		// They are advice about the draft, not part of it. A body that carried
		// them is a body whose author deletes four sections after every run.
		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: null },
			context: CONTEXT,
		});

		const call = dbMocks.saveWorkingDraft.mock.calls[0]?.[0] as {
			body: string;
		};
		expect(call.body).not.toContain("Deployment frequency dashboard");
		expect(call.body).not.toContain("Customer quote pending approval");
		expect(call.body).not.toContain("Delivery");
		expect(call.body).not.toContain("lead-time");
		expect(call.body).not.toContain("[metric TBD]");
	});

	it("saves a null option label — a case study has no options to name", async () => {
		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: null },
			context: CONTEXT,
		});

		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				postType: "CASE_STUDY",
				sourceOptionLabel: null,
			}),
		);
	});

	it("passes the caller's expectation straight through to the CAS", async () => {
		const seen = new Date("2026-09-01T11:00:00Z");

		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: seen },
			context: CONTEXT,
		});

		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledWith(
			expect.objectContaining({ expectedUpdatedAt: seen }),
		);
	});

	it("answers the same for a stale draft id as for a missing one", async () => {
		// A caller who guessed an id must learn nothing about whether it
		// exists, and a stale tab needs to refresh either way.
		await expect(
			adopt.handler({
				input: {
					...INPUT,
					draftId: "some-other-draft",
					expectedUpdatedAt: null,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ message: "Draft not found" });
	});

	it("does not adopt the BLOG_POST draft when no case study exists", async () => {
		// The drafts list carries every content type for the topic. Picking the
		// wrong entry would seed a case study's working draft with blog text.
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "BLOG_POST",
					latestAttempt: { ...READY_DRAFT, postType: "BLOG_POST" },
					latestReady: { ...READY_DRAFT, postType: "BLOG_POST" },
				},
			],
			workingDrafts: [],
		});

		await expect(
			adopt.handler({
				input: {
					...INPUT,
					draftId: "draft-1",
					expectedUpdatedAt: null,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ message: "Draft not found" });

		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
	});

	it("reports a stale expectedUpdatedAt as CONFLICT, not a failure", async () => {
		dbMocks.saveWorkingDraft.mockResolvedValue({ status: "stale" });

		await expect(
			adopt.handler({
				input: {
					...INPUT,
					draftId: "draft-1",
					expectedUpdatedAt: new Date("2026-08-31T09:00:00Z"),
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("REFUSES a stored document it cannot read rather than saving nothing", async () => {
		// `content` is a JSON column. A row from an older or future shape must
		// produce an error a reader can act on, not an empty working draft.
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "CASE_STUDY",
					latestAttempt: null,
					latestReady: {
						...READY_DRAFT,
						content: { options: [{ label: "Direct", text: "x" }] },
					},
				},
			],
			workingDrafts: [],
		});

		await expect(
			adopt.handler({
				input: {
					...INPUT,
					draftId: "draft-1",
					expectedUpdatedAt: null,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
	});

	it("REFUSES a document whose title or body is blank", async () => {
		// A whitespace-only title would compose to a bare `# ` heading — a
		// working draft that looks generated and carries nothing.
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [
				{
					postType: "CASE_STUDY",
					latestAttempt: null,
					latestReady: {
						...READY_DRAFT,
						content: { ...READY_DRAFT.content, title: "   " },
					},
				},
			],
			workingDrafts: [],
		});

		await expect(
			adopt.handler({
				input: {
					...INPUT,
					draftId: "draft-1",
					expectedUpdatedAt: null,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
	});
});

describe("saveCaseStudyBody", () => {
	it("requires the UPDATE permission", () => {
		expect(saveBody.__permission).toBe("publishing-topic:update");
	});

	it("writes the caller's own text — this one IS an edit", async () => {
		await saveBody.handler({
			input: {
				...INPUT,
				body: "# My own headline\n\nRewritten entirely.",
				expectedUpdatedAt: SAVED_AT,
			},
			context: CONTEXT,
		});

		expect(dbMocks.updateWorkingDraftBody).toHaveBeenCalledWith(
			expect.objectContaining({
				postType: "CASE_STUDY",
				body: "# My own headline\n\nRewritten entirely.",
				updatedById: "user-1",
				expectedUpdatedAt: SAVED_AT,
			}),
		);
	});

	it("never touches the draft rows, so they stay evidence of the model's output", async () => {
		await saveBody.handler({
			input: {
				...INPUT,
				body: "Rewritten.",
				expectedUpdatedAt: SAVED_AT,
			},
			context: CONTEXT,
		});

		expect(dbMocks.saveWorkingDraft).not.toHaveBeenCalled();
		expect(dbMocks.startTopicDraftAttempt).not.toHaveBeenCalled();
	});

	it("reports a lost race as CONFLICT", async () => {
		dbMocks.updateWorkingDraftBody.mockResolvedValue({ status: "stale" });

		await expect(
			saveBody.handler({
				input: {
					...INPUT,
					body: "Rewritten.",
					expectedUpdatedAt: SAVED_AT,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("reports NOT_FOUND when there is no working draft to edit rather than creating one", async () => {
		// An editor that could conjure a row would let a body reach a topic
		// whose generation never ran.
		dbMocks.updateWorkingDraftBody.mockResolvedValue({
			status: "not_found",
		});

		await expect(
			saveBody.handler({
				input: {
					...INPUT,
					body: "Rewritten.",
					expectedUpdatedAt: SAVED_AT,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
