/**
 * `atlas.chat` procedure — event-stream composition.
 *
 * Locks the API contract: the returned event iterator yields every text delta
 * as a plain string (unchanged), then at most ONE terminal object sentinel —
 * `{ type: "atlas-chat-persist-failed" }` when the assistant write was lost,
 * else `{ type: "atlas-chat-interrupted" }` when an abort/error path cut the
 * reply off (the SDK closes the text stream normally on provider errors, so
 * the stream itself carries no error signal — including the
 * error-before-first-token case, which would otherwise look like an endless
 * empty stream to the live client). Old clients ignore non-string events, so
 * both sentinels are backward compatible.
 */
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
) {
	mockChat.mockResolvedValue({
		textStream: (async function* () {
			for (const delta of deltas) {
				yield delta;
			}
		})(),
		persistOutcome: Promise.resolve(outcome),
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
	it("yields only string deltas for a clean, persisted completion", async () => {
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
