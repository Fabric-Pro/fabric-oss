/**
 * `atlas.systemChat` (the System map's multi-repository chat): the same
 * event-stream contract and error mapping as `atlas.chat`.
 *
 * The event iterator yields every text delta as a plain string, then at most
 * ONE terminal object sentinel: `{ type: "atlas-chat-persist-failed" }` when
 * the assistant write was lost, else `{ type: "atlas-chat-interrupted" }`
 * when the reply was cut short. A missing AI provider is PRECONDITION_FAILED
 * in the resolver's own words; an Atlas error goes through `mapAtlasError`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ systemChat: vi.fn() }));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return { AIProviderNotConfiguredError };
});

vi.mock("@repo/atlas", () => {
	class AtlasError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
			this.name = "AtlasError";
		}
	}
	return {
		AtlasError,
		AtlasService: class {
			systemChat = m.systemChat;
		},
		systemChatInputSchema: {},
	};
});

// Capability gating is not what this file is about, and its flag lookup reads
// the project row — off here, so the door is inert and never reaches a database.
vi.mock("../../capabilities/flag", () => ({
	isCapabilityGatingEnabled: async () => false,
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

process.env.FABRIC_FEATURE_ATLAS = "true";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<AsyncGenerator<unknown>>;

const { systemChatProcedure } = await import("../procedures/system-chat");
const { handler } = systemChatProcedure as unknown as { handler: Handler };
const { AIProviderNotConfiguredError } = await import("@repo/ai");
const { AtlasError } = await import("@repo/atlas");

function ask() {
	return handler({
		input: {
			projectId: "project-example-1",
			repositoryIntegrationIds: ["integration-1", "integration-2"],
			mode: "TECHNICAL",
			messages: [{ role: "user", content: "How do the services talk?" }],
		},
		context: {
			user: { id: "user-example-1" },
			session: { id: "session-1" },
		},
	});
}

function stubSystemChat(
	deltas: string[],
	outcome: { persisted: boolean; interrupted: boolean },
) {
	m.systemChat.mockResolvedValue({
		textStream: (async function* () {
			yield* deltas;
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

describe("systemChatProcedure — stream composition and refusals", () => {
	it("yields only string deltas for a clean, persisted completion", async () => {
		stubSystemChat(["Hello", " world"], {
			persisted: true,
			interrupted: false,
		});

		expect(await collect(await ask())).toEqual(["Hello", " world"]);
	});

	it("appends persist-failed after the deltas when the write failed; persist-failed outranks interrupted", async () => {
		stubSystemChat(["Hello"], { persisted: false, interrupted: false });
		expect(await collect(await ask())).toEqual([
			"Hello",
			{ type: "atlas-chat-persist-failed" },
		]);

		stubSystemChat(["Hello"], { persisted: false, interrupted: true });
		expect(await collect(await ask())).toEqual([
			"Hello",
			{ type: "atlas-chat-persist-failed" },
		]);
	});

	it("appends interrupted after the deltas for a cut-short reply", async () => {
		stubSystemChat(["Partial"], { persisted: true, interrupted: true });

		expect(await collect(await ask())).toEqual([
			"Partial",
			{ type: "atlas-chat-interrupted" },
		]);
	});

	it("maps a missing provider to PRECONDITION_FAILED with the resolver's message, and an Atlas error through mapAtlasError", async () => {
		const refusal =
			"No AI provider configured. Please configure an AI provider in Settings → AI Providers.";
		m.systemChat.mockRejectedValue(
			new AIProviderNotConfiguredError(refusal),
		);
		await expect(ask()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: refusal,
		});

		m.systemChat.mockRejectedValue(
			new AtlasError("NO_REPOSITORY", "No repository is connected."),
		);
		await expect(ask()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "No repository is connected.",
		});
	});
});
