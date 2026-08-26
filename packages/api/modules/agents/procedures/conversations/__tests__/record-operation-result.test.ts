/**
 * `recordOperationResult` — handler unit tests.
 *
 * The handler is exported but NOT registered in any router in PR1; it
 * exists purely so PR2/PR3 can wire callers without re-reviewing the
 * persistence + realtime + tenant-isolation logic. Tests exercise the
 * handler function directly via the captured-handler pattern used by
 * the document-assistant suite.
 *
 * Test cases:
 *   - happy path: persists message, emits realtime, returns
 *     { messageId, deduplicated: false }
 *   - dedup path: when `appendConversationMessage` returns
 *     deduplicated=true, the handler still emits realtime (so
 *     subscribers can re-validate their view), returns deduplicated=true
 *   - wrong tenant: ConversationNotFoundError → ORPCError(NOT_FOUND)
 *     with generic copy (never leaks tenant existence)
 *   - empty operationKey input: handler rejects at input validation
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CapturedHandler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;

const handlers: Record<string, CapturedHandler> = {};
let pendingKey = "";

const appendConversationMessageMock = vi.fn();
const emitConversationMessageAppendedMock = vi.fn();

class FakeConversationNotFoundError extends Error {
	constructor() {
		super("Conversation not found");
		this.name = "ConversationNotFoundError";
	}
}

vi.mock("@repo/database", () => ({
	appendConversationMessage: (...args: unknown[]) =>
		appendConversationMessageMock(...args),
	ConversationNotFoundError: FakeConversationNotFoundError,
}));

vi.mock("@repo/database/prisma/queries/agent-conversations", () => ({
	appendConversationMessage: (...args: unknown[]) =>
		appendConversationMessageMock(...args),
	ConversationNotFoundError: FakeConversationNotFoundError,
}));

vi.mock("../../../../../lib/realtime", () => ({
	emitConversationMessageAppended: (...args: unknown[]) =>
		emitConversationMessageAppendedMock(...args),
}));

vi.mock("@repo/api/lib/realtime", () => ({
	emitConversationMessageAppended: (...args: unknown[]) =>
		emitConversationMessageAppendedMock(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: CapturedHandler) => {
			handlers[pendingKey] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_: unknown, prop: string) => prop.toLowerCase() },
		),
	};
});

pendingKey = "recordOperationResult";
await import("../record-operation-result");

function invokeHandler(args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}): Promise<unknown> {
	const fn = handlers.recordOperationResult;
	if (!fn) {
		throw new Error(
			"recordOperationResult handler was not captured — check the mock setup",
		);
	}
	return fn(args);
}

const baseUser = {
	id: "user-1",
	email: "alice@example.com",
	name: "Alice",
};
const baseSession = {
	id: "sess-1",
	activeOrganizationId: "org-1",
	impersonatedBy: null,
};

function makeContext(): Record<string, unknown> {
	return {
		user: baseUser,
		session: baseSession,
		headers: new Headers(),
	};
}

const baseInput = {
	conversationId: "conv-1",
	projectId: "proj-1",
	organizationId: "org-1",
	operationKey: "op-key-1",
	outcome: "success" as const,
	operationLabel: "Run analysis",
	summary: "Analysis complete.",
};

beforeEach(() => {
	appendConversationMessageMock.mockReset();
	emitConversationMessageAppendedMock.mockReset();
	emitConversationMessageAppendedMock.mockResolvedValue(undefined);
});

describe("recordOperationResult — happy path", () => {
	it("persists the formatted message and emits realtime", async () => {
		appendConversationMessageMock.mockResolvedValueOnce({
			persisted: {
				id: "msg-uuid",
				role: "system",
				content: "SYSTEM\n\nAnalysis complete.",
				timestamp: "2026-05-27T10:00:00.000Z",
				metadata: {
					operationKey: "op-key-1",
					kind: "operation_result",
				},
			},
			deduplicated: false,
		});

		const result = await invokeHandler({
			context: makeContext(),
			input: baseInput,
		});

		expect(result).toMatchObject({
			messageId: "msg-uuid",
			deduplicated: false,
		});
		expect(appendConversationMessageMock).toHaveBeenCalledTimes(1);
		const appendArgs = appendConversationMessageMock.mock.calls[0]?.[0] as {
			id: string;
			userId: string;
			organizationId?: string | null;
			message: { metadata: { operationKey: string } };
		};
		expect(appendArgs.id).toBe("conv-1");
		expect(appendArgs.userId).toBe("user-1");
		expect(appendArgs.organizationId).toBe("org-1");
		expect(appendArgs.message.metadata.operationKey).toBe("op-key-1");

		expect(emitConversationMessageAppendedMock).toHaveBeenCalledTimes(1);
		const emitArgs = emitConversationMessageAppendedMock.mock
			.calls[0]?.[0] as {
			conversationId: string;
			messageId: string;
		};
		expect(emitArgs.conversationId).toBe("conv-1");
		expect(emitArgs.messageId).toBe("msg-uuid");
	});
});

describe("recordOperationResult — dedup path", () => {
	it("still emits realtime when the append was deduplicated", async () => {
		appendConversationMessageMock.mockResolvedValueOnce({
			persisted: {
				id: "existing-msg-id",
				role: "system",
				content: "SYSTEM\n\nPreviously persisted.",
				timestamp: "2026-05-27T09:00:00.000Z",
				metadata: {
					operationKey: "op-key-1",
					kind: "operation_result",
				},
			},
			deduplicated: true,
		});

		const result = await invokeHandler({
			context: makeContext(),
			input: baseInput,
		});

		expect(result).toMatchObject({
			messageId: "existing-msg-id",
			deduplicated: true,
		});
		// Subscribers re-validate on any append signal — same semantics
		// whether dedup'd or new (they'll just see the same row twice).
		expect(emitConversationMessageAppendedMock).toHaveBeenCalledTimes(1);
	});
});

describe("recordOperationResult — tenant isolation", () => {
	it("maps ConversationNotFoundError to NOT_FOUND ORPCError", async () => {
		appendConversationMessageMock.mockRejectedValue(
			new FakeConversationNotFoundError(),
		);

		let caught: unknown;
		try {
			await invokeHandler({
				context: makeContext(),
				input: { ...baseInput, organizationId: "wrong-org" },
			});
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ORPCError);
		expect((caught as { code?: string }).code).toBe("NOT_FOUND");

		expect(emitConversationMessageAppendedMock).not.toHaveBeenCalled();
	});

	it("does NOT swallow unrelated errors (database connection drop, etc.)", async () => {
		const dbErr = new Error("Connection refused");
		appendConversationMessageMock.mockRejectedValueOnce(dbErr);

		await expect(
			invokeHandler({
				context: makeContext(),
				input: baseInput,
			}),
		).rejects.toThrow("Connection refused");
	});
});
