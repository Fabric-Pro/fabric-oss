/**
 * A chat title and a retried chat message are a person's own chat work, so
 * both workflow starts carry `planEligible: true` with that person's `userId`
 * (Fizzy #2770). The Temporal client interceptor reads exactly those two
 * fields from the first argument; without them an organization whose only
 * provider is a ChatGPT plan has no provider for these runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, registering } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const registering = { name: "" };
	const mocks = {
		getAiChatByIdForOwner: vi.fn(),
		updateAiChat: vi.fn(),
		workflowStart: vi.fn(),
		isTemporalAvailable: vi.fn(),
	};
	return { handlers, mocks, registering };
});

vi.mock("@orpc/client", () => ({
	ORPCError: class extends Error {
		code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
}));

vi.mock("@repo/database", () => ({
	getAiChatByIdForOwner: mocks.getAiChatByIdForOwner,
	updateAiChat: mocks.updateAiChat,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
	isTemporalAvailable: mocks.isTemporalAvailable,
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (x: unknown) => x,
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[registering.name] = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requirePermission: () => (c: unknown) => c,
	};
});

registering.name = "generateTitle";
await import("../generate-title-workflow");
registering.name = "retry";
await import("../retry-failed-message");

const ctx = { user: { id: "user-1" } };

function startedInput(): Record<string, unknown> {
	expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	const options = mocks.workflowStart.mock.calls[0]?.[1] as {
		args: Array<Record<string, unknown>>;
	};
	return options.args[0] ?? {};
}

describe("person-started chat workflows run on the person's plan", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isTemporalAvailable.mockResolvedValue(true);
		mocks.workflowStart.mockResolvedValue({
			workflowId: "wf-1",
			firstExecutionRunId: "run-1",
		});
		mocks.updateAiChat.mockResolvedValue(undefined);
	});

	it("marks the chat title run plan-eligible for the chat's owner", async () => {
		mocks.getAiChatByIdForOwner.mockResolvedValue({
			id: "chat-1",
			organizationId: "org-1",
		});

		await handlers.generateTitle?.({
			input: { chatId: "chat-1", firstMessage: "Hello" },
			context: ctx,
		});

		expect(mocks.workflowStart.mock.calls[0]?.[0]).toBe(
			"chatTitleGenerationWorkflow",
		);
		expect(startedInput()).toMatchObject({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			planEligible: true,
		});
	});

	it("marks a retried message run plan-eligible for the chat's owner", async () => {
		mocks.getAiChatByIdForOwner.mockResolvedValue({
			id: "chat-1",
			organizationId: "org-1",
			workflowStatus: "FAILED",
			retryCount: 0,
			messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
		});

		await handlers.retry?.({
			input: { chatId: "chat-1" },
			context: ctx,
		});

		expect(mocks.workflowStart.mock.calls[0]?.[0]).toBe(
			"chatMessageWorkflow",
		);
		expect(startedInput()).toMatchObject({
			chatId: "chat-1",
			userId: "user-1",
			organizationId: "org-1",
			planEligible: true,
		});
	});
});
