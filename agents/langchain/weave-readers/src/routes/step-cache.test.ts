/**
 * The reader routes pass a rolling Anthropic cache breakpoint as `prepareStep`
 * to their tool loops (Fizzy #3099), gated like every other tool loop: only
 * when the call sends tools and the resolved model takes the marker. The
 * breakpoint's own behaviour is tested in `@repo/ai`
 * (`lib/__tests__/step-cache-breakpoint.test.ts`).
 *
 * Mocked: model resolution and `generateText`, which records its arguments.
 */

import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import type { Hono } from "hono";
import { afterEach, describe, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	provider: "ANTHROPIC_DIRECT",
	modelString: "claude-sonnet-5-5",
	calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../lib/llm.js", () => ({
	resolveReaderModel: async () => ({
		model: { modelId: "fake" },
		provider: state.provider,
		modelString: state.modelString,
	}),
}));
vi.mock("ai", async () => {
	const ai = await vi.importActual<typeof import("ai")>("ai");
	return {
		...ai,
		generateText: async (options: Record<string, unknown>) => {
			state.calls.push(options);
			return { text: "ok" };
		},
	};
});

import { a2aRoute } from "./a2a.js";
import { spindleRoute } from "./spindle.js";

type StepPreparer = (options: {
	messages: ModelMessage[];
	initialMessages: ModelMessage[];
}) => { messages?: ModelMessage[] };

async function post(
	route: Hono,
	path: string,
	metadata: Record<string, unknown>,
) {
	const response = await route.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			message: "Find the docs",
			metadata: {
				tenantContext: { userId: "user-1", organizationId: "org-1" },
				...metadata,
			},
		}),
	});
	await response.text();
	assert.equal(state.calls.length, 1);
	return state.calls[0];
}

function lastMessageMarked(prepareStep: unknown): boolean {
	const messages: ModelMessage[] = [{ role: "user", content: "go" }];
	const prepared = (prepareStep as StepPreparer)({
		messages,
		initialMessages: messages,
	}).messages;
	return Boolean(prepared?.at(-1)?.providerOptions?.anthropic?.cacheControl);
}

describe("reader route tool loops — per-step cache breakpoint", () => {
	afterEach(() => {
		state.calls = [];
		state.provider = "ANTHROPIC_DIRECT";
		state.modelString = "claude-sonnet-5-5";
	});

	it("spindle passes a prepareStep that marks the last message on a Claude route", async () => {
		const call = await post(spindleRoute, "/research", {});
		assert.ok(call.tools);
		assert.equal(lastMessageMarked(call.prepareStep), true);
	});

	it("spindle passes no prepareStep for a provider that does not take the marker", async () => {
		state.provider = "OPENAI";
		state.modelString = "gpt-6.1";
		const call = await post(spindleRoute, "/research", {});
		assert.ok(call.tools);
		assert.equal(call.prepareStep, undefined);
	});

	it("a2a passes the prepareStep with the tools it sends", async () => {
		const call = await post(a2aRoute, "/send", { skillId: "spindle" });
		assert.ok(call.tools);
		assert.equal(lastMessageMarked(call.prepareStep), true);
	});

	it("a2a passes neither tools nor a prepareStep when the agent has no tools", async () => {
		// Thread with no sandbox session gets no tools.
		const call = await post(a2aRoute, "/send", { skillId: "thread" });
		assert.equal("tools" in call, false);
		assert.equal("prepareStep" in call, false);
	});
});
