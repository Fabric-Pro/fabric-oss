import { beforeEach, describe, expect, it, vi } from "vitest";

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	listTopicDecisions: vi.fn(),
	answerTopicQuestion: vi.fn(),
	amendTopicQuestionAnswer: vi.fn(),
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
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
	for (const m of ["use", "route"]) {
		chain[m] = () => chain;
	}
	// `.output()` records its schema the same way `.input()` does below: a
	// result the handler returns must also be one the REAL output schema
	// accepts, or the endpoint fails at runtime while this file stays green.
	chain.output = (schema: unknown) => {
		chain.__outputSchema = schema;
		return chain;
	};
	// Unlike the other passthrough links, `.input()` records its argument (the
	// REAL `z.object({...})` built in topic-decisions.ts) onto the chain, the
	// same way `requireProjectPermission` records `__permission` below. This
	// lets the whitespace-only-answer tests run the actual schema instead of a
	// hand-rolled copy that would only prove the copy is right.
	chain.input = (schema: unknown) => {
		chain.__inputSchema = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
		__inputSchema: chain.__inputSchema,
		__outputSchema: chain.__outputSchema,
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

import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import {
	amendTopicQuestionAnswer,
	answerTopicQuestion,
	listTopicDecisions,
} from "@repo/database";
import {
	amendTopicQuestionProcedure,
	answerTopicQuestionProcedure,
	listTopicDecisionsProcedure,
} from "../topic-decisions";

type ZodIssue = { message: string };
type ZodLikeSchema = {
	safeParse: (
		value: unknown,
	) => { success: true } | { success: false; error: { issues: ZodIssue[] } };
};
type HandlerBearing = {
	handler: Function;
	__permission: string;
	__inputSchema: ZodLikeSchema;
	__outputSchema: ZodLikeSchema;
};
// What `ZodToJsonSchemaConverter.convert()` actually accepts — the captured
// schemas above are typed as `ZodLikeSchema` for the whitespace-refusal
// tests, but at runtime they are the same real `z.object({...})` the app
// builds `/openapi` from, so they convert exactly the way `/openapi` does.
type ConvertibleSchema = Parameters<
	InstanceType<typeof ZodToJsonSchemaConverter>["convert"]
>[0];

const handler = (listTopicDecisionsProcedure as unknown as HandlerBearing)
	.handler;
const permissionSpy = (listTopicDecisionsProcedure as unknown as HandlerBearing)
	.__permission;
const answerHandler = (
	answerTopicQuestionProcedure as unknown as HandlerBearing
).handler;
const answerPermissionSpy = (
	answerTopicQuestionProcedure as unknown as HandlerBearing
).__permission;
// The REAL `z.object({...})` from topic-decisions.ts — captured by the
// `.input()` hook in the mocked chain above, not rebuilt here.
const answerInputSchema = (
	answerTopicQuestionProcedure as unknown as HandlerBearing
).__inputSchema;
const answerOutputSchema = (
	answerTopicQuestionProcedure as unknown as HandlerBearing
).__outputSchema;
const amendHandler = (amendTopicQuestionProcedure as unknown as HandlerBearing)
	.handler;
const amendInputSchema = (
	amendTopicQuestionProcedure as unknown as HandlerBearing
).__inputSchema;
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

const API_AMEND_INPUT = {
	projectId: "proj-1",
	topicId: "topic-1",
	questionId: "q-customer-name",
	supersedesId: "root-1",
	answer: "Yes, after legal review.",
	answerSource: "MANUAL" as const,
};

async function callAnswer(input: Record<string, unknown>) {
	return answerHandler({ input, context: ctx });
}

async function callAmend(input: Record<string, unknown>) {
	return amendHandler({ input, context: ctx });
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "user-session",
	});
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
	vi.mocked(amendTopicQuestionAnswer).mockResolvedValue({
		status: "amended",
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
			content: "Yes, after legal review.",
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: "MANUAL",
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

/**
 * A whitespace-only answer is refused at the input boundary, not inside the
 * handler (Fizzy #1988 1B). `.min(1)` alone accepts `"   "` — its length is
 * 3 — so both write procedures add a `\S` regex check on top of it; the
 * stored text is never trimmed, only checked.
 *
 * Each case below runs the REAL input schema first, exactly as the real oRPC
 * pipeline would: a rejected parse must mean the handler — and therefore the
 * underlying database query — is never reached.
 */
describe("answerTopicQuestion: a whitespace-only answer is refused (Fizzy #1988 1B)", () => {
	async function submitAnswer(input: Record<string, unknown>) {
		const parsed = answerInputSchema.safeParse(input);
		if (!parsed.success) {
			return { accepted: false as const, issues: parsed.error.issues };
		}
		return { accepted: true as const, result: await callAnswer(input) };
	}

	it("refuses '   ' with a clear message, and never reaches answerTopicQuestion", async () => {
		const outcome = await submitAnswer({
			...API_ANSWER_INPUT,
			answer: "   ",
		});

		expect(outcome.accepted).toBe(false);
		if (!outcome.accepted) {
			expect(outcome.issues.map((issue) => issue.message)).toContain(
				"An answer cannot be only whitespace.",
			);
		}
		expect(answerTopicQuestion).not.toHaveBeenCalled();
	});

	it("refuses a tab/newline mix the same as plain spaces", async () => {
		const outcome = await submitAnswer({
			...API_ANSWER_INPUT,
			answer: "\t\n  ",
		});

		expect(outcome.accepted).toBe(false);
		if (!outcome.accepted) {
			expect(outcome.issues.map((issue) => issue.message)).toContain(
				"An answer cannot be only whitespace.",
			);
		}
		expect(answerTopicQuestion).not.toHaveBeenCalled();
	});

	it("accepts real text surrounded by whitespace, unmodified", async () => {
		const outcome = await submitAnswer({
			...API_ANSWER_INPUT,
			answer: "  Yes  ",
		});

		expect(outcome.accepted).toBe(true);
		expect(answerTopicQuestion).toHaveBeenCalledWith(
			expect.objectContaining({ answer: "  Yes  " }),
		);
	});

	it("still accepts a normal answer", async () => {
		const outcome = await submitAnswer(API_ANSWER_INPUT);

		expect(outcome.accepted).toBe(true);
		expect(answerTopicQuestion).toHaveBeenCalled();
	});
});

describe("amendTopicQuestion: a whitespace-only answer is refused (Fizzy #1988 1B)", () => {
	async function submitAmend(input: Record<string, unknown>) {
		const parsed = amendInputSchema.safeParse(input);
		if (!parsed.success) {
			return { accepted: false as const, issues: parsed.error.issues };
		}
		return { accepted: true as const, result: await callAmend(input) };
	}

	it("refuses '   ' with a clear message, and never reaches amendTopicQuestionAnswer", async () => {
		const outcome = await submitAmend({
			...API_AMEND_INPUT,
			answer: "   ",
		});

		expect(outcome.accepted).toBe(false);
		if (!outcome.accepted) {
			expect(outcome.issues.map((issue) => issue.message)).toContain(
				"An answer cannot be only whitespace.",
			);
		}
		expect(amendTopicQuestionAnswer).not.toHaveBeenCalled();
	});

	it("refuses a tab/newline mix the same as plain spaces", async () => {
		const outcome = await submitAmend({
			...API_AMEND_INPUT,
			answer: "\t\n  ",
		});

		expect(outcome.accepted).toBe(false);
		if (!outcome.accepted) {
			expect(outcome.issues.map((issue) => issue.message)).toContain(
				"An answer cannot be only whitespace.",
			);
		}
		expect(amendTopicQuestionAnswer).not.toHaveBeenCalled();
	});

	it("accepts real text surrounded by whitespace, unmodified", async () => {
		const outcome = await submitAmend({
			...API_AMEND_INPUT,
			answer: "  Yes  ",
		});

		expect(outcome.accepted).toBe(true);
		expect(amendTopicQuestionAnswer).toHaveBeenCalledWith(
			expect.objectContaining({ answer: "  Yes  " }),
		);
	});

	it("still accepts a normal answer", async () => {
		const outcome = await submitAmend(API_AMEND_INPUT);

		expect(outcome.accepted).toBe(true);
		expect(amendTopicQuestionAnswer).toHaveBeenCalled();
	});
});

/**
 * The whitespace-only rule must also show up in the published OpenAPI
 * document, not just at runtime (Fizzy #1988 1B). A `.refine()` is invisible
 * to `ZodToJsonSchemaConverter` — the same converter `packages/api/index.ts`
 * builds `/openapi` with — so this runs the REAL captured input schema
 * through the REAL converter, the same way `/openapi` does, rather than
 * asserting against a hand-rolled JSON Schema fragment.
 */
describe("answerBodySchema is published as a pattern in the OpenAPI document (Fizzy #1988 1B)", () => {
	const converter = new ZodToJsonSchemaConverter();

	it.each([
		["answerTopicQuestionProcedure", answerInputSchema],
		["amendTopicQuestionProcedure", amendInputSchema],
	])(
		"%s advertises answer's whitespace rule as a pattern",
		(_name, schema) => {
			const [, json] = converter.convert(
				schema as unknown as ConvertibleSchema,
				{
					strategy: "input",
				},
			);

			expect(json).toMatchObject({
				properties: {
					answer: {
						type: "string",
						minLength: 1,
						maxLength: 10_000,
						pattern: "\\S",
					},
				},
			});
		},
	);
});

/**
 * The version of the question the caller answered (Fizzy #1988). A newer
 * analysis can rewrite an open question while a member is writing; an answer
 * sent with the version they saw is refused as `question_changed` — a result,
 * not an error, so the page can tell it from a failure. A caller that sends no
 * version is not checked.
 */
describe("answerTopicQuestion: the version the caller answered (Fizzy #1988)", () => {
	const EXPECTED_VERSION_DESCRIPTION =
		"The analysisVersion of the question as the caller displayed it. When given, an answer to a question that a newer analysis has refreshed since, even with unchanged wording, is not recorded, and the result status is question_changed. Omit it to skip the check.";

	it.each([
		["a version", 3],
		["null, for a question with no version", null],
	] as const)(
		"passes %s through to the database helper",
		async (_label, version) => {
			await callAnswer({
				...API_ANSWER_INPUT,
				expectedAnalysisVersion: version,
			});

			expect(answerTopicQuestion).toHaveBeenCalledWith(
				expect.objectContaining({ expectedAnalysisVersion: version }),
			);
		},
	);

	it("passes undefined when the caller sends no version, so the answer is not checked", async () => {
		// An own `expectedAnalysisVersion: undefined` key is correct here: the
		// database helper checks only a version that is `!== undefined`, and
		// its own suite proves an omitted version adds nothing to the claim.
		await callAnswer(API_ANSWER_INPUT);

		expect(vi.mocked(answerTopicQuestion)).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(answerTopicQuestion).mock.calls[0]?.[0]
				?.expectedAnalysisVersion,
		).toBeUndefined();
	});

	it("returns question_changed as a result the output schema accepts, not an error", async () => {
		vi.mocked(answerTopicQuestion).mockResolvedValue({
			status: "question_changed",
			root: null,
		});

		const result = await callAnswer({
			...API_ANSWER_INPUT,
			expectedAnalysisVersion: 1,
		});

		expect(result).toEqual({ status: "question_changed", root: null });
		expect(answerOutputSchema.safeParse(result).success).toBe(true);
	});

	it("accepts a whole number, null or nothing, and refuses a fraction", () => {
		expect(
			answerInputSchema.safeParse({
				...API_ANSWER_INPUT,
				expectedAnalysisVersion: 2,
			}).success,
		).toBe(true);
		expect(
			answerInputSchema.safeParse({
				...API_ANSWER_INPUT,
				expectedAnalysisVersion: null,
			}).success,
		).toBe(true);
		expect(answerInputSchema.safeParse(API_ANSWER_INPUT).success).toBe(
			true,
		);
		expect(
			answerInputSchema.safeParse({
				...API_ANSWER_INPUT,
				expectedAnalysisVersion: 1.5,
			}).success,
		).toBe(false);
	});

	it("describes the field in the OpenAPI document, as optional", () => {
		const [, json] = new ZodToJsonSchemaConverter().convert(
			answerInputSchema as unknown as ConvertibleSchema,
			{ strategy: "input" },
		);

		expect(json).toMatchObject({
			properties: {
				expectedAnalysisVersion: {
					description: EXPECTED_VERSION_DESCRIPTION,
				},
			},
		});
		expect((json as { required?: string[] }).required ?? []).not.toContain(
			"expectedAnalysisVersion",
		);
	});
});
