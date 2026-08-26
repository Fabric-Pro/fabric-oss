// packages/api/modules/agents/procedures/conversations/__tests__/persist-reasoning-gate.test.ts
/**
 * Procedure-level trust boundary tests for the reasoning persistence gate.
 *
 * Uses the same captured-handler pattern as other API procedure tests
 * (e.g., packages/api/modules/users/procedures/chat-agent-selection/__tests__/get.test.ts):
 *   1. Stub `tenantProtectedProcedure` (and related orpc helpers) so the
 *      chainable builder captures the raw handler function.
 *   2. Import the module under test — the side effect registers the handler.
 *   3. Call the captured handler directly with a mocked context + input.
 *   4. Assert the shape of the value that reached the mocked DB spy.
 *
 * This verifies that the REAL handler wires maybeStripReasoning correctly.
 * A test that calls maybeStripReasoning directly then manually calls the DB
 * would NOT catch a bug where the handler forgets to invoke the helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeStripReasoning } from "../update-conversation";

const mocks = vi.hoisted(() => ({
	createAgentConversation: vi.fn(),
	addMessageToConversation: vi.fn(),
	updateAgentConversation: vi.fn(),
	updateConversationTrajectory: vi.fn(),
	// Fizzy #1412 round-2 follow-up: createConversation now validates agentId
	// against the RegisteredAgent catalog before calling createAgentConversation.
	// This mock keeps every existing createConversation test green by returning
	// an ACTIVE seeded agent for any agentId. The dedicated agent-id-validation
	// test file (agent-id-validation.test.ts) exercises the failure paths.
	getRegisteredAgentByAgentId: vi.fn(),
	resolveOrganizationId: vi.fn(),
	verifyOrganizationMembership: vi.fn(),
	captured: {
		createConversation: null as
			| ((args: { context: any; input: any }) => Promise<any>)
			| null,
		addMessage: null as
			| ((args: { context: any; input: any }) => Promise<any>)
			| null,
		updateConversation: null as
			| ((args: { context: any; input: any }) => Promise<any>)
			| null,
	},
}));

vi.mock("@repo/database", () => ({
	createAgentConversation: mocks.createAgentConversation,
	addMessageToConversation: mocks.addMessageToConversation,
	updateAgentConversation: mocks.updateAgentConversation,
	updateConversationTrajectory: mocks.updateConversationTrajectory,
	getRegisteredAgentByAgentId: mocks.getRegisteredAgentByAgentId,
	// Constants required by @repo/ai (transitively loaded in this fork via
	// packages/api/node_modules/@repo/ai which imports from @repo/database).
	GATEWAY_PROVIDERS: [],
	DIRECT_PROVIDERS: [],
	AI_PROVIDER_METADATA: {},
	getProviderDisplayName: vi.fn(),
	getProviderMetadata: vi.fn(),
	isDirectProvider: vi.fn(),
	isGatewayProvider: vi.fn(),
}));

// Mock @repo/ai to prevent it from executing at load time
// (it uses @repo/database constants during module initialization)
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.verifyOrganizationMembership,
}));

vi.mock("../../../../../orpc/procedures", () => {
	// Chainable builder that captures the handler for each distinct chain. Four
	// procedures across two files use this builder:
	//   1. updateConversation  (update-conversation.ts, defined first)
	//   2. addMessage          (update-conversation.ts, defined second)
	//   3. updateTrajectory    (update-conversation.ts, defined third — no message gate needed)
	//   4. createConversation  (create-conversation.ts)
	// We import update-conversation BEFORE create-conversation below, so the
	// counter order matches the declaration order in those files.
	let callCount = 0;
	const makeChain = (): any => ({
		use: () => makeChain(),
		route: () => makeChain(),
		input: () => makeChain(),
		output: () => makeChain(),
		handler: (fn: any) => {
			callCount++;
			if (callCount === 1) {
				mocks.captured.updateConversation = fn;
			} else if (callCount === 2) {
				mocks.captured.addMessage = fn;
			} else if (callCount === 4) {
				// callCount 3 is updateTrajectory (no message fields — gate not needed)
				mocks.captured.createConversation = fn;
			}
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: makeChain(),
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: mocks.resolveOrganizationId,
	};
});

// Import the modules under test — side effects capture all three handlers.
// Order matters: update-conversation.ts registers updateConversation + addMessage
// (in that order). create-conversation.ts registers createConversation.
import "../update-conversation";
import "../create-conversation";

const USER_ID = "user-1";
const CONV_ID = "conv-1";

const baseMessage = {
	id: "m1",
	role: "assistant" as const,
	content: "The project has 14 members.",
	timestamp: "2026-05-14T00:00:00Z",
	reasoningText:
		"SYSTEM PROMPT: You are a helpful assistant. RAG SOURCE: [doc-42]",
	reasoningDurationMs: 800,
};

function makeContext() {
	mocks.resolveOrganizationId.mockReturnValue(null);
	mocks.verifyOrganizationMembership.mockResolvedValue(true);
	return {
		user: { id: USER_ID },
		session: { activeOrganizationId: null },
	};
}

beforeEach(() => {
	mocks.createAgentConversation.mockReset();
	mocks.addMessageToConversation.mockReset();
	mocks.updateAgentConversation.mockReset();
	mocks.resolveOrganizationId.mockReset();
	mocks.verifyOrganizationMembership.mockReset();
	// Default-active RegisteredAgent lookup so existing createConversation
	// tests in this file (which use the canonical agentId
	// "fabric-workspace-assistant") pass through the validation gate.
	// Failure paths (unknown / INACTIVE / ERROR) live in
	// agent-id-validation.test.ts where this mock is overridden per-test.
	mocks.getRegisteredAgentByAgentId.mockReset();
	mocks.getRegisteredAgentByAgentId.mockResolvedValue({
		agentId: "fabric-workspace-assistant",
		status: "ACTIVE",
		name: "Fabric AI",
		displayName: "Fabric AI",
	});
	delete process.env.FABRIC_PERSIST_REASONING_TRACE;
});

afterEach(() => {
	delete process.env.FABRIC_PERSIST_REASONING_TRACE;
});

// maybeStripReasoning unit tests
// These five tests document the pure helper's contract independently of the
// handler wiring. They can be read as a spec for the function signature.

describe("maybeStripReasoning — unit", () => {
	it("strips reasoningText and reasoningDurationMs when flag is off", () => {
		delete process.env.FABRIC_PERSIST_REASONING_TRACE;
		const stripped = maybeStripReasoning(baseMessage);
		expect(stripped).not.toHaveProperty("reasoningText");
		expect(stripped).not.toHaveProperty("reasoningDurationMs");
		expect(stripped.content).toBe(baseMessage.content);
	});

	it("strips when flag is explicitly false", () => {
		process.env.FABRIC_PERSIST_REASONING_TRACE = "false";
		const stripped = maybeStripReasoning(baseMessage);
		expect(stripped).not.toHaveProperty("reasoningText");
	});

	it("preserves reasoningText and reasoningDurationMs when flag is true", () => {
		process.env.FABRIC_PERSIST_REASONING_TRACE = "true";
		const preserved = maybeStripReasoning(baseMessage);
		expect(preserved.reasoningText).toBe(baseMessage.reasoningText);
		expect(preserved.reasoningDurationMs).toBe(800);
	});

	it("is a pure function — does not mutate the input message", () => {
		delete process.env.FABRIC_PERSIST_REASONING_TRACE;
		const input = { ...baseMessage };
		maybeStripReasoning(input);
		expect(input.reasoningText).toBe(baseMessage.reasoningText);
	});

	it("handles a message without reasoningText gracefully", () => {
		const msg = {
			id: "m1",
			role: "assistant" as const,
			content: "ok",
			timestamp: "2026-05-14T00:00:00Z",
		};
		expect(() => maybeStripReasoning(msg)).not.toThrow();
		expect(maybeStripReasoning(msg)).toEqual(msg);
	});
});

// Handler-level gate tests
// These tests exercise the REAL addMessage and updateConversation handler
// functions (captured via the tenantProtectedProcedure stub above). If an
// implementer forgets to call maybeStripReasoning inside the handler, these
// tests fail even though the unit tests above still pass.

describe("addMessage handler — DB call gate", () => {
	it("does NOT pass reasoningText to DB when flag is off", async () => {
		delete process.env.FABRIC_PERSIST_REASONING_TRACE;
		mocks.addMessageToConversation.mockResolvedValueOnce({
			id: CONV_ID,
			messages: [],
			updatedAt: new Date(),
		});

		await mocks.captured.addMessage!({
			context: makeContext(),
			input: {
				conversationId: CONV_ID,
				organizationId: null,
				message: baseMessage,
			},
		});

		const callArg = mocks.addMessageToConversation.mock.calls[0]?.[0];
		expect(callArg?.message).not.toHaveProperty("reasoningText");
		expect(callArg?.message).not.toHaveProperty("reasoningDurationMs");
		expect(callArg?.message.content).toBe(baseMessage.content);
	});

	it("DOES pass reasoningText to DB when flag is true", async () => {
		process.env.FABRIC_PERSIST_REASONING_TRACE = "true";
		mocks.addMessageToConversation.mockResolvedValueOnce({
			id: CONV_ID,
			messages: [],
			updatedAt: new Date(),
		});

		await mocks.captured.addMessage!({
			context: makeContext(),
			input: {
				conversationId: CONV_ID,
				organizationId: null,
				message: baseMessage,
			},
		});

		const callArg = mocks.addMessageToConversation.mock.calls[0]?.[0];
		expect(callArg?.message.reasoningText).toContain("SYSTEM PROMPT:");
		expect(callArg?.message.reasoningDurationMs).toBe(800);
	});
});

describe("updateConversation handler — DB call gate", () => {
	it("strips reasoningText from all messages when flag is off", async () => {
		delete process.env.FABRIC_PERSIST_REASONING_TRACE;
		mocks.updateAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			title: "Test",
			pinned: false,
			status: "ACTIVE",
			updatedAt: new Date(),
		});

		await mocks.captured.updateConversation!({
			context: makeContext(),
			input: {
				id: CONV_ID,
				organizationId: null,
				messages: [baseMessage, { ...baseMessage, id: "m2" }],
			},
		});

		const callArg = mocks.updateAgentConversation.mock.calls[0]?.[0];
		for (const msg of callArg?.messages ?? []) {
			expect(msg).not.toHaveProperty("reasoningText");
			expect(msg).not.toHaveProperty("reasoningDurationMs");
		}
	});

	it("preserves reasoningText in all messages when flag is true", async () => {
		process.env.FABRIC_PERSIST_REASONING_TRACE = "true";
		mocks.updateAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			title: "Test",
			pinned: false,
			status: "ACTIVE",
			updatedAt: new Date(),
		});

		await mocks.captured.updateConversation!({
			context: makeContext(),
			input: {
				id: CONV_ID,
				organizationId: null,
				messages: [baseMessage],
			},
		});

		const callArg = mocks.updateAgentConversation.mock.calls[0]?.[0];
		expect(callArg?.messages[0].reasoningText).toContain("SYSTEM PROMPT:");
		expect(callArg?.messages[0].reasoningDurationMs).toBe(800);
	});
});

// Codex round 4 (F7): the first turn of a new conversation goes through
// createConversation, NOT addMessage. Without these tests an implementer who
// forgets to import `maybeStripReasoning` into create-conversation.ts leaves
// the first-turn write path ungated. The procedure-level test is the only
// thing that catches that miss.

describe("createConversation handler — DB call gate", () => {
	it("strips reasoningText from initial messages when flag is off", async () => {
		delete process.env.FABRIC_PERSIST_REASONING_TRACE;
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-workspace-assistant",
			title: "Test",
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-workspace-assistant",
				title: "First turn",
				messages: [
					{
						id: "u1",
						role: "user",
						content: "hi",
						timestamp: "2026-05-14T00:00:00Z",
					},
					baseMessage,
				],
			},
		});

		const callArg = mocks.createAgentConversation.mock.calls[0]?.[0];
		for (const msg of callArg?.messages ?? []) {
			expect(msg).not.toHaveProperty("reasoningText");
			expect(msg).not.toHaveProperty("reasoningDurationMs");
		}
		// Sanity: non-reasoning fields survived the strip.
		expect(callArg?.messages[1].content).toBe(baseMessage.content);
	});

	it("preserves reasoningText in initial messages when flag is true", async () => {
		process.env.FABRIC_PERSIST_REASONING_TRACE = "true";
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-workspace-assistant",
			title: "Test",
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-workspace-assistant",
				title: "First turn",
				messages: [
					{
						id: "u1",
						role: "user",
						content: "hi",
						timestamp: "2026-05-14T00:00:00Z",
					},
					baseMessage,
				],
			},
		});

		const callArg = mocks.createAgentConversation.mock.calls[0]?.[0];
		expect(callArg?.messages[1].reasoningText).toContain("SYSTEM PROMPT:");
		expect(callArg?.messages[1].reasoningDurationMs).toBe(800);
	});
});
