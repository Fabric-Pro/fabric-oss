/**
 * One Atlas chat turn as both of its doors run it (`chat-turn.ts`): the
 * procedures and the agent runtime's `atlas-chat` engine share the service
 * call, the error mapping, the conversation check and the terminal note, so
 * the two cannot answer the same turn differently.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	serviceCtx: vi.fn(),
	chat: vi.fn(),
	getConversation: vi.fn(),
}));

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
			constructor(ctx: unknown) {
				m.serviceCtx(ctx);
			}
			chat = m.chat;
			getConversation = m.getConversation;
		},
	};
});

const {
	assertAtlasChatConversation,
	atlasChatTurnNote,
	rethrowAtlasChatError,
	startAtlasChat,
} = await import("../chat-turn");
const { AIProviderNotConfiguredError } = await import("@repo/ai");
const { AtlasError } = await import("@repo/atlas");

const CTX = { userId: "user-example-1", organizationId: "org-example-1" };
const TURN = {
	projectId: "project-example-1",
	repositoryIntegrationId: null,
	mode: "TECHNICAL" as const,
	conversationId: "conversation-example-1",
	messages: [{ role: "user" as const, content: "How does auth work?" }],
};

function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a throw");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("atlas chat turn", () => {
	it("atlasChatTurnNote: none / persist-failed / interrupted / persist-failed outranks interrupted", () => {
		expect(atlasChatTurnNote({ persisted: true, interrupted: false })).toBe(
			null,
		);
		expect(
			atlasChatTurnNote({ persisted: false, interrupted: false }),
		).toBe("persist-failed");
		expect(atlasChatTurnNote({ persisted: true, interrupted: true })).toBe(
			"interrupted",
		);
		expect(atlasChatTurnNote({ persisted: false, interrupted: true })).toBe(
			"persist-failed",
		);
	});

	it("rethrowAtlasChatError maps a missing provider to PRECONDITION_FAILED with the resolver's message, Atlas errors through mapAtlasError, and rethrows anything else as the same object", () => {
		const refusal =
			"No AI provider configured. Please configure an AI provider in Settings → AI Providers.";
		expect(
			thrownBy(() =>
				rethrowAtlasChatError(
					new AIProviderNotConfiguredError(refusal),
				),
			),
		).toMatchObject({ code: "PRECONDITION_FAILED", message: refusal });
		expect(
			thrownBy(() =>
				rethrowAtlasChatError(
					new AtlasError("NOT_FOUND", "Conversation not found."),
				),
			),
		).toMatchObject({
			code: "NOT_FOUND",
			message: "Conversation not found.",
		});
		expect(
			thrownBy(() =>
				rethrowAtlasChatError(
					new AtlasError(
						"PERSISTENCE_FAILED",
						"The turn was not saved.",
					),
				),
			),
		).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "The turn was not saved.",
		});
		const other = new Error("socket hang up");
		expect(thrownBy(() => rethrowAtlasChatError(other))).toBe(other);
	});

	it("startAtlasChat builds the service for the caller and maps a thrown AtlasError", async () => {
		const started = { textStream: [], persistOutcome: Promise.resolve() };
		m.chat.mockResolvedValue(started);

		await expect(startAtlasChat(CTX, TURN)).resolves.toBe(started);
		expect(m.serviceCtx).toHaveBeenCalledWith(CTX);
		expect(m.chat).toHaveBeenCalledWith(TURN);

		m.chat.mockRejectedValue(
			new AtlasError(
				"NOT_FOUND",
				"This repository has not been analysed yet.",
			),
		);
		const refused = await startAtlasChat(CTX, TURN).catch(
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(ORPCError);
		expect(refused).toMatchObject({
			code: "NOT_FOUND",
			message: "This repository has not been analysed yet.",
		});
	});

	it("assertAtlasChatConversation resolves for a visible conversation and answers NOT_FOUND 'Conversation not found.' for one the service cannot see", async () => {
		m.getConversation.mockResolvedValue({ id: TURN.conversationId });
		await expect(
			assertAtlasChatConversation(CTX, {
				conversationId: TURN.conversationId,
				projectId: TURN.projectId,
			}),
		).resolves.toBeUndefined();
		expect(m.serviceCtx).toHaveBeenCalledWith(CTX);
		expect(m.getConversation).toHaveBeenCalledWith({
			conversationId: TURN.conversationId,
			projectId: TURN.projectId,
		});

		m.getConversation.mockRejectedValue(
			new AtlasError("NOT_FOUND", "Conversation not found."),
		);
		await expect(
			assertAtlasChatConversation(CTX, {
				conversationId: "conversation-example-2",
				projectId: TURN.projectId,
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Conversation not found.",
		});
	});
});
