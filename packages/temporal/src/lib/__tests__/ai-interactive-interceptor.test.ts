/**
 * A run a person started with `planEligible: true` carries their user id in a
 * Temporal header to every activity and child workflow, where model calls for
 * that user count as interactive and may use their ChatGPT plan (Fizzy #2939).
 * Pins each hop, and the whole path from a plan-eligible document generation
 * to the EVAL model resolution in its evaluation child workflow.
 */
import {
	isAiInteractiveRequestFor,
	runWithAiInteractiveContext,
} from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { defaultPayloadConverter } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAIModelWithMetadata: vi.fn() }));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
}));

import { resolveEvalModel } from "../../activities/document-eval/mastra-config";
import {
	TEMPORAL_AI_INTERACTIVE_HEADER as WORKFLOW_SIDE_HEADER,
	TEMPORAL_AI_IMPERSONATED_HEADER as WORKFLOW_SIDE_IMPERSONATED_HEADER,
	interceptors as workflowInterceptors,
} from "../../workflows/correlation-workflow-interceptor";
import {
	AiInteractiveActivityInboundInterceptor,
	makeAiInteractiveClientInterceptor,
	TEMPORAL_AI_IMPERSONATED_HEADER,
	TEMPORAL_AI_INTERACTIVE_HEADER,
} from "../ai-interactive-interceptor";

type Headers = Record<string, unknown>;

async function startHeaders(args: unknown[], headers: Headers = {}) {
	const interceptor = makeAiInteractiveClientInterceptor();
	let outgoing: Headers | undefined;
	await interceptor.start?.(
		{ headers, options: { args } } as never,
		(async (input: { headers: Headers }) => {
			outgoing = input.headers;
			return "run-1";
		}) as never,
	);
	return outgoing ?? {};
}

function decode(headers: Headers): unknown {
	const payload = headers[TEMPORAL_AI_INTERACTIVE_HEADER];
	return payload === undefined
		? undefined
		: defaultPayloadConverter.fromPayload(payload as never);
}

/** Runs one workflow's interceptors: captures start headers, returns what an outbound call carries. */
async function forwardThroughWorkflow(
	startHeaders: Headers,
	outbound: "scheduleActivity" | "startChildWorkflowExecution",
): Promise<Headers> {
	const { inbound, outbound: out } = workflowInterceptors();
	await inbound?.[0]?.execute?.(
		{ headers: startHeaders, args: [] } as never,
		(async () => undefined) as never,
	);
	let forwarded: Headers = {};
	const capture = ((input: { headers?: Headers }) => {
		forwarded = input.headers ?? {};
		return Promise.resolve(undefined);
	}) as never;
	if (outbound === "scheduleActivity") {
		await out?.[0]?.scheduleActivity?.({ headers: {} } as never, capture);
	} else {
		await out?.[0]?.startChildWorkflowExecution?.(
			{ headers: {} } as never,
			capture,
		);
	}
	return forwarded;
}

beforeEach(() => {
	mocks.getAIModelWithMetadata.mockReset();
});

describe("makeAiInteractiveClientInterceptor", () => {
	it("stamps the starting user when the input is plan-eligible", async () => {
		const headers = await startHeaders([
			{ userId: "user-1", planEligible: true },
		]);
		expect(decode(headers)).toBe("user-1");
	});

	it("stamps nothing when the input does not say so", async () => {
		for (const input of [
			{ userId: "user-1" },
			{ userId: "user-1", planEligible: false },
			{ planEligible: true },
			"not-an-object",
		]) {
			expect(decode(await startHeaders([input]))).toBeUndefined();
		}
		expect(decode(await startHeaders([]))).toBeUndefined();
	});

	it("keeps the caller's other headers", async () => {
		const headers = await startHeaders(
			[{ userId: "user-1", planEligible: true }],
			{ other: "kept" },
		);
		expect(headers.other).toBe("kept");
	});
});

describe("AiInteractiveActivityInboundInterceptor", () => {
	const interceptor = new AiInteractiveActivityInboundInterceptor();
	const observe = (headers: Headers) =>
		interceptor.execute(
			{ headers, args: [] } as never,
			(async () => ({
				self: isAiInteractiveRequestFor("user-1"),
				other: isAiInteractiveRequestFor("user-2"),
			})) as never,
		);

	it("marks the activity interactive for the header's user only", async () => {
		const headers = await startHeaders([
			{ userId: "user-1", planEligible: true },
		]);
		await expect(observe(headers)).resolves.toEqual({
			self: true,
			other: false,
		});
	});

	it("marks nothing without the header, or with a malformed one", async () => {
		await expect(observe({})).resolves.toEqual({
			self: false,
			other: false,
		});
		await expect(
			observe({
				[TEMPORAL_AI_INTERACTIVE_HEADER]: { metadata: {}, data: "%%" },
			}),
		).resolves.toEqual({ self: false, other: false });
	});
});

describe("workflow-side forwarding", () => {
	it("uses the same header names as the client side", () => {
		expect(WORKFLOW_SIDE_HEADER).toBe(TEMPORAL_AI_INTERACTIVE_HEADER);
		expect(WORKFLOW_SIDE_IMPERSONATED_HEADER).toBe(
			TEMPORAL_AI_IMPERSONATED_HEADER,
		);
	});

	it("forwards the header to activities and child workflows", async () => {
		const headers = await startHeaders([
			{ userId: "user-1", planEligible: true },
		]);
		expect(
			decode(await forwardThroughWorkflow(headers, "scheduleActivity")),
		).toBe("user-1");
		expect(
			decode(
				await forwardThroughWorkflow(
					headers,
					"startChildWorkflowExecution",
				),
			),
		).toBe("user-1");
	});

	it("forwards nothing for a run started without it", async () => {
		const headers = await startHeaders([{ userId: "user-1" }]);
		expect(
			decode(await forwardThroughWorkflow(headers, "scheduleActivity")),
		).toBeUndefined();
	});
});

describe("a plan-eligible document generation's evaluation step", () => {
	async function evalCallInsideRun(input: Record<string, unknown>) {
		// projectDocumentGenerationWorkflow start → its documentEvalWorkflow
		// child → the child's activity, which resolves the EVAL model.
		const parentStart = await startHeaders([input]);
		const childStart = await forwardThroughWorkflow(
			parentStart,
			"startChildWorkflowExecution",
		);
		const activityHeaders = await forwardThroughWorkflow(
			childStart,
			"scheduleActivity",
		);
		let interactive: boolean | undefined;
		mocks.getAIModelWithMetadata.mockImplementation(
			async (_options: unknown, context: { userId: string }) => {
				interactive = isAiInteractiveRequestFor(context.userId);
				return { model: {}, metadata: {}, trackUsage: () => {} };
			},
		);
		await new AiInteractiveActivityInboundInterceptor().execute(
			{ headers: activityHeaders, args: [] } as never,
			(() =>
				resolveEvalModel({
					userId: "user-1",
					organizationId: "org-1",
				})) as never,
		);
		return {
			interactive,
			call: mocks.getAIModelWithMetadata.mock.calls[0],
		};
	}

	it("resolves the EVAL model as the member's interactive work", async () => {
		const { interactive, call } = await evalCallInsideRun({
			userId: "user-1",
			planEligible: true,
		});
		expect(call?.[0]).toEqual({ taskType: "EVAL" });
		// No explicit flag on the call itself, so the run's marker decides.
		expect(call?.[1]).not.toHaveProperty("planEligible");
		expect(interactive).toBe(true);
	});

	it("leaves the evaluation of a run not started that way on the organization", async () => {
		const { interactive } = await evalCallInsideRun({ userId: "user-1" });
		expect(interactive).toBe(false);
	});
});

describe("a run started while an admin acts as the member", () => {
	it("gets no header, and its input's plan eligibility is cleared", async () => {
		const interceptor = makeAiInteractiveClientInterceptor();
		let sent:
			| { headers: Headers; options: { args: unknown[] } }
			| undefined;
		await runWithAiInteractiveContext(
			{ userId: "user-1", impersonated: true },
			() =>
				interceptor.start?.(
					{
						headers: {},
						options: {
							args: [
								{ userId: "user-1", planEligible: true },
								"second",
							],
						},
					} as never,
					(async (input: typeof sent) => {
						sent = input;
						return "run-1";
					}) as never,
				),
		);
		expect(decode(sent?.headers ?? {})).toBeUndefined();
		expect(
			defaultPayloadConverter.fromPayload(
				sent?.headers[TEMPORAL_AI_IMPERSONATED_HEADER] as never,
			),
		).toBe("user-1");
		expect(sent?.options.args).toEqual([
			{ userId: "user-1", planEligible: false },
			"second",
		]);
	});

	it("runs every activity as impersonated, so a token it mints can never hand over the plan", async () => {
		const { issueAIToken, verifyAIToken } = await import("@repo/ai-token");
		const { isAiImpersonatedRequest } = await import(
			"@repo/ai/lib/chatgpt-plan/interactive-context"
		);
		const previousSecret = process.env.AI_TOKEN_SECRET;
		process.env.AI_TOKEN_SECRET = "test-secret-key-for-ai-tokens-32-chars";
		try {
			let startHeadersSent: Headers = {};
			await runWithAiInteractiveContext(
				{ userId: "user-1", impersonated: true },
				() =>
					makeAiInteractiveClientInterceptor().start?.(
						{
							headers: {},
							options: {
								args: [
									{ userId: "user-1", planEligible: true },
								],
							},
						} as never,
						(async (input: { headers: Headers }) => {
							startHeadersSent = input.headers;
							return "run-1";
						}) as never,
					),
			);
			const activityHeaders = await forwardThroughWorkflow(
				startHeadersSent,
				"scheduleActivity",
			);
			// What delegate-to-agent mints inside the activity.
			const token =
				(await new AiInteractiveActivityInboundInterceptor().execute(
					{ headers: activityHeaders, args: [] } as never,
					(() =>
						issueAIToken({
							userId: "user-1",
							source: "orchestrator->agent",
							planEligible: isAiInteractiveRequestFor("user-1"),
							impersonated: isAiImpersonatedRequest(),
						})) as never,
				)) as string;
			const verified = await verifyAIToken(token);
			expect(verified.valid && verified.claims.imp).toBe(true);
			expect(verified.valid && verified.claims.pe).toBeUndefined();
		} finally {
			if (previousSecret === undefined) {
				delete process.env.AI_TOKEN_SECRET;
			} else {
				process.env.AI_TOKEN_SECRET = previousSecret;
			}
		}
	});

	it("leaves an input without the field untouched, and still marks the run impersonated", async () => {
		const interceptor = makeAiInteractiveClientInterceptor();
		const input = {
			headers: {},
			options: { args: [{ userId: "user-1" }] },
		};
		let sent: { headers: Headers; options: unknown } | undefined;
		await runWithAiInteractiveContext(
			{ userId: "user-1", impersonated: true },
			() =>
				interceptor.start?.(
					input as never,
					(async (value: typeof sent) => {
						sent = value;
						return "run-1";
					}) as never,
				),
		);
		expect(sent?.options).toBe(input.options);
		expect(
			defaultPayloadConverter.fromPayload(
				sent?.headers[TEMPORAL_AI_IMPERSONATED_HEADER] as never,
			),
		).toBe("user-1");
	});

	it("does not mark a delegated agent's token", () => {
		// delegate-to-agent and delegate-to-weave-agent set the `pe` claim
		// from this check.
		expect(
			runWithAiInteractiveContext(
				{ userId: "user-1", impersonated: true },
				() => isAiInteractiveRequestFor("user-1"),
			),
		).toBe(false);
	});
});
