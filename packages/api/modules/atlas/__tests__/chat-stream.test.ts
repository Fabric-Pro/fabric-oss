/**
 * `atlas.chat` procedure — event-stream composition.
 *
 * Locks the API contract: the returned event iterator yields every text delta
 * as a plain string (unchanged), then a served-model object when known,
 * followed by at most ONE terminal sentinel —
 * `{ type: "atlas-chat-persist-failed" }` when the assistant write was lost,
 * else `{ type: "atlas-chat-interrupted" }` when an abort/error path cut the
 * reply off (the SDK closes the text stream normally on provider errors, so
 * the stream itself carries no error signal — including the
 * error-before-first-token case, which would otherwise look like an endless
 * empty stream to the live client). Old clients ignore non-string events, so
 * the model event and both sentinels are backward compatible.
 */
import type { AnswerModelInfo } from "@repo/ai/lib/answer-model-info";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockChat = vi.fn();

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
}));

vi.mock("@repo/atlas", () => ({
	AtlasService: class {
		chat(...args: unknown[]) {
			return mockChat(...args);
		}
	},
	atlasChatInputSchema: {},
}));

// Capability gating is not what this file is about, and its flag lookup reads
// the project row — off here, so the door is inert and never reaches a database.
vi.mock("../../capabilities/flag", () => ({
	isCapabilityGatingEnabled: async () => false,
}));

vi.mock("../lib", () => ({
	assertAtlasEnabled: vi.fn(),
	mapAtlasError: (error: unknown) => {
		throw error;
	},
}));

vi.mock("../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string };
		session: { id: string };
	};
}) => Promise<AsyncGenerator<unknown>>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../procedures/chat");
	return (mod.atlasChatProcedure as unknown as { handler: Handler }).handler;
}

const baseInput = {
	projectId: "p1",
	repositoryIntegrationId: "int-1",
	mode: "TECHNICAL",
	messages: [{ role: "user", content: "How does auth work?" }],
};

const baseContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

function stubServiceChat(
	deltas: string[],
	outcome: { persisted: boolean; interrupted: boolean },
	model?: AnswerModelInfo,
) {
	mockChat.mockResolvedValue({
		textStream: (async function* () {
			for (const delta of deltas) {
				yield delta;
			}
		})(),
		persistOutcome: Promise.resolve(outcome),
		getAnswerModel: () => model,
	});
}

async function collect(iterator: AsyncGenerator<unknown>): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of iterator) {
		events.push(event);
	}
	return events;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("atlasChatProcedure — stream composition", () => {
	it("reads the final identity only after the assistant persistence settles", async () => {
		let settle: (outcome: {
			persisted: boolean;
			interrupted: boolean;
		}) => void = () => {};
		const persistOutcome = new Promise<{
			persisted: boolean;
			interrupted: boolean;
		}>((resolve) => {
			settle = resolve;
		});
		let model = { id: "example-initial", viaPlan: true };
		const getAnswerModel = vi.fn(() => model);
		mockChat.mockResolvedValue({
			textStream: (async function* () {
				yield "Answer";
			})(),
			persistOutcome,
			getAnswerModel,
		});
		const handler = await loadHandler();
		const iterator = await handler({
			input: baseInput,
			context: baseContext,
		});
		expect(await iterator.next()).toEqual({ value: "Answer", done: false });
		const next = iterator.next();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(getAnswerModel).not.toHaveBeenCalled();
		model = { id: "example-actual-served", viaPlan: false };
		settle({ persisted: true, interrupted: false });
		expect(await next).toEqual({
			value: { type: "atlas-chat-model", model },
			done: false,
		});
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
		expect(getAnswerModel).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ persisted: true, interrupted: false, note: undefined },
		{ persisted: true, interrupted: true, note: "atlas-chat-interrupted" },
		{
			persisted: false,
			interrupted: false,
			note: "atlas-chat-persist-failed",
		},
		{
			persisted: false,
			interrupted: true,
			note: "atlas-chat-persist-failed",
		},
	])(
		"emits served identity after text and before the terminal note ($persisted/$interrupted)",
		async ({ persisted, interrupted, note }) => {
			const model = {
				id: "example-actual-served",
				provider: "OPENAI_DIRECT",
				viaPlan: false,
			};
			stubServiceChat(
				["Partial", " answer"],
				{ persisted, interrupted },
				model,
			);
			const handler = await loadHandler();
			expect(
				await collect(
					await handler({ input: baseInput, context: baseContext }),
				),
			).toEqual([
				"Partial",
				" answer",
				{ type: "atlas-chat-model", model },
				...(note ? [{ type: note }] : []),
			]);
			stubServiceChat(["Next answer"], {
				persisted: true,
				interrupted: false,
			});
			expect(
				await collect(
					await handler({ input: baseInput, context: baseContext }),
				),
			).toEqual(["Next answer"]);
		},
	);

	it("yields only string deltas for a clean completion with unknown served identity", async () => {
		stubServiceChat(["Hello", " world"], {
			persisted: true,
			interrupted: false,
		});

		const handler = await loadHandler();
		const events = await collect(
			await handler({ input: baseInput, context: baseContext }),
		);

		expect(events).toEqual(["Hello", " world"]);
	});

	it("appends the terminal persist-failed sentinel after the deltas when the write failed", async () => {
		stubServiceChat(["Hello", " world"], {
			persisted: false,
			interrupted: false,
		});

		const handler = await loadHandler();
		const events = await collect(
			await handler({ input: baseInput, context: baseContext }),
		);

		expect(events).toEqual([
			"Hello",
			" world",
			{ type: "atlas-chat-persist-failed" },
		]);
		// The sentinel is strictly terminal — nothing follows it.
		expect(events.at(-1)).toEqual({ type: "atlas-chat-persist-failed" });
	});

	it("appends the terminal interrupted sentinel after the deltas for a mid-stream error", async () => {
		// The SDK converts provider errors into error parts and ends the text
		// stream normally — the sentinel is the live client's only signal that
		// the rendered partial is incomplete.
		stubServiceChat(["Hello"], { persisted: true, interrupted: true });

		const handler = await loadHandler();
		const events = await collect(
			await handler({ input: baseInput, context: baseContext }),
		);

		expect(events).toEqual(["Hello", { type: "atlas-chat-interrupted" }]);
	});

	it("yields ONLY the interrupted sentinel for an error before the first token (no stuck spinner)", async () => {
		stubServiceChat([], { persisted: true, interrupted: true });

		const handler = await loadHandler();
		const events = await collect(
			await handler({ input: baseInput, context: baseContext }),
		);

		expect(events).toEqual([{ type: "atlas-chat-interrupted" }]);
	});

	it("prefers the persist-failed sentinel when an interrupted turn ALSO failed to persist", async () => {
		stubServiceChat(["Hello"], { persisted: false, interrupted: true });

		const handler = await loadHandler();
		const events = await collect(
			await handler({ input: baseInput, context: baseContext }),
		);

		// At most one terminal sentinel — persistence loss outranks the
		// interruption marker.
		expect(events).toEqual([
			"Hello",
			{ type: "atlas-chat-persist-failed" },
		]);
	});
});
