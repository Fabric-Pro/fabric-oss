/**
 * Every Publishing Suite verdict moment, end to end from the handler
 * (Fizzy #1851 A9).
 *
 * Handler-level like its siblings in this directory: the procedure chain, the
 * DB layer and Temporal are mocked, but `lib/publishing-outcome.ts` is NOT —
 * the point of this file is that the right handler produces the right row, so
 * stubbing the mapping would leave the wiring untested.
 *
 * The four draft families (`short-post`, `blog-post`, `case-study`,
 * `stakeholder-email`) route their adopt, edit and regenerate moments through
 * the same three helpers with only a post type differing, and the mapping from
 * post type to subject type is pinned in
 * `lib/__tests__/publishing-outcome.test.ts`. So the blog post stands in for
 * that family here, with the short post's *differently shaped* adoption (it
 * selects a labelled option rather than adopting a whole draft) covered
 * separately. Four near-identical copies would say nothing the first says.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	// Draft families
	startTopicDraftAttempt: vi.fn(),
	failTopicDraft: vi.fn(),
	logDraftRefusal: vi.fn(),
	listTopicDrafts: vi.fn(),
	saveWorkingDraft: vi.fn(),
	updateWorkingDraftBody: vi.fn(),
	// Analysis revisions
	saveAnalysisRevision: vi.fn(),
	listAnalysisRevisions: vi.fn(),
	// Topic status
	updatePublishingTopicStatus: vi.fn(),
	// Measurement substrate (Fizzy #2230)
	recordAiOutcome: vi.fn(),
	resolvePromptVersionId: vi.fn(),
	getAiOutcomesForSubjects: vi.fn(),
	getAnalysisRevisionSnapshot: vi.fn(),
	getWorkingDraftSourceSnapshot: vi.fn(),
	getLatestReadyDraft: vi.fn(),
}));
const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	...dbMocks,
	// The feature gate resolves the flag per organization and derives the
	// tenant from the Project row; `recordTopicStatusOutcome` reads the same
	// resolver for the org it stamps on a topic verdict.
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
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => () => chain,
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import { saveAnalysisRevisionProcedure } from "../analysis-revision";
import {
	adoptBlogPostDraftProcedure,
	generateBlogPostProcedure,
	saveBlogPostBodyProcedure,
} from "../blog-post";
import { selectShortPostOptionProcedure } from "../short-post";
import { updatePublishingTopicStatusProcedure } from "../update-topic-status";

type Handled = { handler: Function };
const generateBlog = generateBlogPostProcedure as unknown as Handled;
const adoptBlog = adoptBlogPostDraftProcedure as unknown as Handled;
const saveBlogBody = saveBlogPostBodyProcedure as unknown as Handled;
const selectShortPost = selectShortPostOptionProcedure as unknown as Handled;
const saveAnalysis = saveAnalysisRevisionProcedure as unknown as Handled;
const updateStatus = updatePublishingTopicStatusProcedure as unknown as Handled;

const CONTEXT = { user: { id: "user-1" } };
const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};
const SAVED_AT = new Date("2026-09-01T12:00:00Z");

const BLOG_CANDIDATE = {
	id: "draft-blog-2",
	postType: "BLOG_POST",
	version: 2,
	status: "READY",
	model: "claude-sonnet-5",
	promptId: "prompt-9",
	promptVersion: 3,
	content: {
		title: "Faster incremental builds",
		subtitle: null,
		body: "## Why this matters\n\nBuilds used to start cold.",
	},
};

const SHORT_POST_CANDIDATE = {
	id: "draft-sp-1",
	postType: "TWEET",
	version: 1,
	status: "READY",
	model: "claude-haiku-4-5",
	promptId: "prompt-4",
	promptVersion: 1,
	content: {
		options: [{ label: "Direct", text: "Cold builds are over." }],
	},
};

/** The one row `recordAiOutcome` was handed, or a readable failure. */
function recordedOutcome() {
	expect(dbMocks.recordAiOutcome).toHaveBeenCalledTimes(1);
	return dbMocks.recordAiOutcome.mock.calls[0][0];
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
	});
	projectMocks.requireEligibleProjectForTopic.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	temporalMocks.isTemporalAvailable.mockResolvedValue(true);
	dbMocks.recordAiOutcome.mockResolvedValue({ outcome: "ACCEPTED_AS_IS" });
	dbMocks.resolvePromptVersionId.mockResolvedValue("pv-42");
	dbMocks.getAiOutcomesForSubjects.mockResolvedValue({});
	dbMocks.saveWorkingDraft.mockResolvedValue({
		status: "saved",
		updatedAt: SAVED_AT,
	});
	dbMocks.updateWorkingDraftBody.mockResolvedValue({
		status: "saved",
		updatedAt: SAVED_AT,
	});
	dbMocks.listTopicDrafts.mockResolvedValue({
		drafts: [{ postType: "BLOG_POST", latestReady: BLOG_CANDIDATE }],
		workingDrafts: [],
	});
	dbMocks.getLatestReadyDraft.mockResolvedValue(BLOG_CANDIDATE);
});

describe("adopting a generated candidate", () => {
	it("records ACCEPTED_AS_IS against the draft, with its model and prompt", async () => {
		const result = await adoptBlog.handler({
			input: {
				...INPUT,
				draftId: "draft-blog-2",
				expectedUpdatedAt: null,
			},
			context: CONTEXT,
		});

		expect(result).toMatchObject({ saved: true });
		expect(recordedOutcome()).toMatchObject({
			featureKey: "publishing-suite",
			outcome: "ACCEPTED_AS_IS",
			subjectType: "publishing-blog-post",
			subjectId: "draft-blog-2",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			modelCanonicalName: "claude-sonnet-5",
			promptVersionId: "pv-42",
		});
	});

	/**
	 * The short post adopts a LABELLED OPTION rather than a whole draft, so it
	 * is a different handler with a different lookup — worth its own case even
	 * though the verdict it files is the same.
	 */
	it("records ACCEPTED_AS_IS when a short post option is selected", async () => {
		dbMocks.listTopicDrafts.mockResolvedValue({
			drafts: [{ postType: "TWEET", latestReady: SHORT_POST_CANDIDATE }],
			workingDrafts: [],
		});

		await selectShortPost.handler({
			input: {
				...INPUT,
				draftId: "draft-sp-1",
				optionLabel: "Direct",
				expectedUpdatedAt: null,
			},
			context: CONTEXT,
		});

		expect(recordedOutcome()).toMatchObject({
			outcome: "ACCEPTED_AS_IS",
			subjectType: "publishing-short-post",
			subjectId: "draft-sp-1",
			modelCanonicalName: "claude-haiku-4-5",
		});
	});

	/**
	 * The rule the whole slice rests on: measurement observes the action, it
	 * never gets a vote on whether it succeeded.
	 */
	it("still saves when the metrics write throws", async () => {
		dbMocks.recordAiOutcome.mockRejectedValue(
			new Error("outcome table down"),
		);

		const result = await adoptBlog.handler({
			input: {
				...INPUT,
				draftId: "draft-blog-2",
				expectedUpdatedAt: null,
			},
			context: CONTEXT,
		});

		expect(result).toMatchObject({ saved: true, updatedAt: SAVED_AT });
		expect(dbMocks.saveWorkingDraft).toHaveBeenCalledTimes(1);
	});
});

describe("saving an edited body over an adopted candidate", () => {
	it("records ACCEPTED_WITH_EDITS against the candidate it started as", async () => {
		dbMocks.getWorkingDraftSourceSnapshot.mockResolvedValue({
			draftId: "draft-blog-2",
			model: "claude-sonnet-5",
			promptId: "prompt-9",
			promptVersion: 3,
		});

		const result = await saveBlogBody.handler({
			input: {
				...INPUT,
				body: "## Why this matters\n\nEdited by a human.",
				expectedUpdatedAt: SAVED_AT,
			},
			context: CONTEXT,
		});

		expect(result).toMatchObject({ saved: true });
		expect(recordedOutcome()).toMatchObject({
			outcome: "ACCEPTED_WITH_EDITS",
			subjectType: "publishing-blog-post",
			subjectId: "draft-blog-2",
		});
	});
});

describe("regenerating over an existing candidate", () => {
	beforeEach(() => {
		dbMocks.startTopicDraftAttempt.mockResolvedValue({
			status: "started",
			draftId: "draft-blog-3",
			version: 3,
		});
	});

	it("records REJECTED against the candidate that was passed over", async () => {
		const result = await generateBlog.handler({
			input: INPUT,
			context: CONTEXT,
		});

		expect(result).toMatchObject({ started: true });
		expect(recordedOutcome()).toMatchObject({
			outcome: "REJECTED",
			subjectType: "publishing-blog-post",
			// The SUPERSEDED draft, never the one just started.
			subjectId: "draft-blog-2",
		});
	});

	it("records nothing on a first generation", async () => {
		dbMocks.getLatestReadyDraft.mockResolvedValue(null);

		await generateBlog.handler({ input: INPUT, context: CONTEXT });

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});
});

describe("saving a revision of the AI analysis", () => {
	it("records ACCEPTED_WITH_EDITS against the revision just written", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({
			status: "saved",
			version: 4,
		});
		dbMocks.getAnalysisRevisionSnapshot.mockResolvedValue({
			revisionId: "rev-4",
			model: "claude-sonnet-5",
		});

		const result = await saveAnalysis.handler({
			input: {
				...INPUT,
				body: "Rewritten by a human.",
				expectedVersion: 3,
				sourceAnalysisVersion: 2,
			},
			context: CONTEXT,
		});

		expect(result).toMatchObject({ saved: true, version: 4 });
		expect(dbMocks.getAnalysisRevisionSnapshot).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "project-1",
			revisionVersion: 4,
			sourceAnalysisVersion: 2,
		});
		expect(recordedOutcome()).toMatchObject({
			outcome: "ACCEPTED_WITH_EDITS",
			subjectType: "publishing-analysis",
			subjectId: "rev-4",
		});
	});

	it("records nothing when the save was refused", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({ status: "conflict" });

		await expect(
			saveAnalysis.handler({
				input: {
					...INPUT,
					body: "Rewritten by a human.",
					expectedVersion: 3,
					sourceAnalysisVersion: 2,
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});
});

describe("moving a topic to a terminal status", () => {
	beforeEach(() => {
		dbMocks.updatePublishingTopicStatus.mockResolvedValue({
			topic: { id: "topic-1", status: "PUBLISHED" },
		});
	});

	it("records ACCEPTED_AS_IS when a topic is published", async () => {
		await updateStatus.handler({
			input: { ...INPUT, status: "PUBLISHED", publishedUrl: null },
			context: CONTEXT,
		});

		expect(recordedOutcome()).toMatchObject({
			outcome: "ACCEPTED_AS_IS",
			subjectType: "publishing-topic",
			subjectId: "topic-1",
			// The distinct-publisher count is over exactly this column.
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("records REJECTED when a topic is declined", async () => {
		await updateStatus.handler({
			input: {
				...INPUT,
				status: "DECLINED",
				declineReason: "Covered elsewhere",
			},
			context: CONTEXT,
		});

		expect(recordedOutcome()).toMatchObject({
			outcome: "REJECTED",
			subjectType: "publishing-topic",
			subjectId: "topic-1",
		});
	});

	it("records nothing when the topic does not exist", async () => {
		dbMocks.updatePublishingTopicStatus.mockResolvedValue(null);

		await expect(
			updateStatus.handler({
				input: { ...INPUT, status: "PUBLISHED" },
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(dbMocks.recordAiOutcome).not.toHaveBeenCalled();
	});
});
