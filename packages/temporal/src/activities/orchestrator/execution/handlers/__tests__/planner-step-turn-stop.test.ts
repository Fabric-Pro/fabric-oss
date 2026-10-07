/**
 * Advisor Stop on a Planner chat (`save_reuse`): the step activity.
 *
 * `executeStep` routes a plan step through a handler, and a handler that
 * fails asks the registry to fall back to the MCP tool handler, which makes
 * further model calls. In a turn (`turnScope`, run inside the turn's dispatch
 * guard the way the worker's interceptor runs it) a stop must leave the step
 * instead: no handler converts it into a fallback request or a result, the
 * registry runs no fallback after one, the delegated agent gets the turn's
 * scope, the two provider requests made outside the model factory (OpenAI
 * text-to-speech, Perplexity) are refused once the turn is stopped, and the
 * activity heartbeats so a Stop can reach it. A failure that is not a stop
 * keeps its fallback, and a run without a turn behaves as before.
 */

import { guardDispatch } from "@repo/utils/dispatch-guard";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	generateText: vi.fn(),
	resolveOpenAiApiKey: vi.fn(),
	uploadFile: vi.fn(),
	delegateToAgent: vi.fn(),
	fetchCredentialsByIdAndProviderInTenant: vi.fn(),
	registryExecuteStep: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: h.checkDispatchable,
	fetchCredentialsByIdAndProviderInTenant:
		h.fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider: vi.fn(),
	db: {},
}));

vi.mock("@repo/ai", () => ({
	generateText: h.generateText,
	resolveOpenAiApiKey: h.resolveOpenAiApiKey,
}));

vi.mock("@repo/storage", () => ({ uploadFile: h.uploadFile }));

vi.mock("../../../utils", () => ({
	getAiModel: vi.fn(async () => ({ id: "example-model" })),
}));

vi.mock("../../../utils/partykit-publisher", () => ({
	publishStepProgress: vi.fn(async () => undefined),
	publishStepStart: vi.fn(async () => undefined),
	publishToolStart: vi.fn(async () => undefined),
	publishToolComplete: vi.fn(async () => undefined),
}));

vi.mock("../../../delegation", () => ({
	buildDelegationMessage: vi.fn(() => "Research the launch date"),
	delegateToAgent: h.delegateToAgent,
	getAgentCapabilities: vi.fn(async () => null),
	resolveAgentEndpoint: vi.fn(async () => ({
		name: "researcher",
		protocol: "a2a",
		deploymentUrl: "https://agent.example.com",
	})),
}));

vi.mock("../../../../weave/enrich-delegation", () => ({
	enrichWeaveDelegationMessage: vi.fn(async (args: { message: string }) =>
		String(args.message),
	),
	isWeaveAgent: vi.fn(() => false),
}));

vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));

vi.mock("../../../../shared/frame-service", () => ({}));

vi.mock("../../authority-gate", () => ({
	checkIntegrationAuthority: vi.fn(async () => ({ authorized: true })),
}));

vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

// `executeStep` builds its registry from this module; the registry tests
// below use the real `HandlerRegistry` from its own module.
vi.mock("../index", () => ({
	getDefaultHandlerRegistry: () => ({ executeStep: h.registryExecuteStep }),
}));

import {
	isTurnNotDispatchable,
	runWithTurnDispatch,
} from "../../../turn-dispatch";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../../types";
import { executeStep } from "../../execute-step";
import { AgentHandler } from "../agent-handler";
import { FabricAiHandler } from "../fabric-ai-handler";
import { HandlerRegistry } from "../handler-registry";
import { IntegrationHandler } from "../integration-handler";
import { LlmHandler } from "../llm-handler";
import type { HandlerContext, HandlerResult, StepHandler } from "../types";
import { buildContext, buildInput } from "./integration-handler-fixtures";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

/** Runs `fn` the way the worker runs a turn-scoped activity. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
	return runWithTurnDispatch(TURN_SCOPE, fn);
}

function stepInput(
	step: Partial<ExecuteStepInput["step"]>,
	withTurn: boolean,
): ExecuteStepInput {
	return {
		step: {
			id: "step-1",
			description: "Find the launch date",
			type: "api",
			status: "pending",
			order: 1,
			...step,
		},
		message: "When is the launch?",
		systemPrompt: "",
		variables: {},
		userId: TURN_SCOPE.userId,
		organizationId: TURN_SCOPE.organizationId,
		executionMode: "save_reuse",
		totalSteps: 1,
		stepIndex: 1,
		previousStepResults: [],
		...(withTurn ? { turnScope: TURN_SCOPE } : {}),
	};
}

/** The registry's fallback (the MCP tool handler in production). */
function fakeFallback() {
	const handler: StepHandler & { execute: ReturnType<typeof vi.fn> } = {
		name: "mcp-tool",
		capabilities: ["mcp_tool"],
		canHandle: () => true,
		execute: vi.fn(
			async (): Promise<HandlerResult> => ({
				handled: true,
				output: { status: "completed", response: "fallback answer" },
			}),
		),
	};
	return handler;
}

function registryWith(primary: StepHandler, fallback: StepHandler) {
	const registry = new HandlerRegistry();
	registry.register(() => primary, { priority: 1 });
	(
		registry as unknown as { fallbackInstance: StepHandler }
	).fallbackInstance = fallback;
	return registry;
}

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	h.checkDispatchable.mockResolvedValue({ ok: true });
	h.resolveOpenAiApiKey.mockResolvedValue("sk-example");
	h.uploadFile.mockResolvedValue(undefined);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("HandlerRegistry in a Planner turn", () => {
	const llmStep: Partial<ExecuteStepInput["step"]> = { capability: "llm" };

	it("a stop from the LLM handler leaves the step; the fallback never runs", async () => {
		const stop = turnStopped();
		h.generateText.mockRejectedValue(stop);
		const fallback = fakeFallback();
		const registry = registryWith(new LlmHandler(), fallback);

		await expect(
			inTurn(() => registry.executeStep(stepInput(llmStep, true))),
		).rejects.toBe(stop);
		expect(fallback.execute).not.toHaveBeenCalled();
	});

	it("a failure that is not a stop still falls back, in a turn", async () => {
		h.generateText.mockRejectedValue(new Error("provider overloaded"));
		const fallback = fakeFallback();
		const registry = registryWith(new LlmHandler(), fallback);

		const output = await inTurn(() =>
			registry.executeStep(stepInput(llmStep, true)),
		);

		expect(output.response).toBe("fallback answer");
		expect(fallback.execute).toHaveBeenCalledTimes(1);
	});

	it("without a turn, the LLM handler's failure falls back as before", async () => {
		h.generateText.mockRejectedValue(turnStopped());
		const fallback = fakeFallback();
		const registry = registryWith(new LlmHandler(), fallback);

		const output = await registry.executeStep(stepInput(llmStep, false));

		expect(output.response).toBe("fallback answer");
	});

	it("a handler that swallowed a stop the guard saw neither returns its result nor falls back", async () => {
		h.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});
		const fallback = fakeFallback();
		// Stands in for a handler whose provider request was refused and
		// which turned the failure into "no results" / a fallback request.
		const swallowing: StepHandler = {
			name: "swallowing",
			capabilities: ["llm"],
			canHandle: () => true,
			execute: async (): Promise<HandlerResult> => {
				try {
					await guardDispatch();
				} catch {
					// swallowed
				}
				return {
					handled: false,
					shouldFallback: true,
					fallbackReason: "provider failed",
				};
			},
		};
		const registry = registryWith(swallowing, fallback);

		const failure = await inTurn(() =>
			registry.executeStep(stepInput(llmStep, true)),
		).catch((error: unknown) => error);

		expect(isTurnNotDispatchable(failure)).toBe(true);
		expect(fallback.execute).not.toHaveBeenCalled();
	});
});

describe("AgentHandler in a Planner turn", () => {
	const agentStep: Partial<ExecuteStepInput["step"]> = {
		capability: "agent",
		app: "researcher",
	};

	it("hands the turn scope to the delegation", async () => {
		h.delegateToAgent.mockResolvedValue({
			status: "completed",
			response: "The 12th.",
			artifacts: [],
			durationMs: 5,
		});
		const registry = registryWith(new AgentHandler(), fakeFallback());

		await new MockActivityEnvironment().run(() =>
			inTurn(() => registry.executeStep(stepInput(agentStep, true))),
		);

		expect(h.delegateToAgent).toHaveBeenCalledWith(
			expect.objectContaining({ turnScope: TURN_SCOPE }),
		);
	});

	it("a stopped delegation leaves the step; the MCP fallback never runs", async () => {
		const stop = turnStopped();
		h.delegateToAgent.mockRejectedValue(stop);
		const fallback = fakeFallback();
		const registry = registryWith(new AgentHandler(), fallback);

		await expect(
			new MockActivityEnvironment().run(() =>
				inTurn(() => registry.executeStep(stepInput(agentStep, true))),
			),
		).rejects.toBe(stop);
		expect(fallback.execute).not.toHaveBeenCalled();
	});

	it("without a turn, a failed delegation falls back as before and carries no scope", async () => {
		h.delegateToAgent.mockRejectedValue(new Error("agent unreachable"));
		const fallback = fakeFallback();
		const registry = registryWith(new AgentHandler(), fallback);

		const output = (await new MockActivityEnvironment().run(() =>
			registry.executeStep(stepInput(agentStep, false)),
		)) as ExecuteStepOutput;

		expect(output.response).toBe("fallback answer");
		expect(h.delegateToAgent.mock.calls[0]?.[0]).not.toHaveProperty(
			"turnScope",
		);
	});
});

describe("provider requests outside the model factory", () => {
	function ttsContext(withTurn: boolean): HandlerContext {
		const input = stepInput(
			{
				app: "fabric_text_to_speech",
				inputs: { text: "The launch is on the 12th." },
			},
			withTurn,
		);
		return { input, variables: {}, toolCalls: [], startTime: Date.now() };
	}

	it("OpenAI text-to-speech is refused once the turn is stopped, and nothing is sent", async () => {
		h.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const failure = await inTurn(() =>
			new FabricAiHandler().execute(ttsContext(true)),
		).catch((error: unknown) => error);

		expect(isTurnNotDispatchable(failure)).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("OpenAI text-to-speech in a live turn carries the guard's abort signal", async () => {
		fetchMock.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
		);

		await inTurn(() => new FabricAiHandler().execute(ttsContext(true)));

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("OpenAI text-to-speech without a turn is sent as before, with no signal", async () => {
		fetchMock.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
		);

		const result = await new FabricAiHandler().execute(ttsContext(false));

		expect(result.handled).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/audio/speech");
		expect(init.signal).toBeUndefined();
	});

	function perplexityContext(withTurn: boolean): HandlerContext {
		const input = buildInput("PERPLEXITY", {
			inputs: { operation: "search", query: "launch date" },
		});
		return buildContext(
			withTurn ? { ...input, turnScope: TURN_SCOPE } : input,
		);
	}

	it("Perplexity is refused once the turn is stopped, and nothing is sent", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			PERPLEXITY_API_KEY: "pplx-example",
		});
		h.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const failure = await inTurn(() =>
			new IntegrationHandler().execute(perplexityContext(true)),
		).catch((error: unknown) => error);

		expect(isTurnNotDispatchable(failure)).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("Perplexity without a turn is sent as before, with no signal", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			PERPLEXITY_API_KEY: "pplx-example",
		});
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "The 12th." } }],
				}),
				{ status: 200 },
			),
		);

		const result = await new IntegrationHandler().execute(
			perplexityContext(false),
		);

		expect(result.handled).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.perplexity.ai/chat/completions");
		expect(init.signal).toBeUndefined();
	});
});

describe("executeStep heartbeats", () => {
	it("heartbeats in a turn, so a Stop can reach it, and not without one", async () => {
		h.registryExecuteStep.mockResolvedValue({ status: "completed" });

		const withTurn = new MockActivityEnvironment();
		let turnBeats = 0;
		withTurn.on("heartbeat", () => {
			turnBeats++;
		});
		await withTurn.run(() =>
			inTurn(() => executeStep(stepInput({ capability: "llm" }, true))),
		);
		expect(turnBeats).toBeGreaterThan(0);

		const noTurn = new MockActivityEnvironment();
		let legacyBeats = 0;
		noTurn.on("heartbeat", () => {
			legacyBeats++;
		});
		await noTurn.run(() =>
			executeStep(stepInput({ capability: "llm" }, false)),
		);
		expect(legacyBeats).toBe(0);
	});

	it("stops heartbeating when the step fails", async () => {
		vi.useFakeTimers();
		try {
			h.registryExecuteStep.mockRejectedValue(new Error("step broke"));
			const env = new MockActivityEnvironment();
			let beats = 0;
			env.on("heartbeat", () => {
				beats++;
			});
			await expect(
				env.run(() =>
					inTurn(() =>
						executeStep(stepInput({ capability: "llm" }, true)),
					),
				),
			).rejects.toThrow("step broke");
			const afterRun = beats;
			await vi.advanceTimersByTimeAsync(20_000);
			expect(beats).toBe(afterRun);
		} finally {
			vi.useRealTimers();
		}
	});
});
