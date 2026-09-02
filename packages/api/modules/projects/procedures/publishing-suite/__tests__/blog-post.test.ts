import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `generateBlogPost`, `adoptBlogPostDraft` and `saveBlogPostBody`
 * (Fizzy #1853, Phase 2B-3).
 *
 * Handler-level, mirroring `short-post.test.ts`: the procedure chain, the DB
 * layer and Temporal are all mocked, so what is under test is the handler's own
 * contract — which permission gates it, what it refuses, what it passes down,
 * and which of its several "did not start" answers each situation produces.
 */

const dbMocks = vi.hoisted(() => ({
	startTopicDraftAttempt: vi.fn(),
	failTopicDraft: vi.fn(),
	listTopicDrafts: vi.fn(),
	saveWorkingDraft: vi.fn(),
	updateWorkingDraftBody: vi.fn(),
}));
vi.mock("@repo/database", () => dbMocks);

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

const flagMocks = vi.hoisted(() => ({
	isPublishingSuiteEnabled: vi.fn(() => true),
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isPublishingSuiteEnabled: flagMocks.isPublishingSuiteEnabled,
}));

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
	adoptBlogPostDraftProcedure,
	generateBlogPostProcedure,
	saveBlogPostBodyProcedure,
} from "../blog-post";

type Handled = { handler: Function; __permission: string };
const generate = generateBlogPostProcedure as unknown as Handled;
const adopt = adoptBlogPostDraftProcedure as unknown as Handled;
const saveBody = saveBlogPostBodyProcedure as unknown as Handled;

const CONTEXT = { user: { id: "user-1" } };
const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};

const SAVED_AT = new Date("2026-09-01T12:00:00Z");

const READY_DRAFT = {
	id: "draft-1",
	postType: "BLOG_POST",
	version: 2,
	status: "READY",
	content: {
		title: "Faster incremental builds",
		subtitle: "How a warm cache changed the inner loop",
		body: "## Why this matters\n\nBuilds used to start cold.",
		categories: ["Toolchain"],
		keywords: ["ci-pipeline"],
		inputsNeeded: [],
		safetyNote: null,
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isPublishingSuiteEnabled.mockReturnValue(true);
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
				postType: "BLOG_POST",
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

describe("generateBlogPost", () => {
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

	it("opens the attempt as BLOG_POST, not TWEET", async () => {
		await generate.handler({ input: INPUT, context: CONTEXT });

		expect(dbMocks.startTopicDraftAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ postType: "BLOG_POST" }),
		);
	});

	it("keys the workflow on the ATTEMPT and uses the blog workflow", async () => {
		await generate.handler({ input: INPUT, context: CONTEXT });

		expect(temporalMocks.workflowStart).toHaveBeenCalledWith(
			"generatePublishingBlogPostWorkflow",
			expect.objectContaining({
				workflowId: "publishing-topic-bp:draft-1",
			}),
		);
	});

	it("does not collide with the short post's workflow id", async () => {
		// Both are keyed on a draft id, and draft ids are unique per attempt —
		// but the prefixes differ too, so a reader grepping Temporal can tell
		// the two families apart.
		await generate.handler({ input: INPUT, context: CONTEXT });

		const [, options] = temporalMocks.workflowStart.mock.calls[0] as [
			string,
			{ workflowId: string },
		];
		expect(options.workflowId).not.toContain("publishing-topic-sp:");
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
});

describe("adoptBlogPostDraft", () => {
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
			},
			context: CONTEXT,
		});

		const call = dbMocks.saveWorkingDraft.mock.calls[0]?.[0] as {
			body: string;
		};
		expect(call.body).not.toContain("Arbitrary text");
		expect(call.body).toContain("Builds used to start cold.");
	});

	it("composes the title and subtitle into the adopted body", async () => {
		// Byte-for-byte the text `composeWorkingDraftBody` seeds, or an adopted
		// version silently differs from the one the first run saved.
		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: null },
			context: CONTEXT,
		});

		const call = dbMocks.saveWorkingDraft.mock.calls[0]?.[0] as {
			body: string;
		};
		expect(call.body).toBe(
			"# Faster incremental builds\n\n_How a warm cache changed the inner loop_\n\n## Why this matters\n\nBuilds used to start cold.",
		);
	});

	it("leaves the suggestions out of the adopted body", async () => {
		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: null },
			context: CONTEXT,
		});

		const call = dbMocks.saveWorkingDraft.mock.calls[0]?.[0] as {
			body: string;
		};
		expect(call.body).not.toContain("Toolchain");
		expect(call.body).not.toContain("ci-pipeline");
	});

	it("saves a null option label — a blog has no options to name", async () => {
		await adopt.handler({
			input: { ...INPUT, draftId: "draft-1", expectedUpdatedAt: null },
			context: CONTEXT,
		});

		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				postType: "BLOG_POST",
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

	it("reports a lost race as CONFLICT, not a failure", async () => {
		dbMocks.saveWorkingDraft.mockResolvedValue({ status: "stale" });

		await expect(
			adopt.handler({
				input: {
					...INPUT,
					draftId: "draft-1",
					expectedUpdatedAt: null,
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
					postType: "BLOG_POST",
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
});

describe("saveBlogPostBody", () => {
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
				postType: "BLOG_POST",
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

	it("reports NOT_FOUND when there is no draft to edit rather than creating one", async () => {
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
