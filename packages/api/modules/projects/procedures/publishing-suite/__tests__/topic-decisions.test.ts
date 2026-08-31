import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	listTopicDecisions: vi.fn(),
	answerTopicQuestion: vi.fn(),
}));
const flagMocks = vi.hoisted(() => ({
	isPublishingSuiteEnabled: vi.fn(() => true),
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isPublishingSuiteEnabled: flagMocks.isPublishingSuiteEnabled,
}));
// answerTopicQuestionProcedure's ratchet — mocked the same way the handler
// mocks below mock the DB layer, so this stays a pure handler-level test: the
// real ratchet (backed by `db.project`) is exercised where the OTHER write,
// `generatePlanningAnalysisProcedure`, is covered against a real `db` mock —
// `packages/api/__tests__/publishing-suite-procedures.test.ts`.
const topicProjectMocks = vi.hoisted(() => ({
	requireEligibleProjectForTopic: vi.fn(),
}));
vi.mock("../../../lib/publishing-topic-project", () => ({
	requireEligibleProjectForTopic:
		topicProjectMocks.requireEligibleProjectForTopic,
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

import { answerTopicQuestion, listTopicDecisions } from "@repo/database";
import {
	answerTopicQuestionProcedure,
	listTopicDecisionsProcedure,
} from "../topic-decisions";

const handler = (
	listTopicDecisionsProcedure as unknown as { handler: Function }
).handler;
const permissionSpy = (
	listTopicDecisionsProcedure as unknown as { __permission: string }
).__permission;
const answerHandler = (
	answerTopicQuestionProcedure as unknown as { handler: Function }
).handler;
const answerPermissionSpy = (
	answerTopicQuestionProcedure as unknown as { __permission: string }
).__permission;
const ctx = {
	user: { id: "user-session", name: "U", email: "u@example.com" },
	session: {},
};

async function callList(input: { projectId: string; topicId: string }) {
	return handler({ input, context: ctx });
}

const API_ANSWER_INPUT = {
	projectId: "proj-1",
	topicId: "topic-1",
	questionId: "q-customer-name",
	answer: "Yes, marketing cleared it.",
	answerSource: "AI_EDITED" as const,
};

async function callAnswer(input: Record<string, unknown>) {
	return answerHandler({ input, context: ctx });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listTopicDecisions).mockResolvedValue([]);
	topicProjectMocks.requireEligibleProjectForTopic.mockResolvedValue({
		id: "proj-1",
		organizationId: "org-1",
	});
	vi.mocked(answerTopicQuestion).mockResolvedValue({
		status: "resolved",
		root: {
			id: "root-1",
			parentId: null,
			kind: "QUESTION",
			status: "RESOLVED",
			authorType: "USER",
			authorUserId: "user-session",
			questionId: "q-customer-name",
			decisionKind: "CUSTOMER_NAME",
			subject: null,
			summary: "May we name the customer?",
			content: "Yes, marketing cleared it.",
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: "AI_EDITED",
			analysisVersion: 1,
			createdAt: new Date("2026-08-01T00:00:00Z"),
		},
	});
});

describe("listTopicDecisions procedure", () => {
	it("is gated on PUBLISHING_TOPIC_READ", () => {
		expect(permissionSpy).toBe("publishing-topic:read");
	});

	it("re-scopes the read to the project, never the topic id alone", async () => {
		await callList({ projectId: "proj-1", topicId: "topic-1" });

		expect(listTopicDecisions).toHaveBeenCalledWith({
			projectId: "proj-1",
			topicId: "topic-1",
		});
	});

	it("answers a topic from another project exactly as a missing one", async () => {
		// DV16: existence must not leak through a difference in the answer.
		// No separate project-existence check runs here (see the module doc on
		// topic-decisions.ts) — `listTopicDecisions` is the only source of truth,
		// and it returns [] for both "wrong project" and "no decisions yet".
		vi.mocked(listTopicDecisions).mockResolvedValue([]);

		const result = await callList({
			projectId: "proj-1",
			topicId: "elsewhere",
		});

		expect(result.threads).toEqual([]);
	});

	it("returns the threads the DB helper produces", async () => {
		const thread = {
			root: {
				id: "d1",
				parentId: null,
				kind: "QUESTION" as const,
				status: "OPEN",
				authorType: "AGENT" as const,
				authorUserId: null,
				questionId: "q1",
				decisionKind: "ASSET_APPROVAL",
				subject: null,
				summary: "Which asset?",
				content: null,
				recommendedResponse: null,
				whyItMatters: null,
				answerSource: null,
				analysisVersion: 1,
				createdAt: new Date("2026-08-01T00:00:00Z"),
			},
			replies: [],
		};
		vi.mocked(listTopicDecisions).mockResolvedValue([thread]);

		const result = await callList({
			projectId: "proj-1",
			topicId: "topic-1",
		});

		expect(result.threads).toEqual([thread]);
	});
});

describe("answerTopicQuestion procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(answerPermissionSpy).toBe("publishing-topic:update");
	});

	it("applies the eligibility ratchet before answering", async () => {
		await callAnswer(API_ANSWER_INPUT);

		expect(
			topicProjectMocks.requireEligibleProjectForTopic,
		).toHaveBeenCalledWith({
			projectId: "proj-1",
			clientOrganizationId: null,
		});
	});

	it("NOT_FOUND when the project is archived, deleted or absent", async () => {
		topicProjectMocks.requireEligibleProjectForTopic.mockRejectedValue(
			Object.assign(new Error("Project not found"), {
				code: "NOT_FOUND",
			}),
		);

		await expect(callAnswer(API_ANSWER_INPUT)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(answerTopicQuestion).not.toHaveBeenCalled();
	});

	it("passes the caller as the author, never a client-supplied id", async () => {
		await callAnswer({ ...API_ANSWER_INPUT, authorUserId: "someone-else" });

		expect(answerTopicQuestion).toHaveBeenCalledWith(
			expect.objectContaining({ authorUserId: "user-session" }),
		);
	});

	it("re-scopes the write to the project, never the topic id alone", async () => {
		await callAnswer(API_ANSWER_INPUT);

		expect(answerTopicQuestion).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				topicId: "topic-1",
			}),
		);
	});

	it("surfaces an unknown question as NOT_FOUND", async () => {
		vi.mocked(answerTopicQuestion).mockResolvedValue({
			status: "not_found",
			root: null,
		});

		await expect(callAnswer(API_ANSWER_INPUT)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("returns the resolved root on a fresh answer", async () => {
		const result = await callAnswer(API_ANSWER_INPUT);

		expect(result).toEqual({
			status: "resolved",
			root: expect.objectContaining({ id: "root-1", status: "RESOLVED" }),
		});
	});

	it("returns deduped without treating it as an error", async () => {
		vi.mocked(answerTopicQuestion).mockResolvedValue({
			status: "deduped",
			root: {
				id: "root-1",
				parentId: null,
				kind: "QUESTION",
				status: "RESOLVED",
				authorType: "USER",
				authorUserId: "someone-earlier",
				questionId: "q-customer-name",
				decisionKind: "CUSTOMER_NAME",
				subject: null,
				summary: "May we name the customer?",
				content: "Already answered.",
				recommendedResponse: null,
				whyItMatters: null,
				answerSource: "MANUAL",
				analysisVersion: 1,
				createdAt: new Date("2026-08-01T00:00:00Z"),
			},
		});

		const result = await callAnswer(API_ANSWER_INPUT);

		expect(result.status).toBe("deduped");
	});
});
