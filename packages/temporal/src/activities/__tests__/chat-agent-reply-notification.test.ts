/**
 * `streamAndSaveMessage`'s agent-reply notification fan-out.
 *
 * Pins the `runId` the notification dedupes on, and what happens when the
 * activity has no workflow identity to derive it from. SDK 1.23 made
 * `Activity.Info.workflowExecution` optional — a standalone Activity, started
 * directly by a client, carries none — so the read is guarded. Nothing in this
 * repo starts a standalone Activity, and the only workflow that reaches this
 * activity (`chatMessageWorkflow`) has no UI path, so the guard is otherwise
 * unexercised by both CI and manual testing. Hence this test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	current: vi.fn(),
	getAiChatById: vi.fn(),
	updateAiChat: vi.fn(),
	createAgentReplyReadyNotifications: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	streamText: vi.fn(),
	convertToModelMessages: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({ Context: { current: h.current } }));
vi.mock("@repo/database", () => ({ getAiChatById: h.getAiChatById }));
vi.mock("@repo/database/prisma/queries/ai-chats", () => ({
	updateAiChat: h.updateAiChat,
}));
vi.mock("@repo/database/prisma/queries/agent-reply-notifications", () => ({
	createAgentReplyReadyNotifications: h.createAgentReplyReadyNotifications,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: h.getAIModelWithMetadata,
	streamText: h.streamText,
	convertToModelMessages: h.convertToModelMessages,
	logModelUsageAsync: h.logModelUsageAsync,
}));

import { streamAndSaveMessage } from "../chat-activities";

const CHAT_ID = "chat-1";
const REPLY = "the assistant reply";

/** A chat row shaped the way the activity reads it. */
function chatRow(overrides: Record<string, unknown> = {}) {
	return {
		id: CHAT_ID,
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
		title: "  Release planning  ",
		...overrides,
	};
}

/** `workflowExecution` as a workflow-started activity sees it. */
function inWorkflow(workflowId = "chat-message-wf-1") {
	return { info: { workflowExecution: { workflowId, runId: "run-1" } } };
}

beforeEach(() => {
	vi.clearAllMocks();
	h.current.mockReturnValue(inWorkflow());
	h.getAiChatById.mockResolvedValue(chatRow());
	h.updateAiChat.mockResolvedValue(undefined);
	h.createAgentReplyReadyNotifications.mockResolvedValue(undefined);
	h.convertToModelMessages.mockResolvedValue([]);
	h.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model", provider: "test" },
		trackUsage: vi.fn(),
	});
	h.streamText.mockReturnValue({
		text: Promise.resolve(REPLY),
		usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
	});
});

const messages = [
	{ role: "user" as const, parts: [{ type: "text", text: "hello" }] },
];

describe("streamAndSaveMessage agent-reply notification", () => {
	it("dedupes on the workflow id when a workflow started the activity", async () => {
		await expect(streamAndSaveMessage(CHAT_ID, messages)).resolves.toBe(
			REPLY,
		);

		expect(h.createAgentReplyReadyNotifications).toHaveBeenCalledTimes(1);
		expect(h.createAgentReplyReadyNotifications).toHaveBeenCalledWith({
			// The durable per-turn identity. Every retry of this attempt keeps
			// the same id, which is what makes one notification per run.
			runId: "chat-message-wf-1",
			recipientUserId: "user-1",
			organizationId: "org-1",
			agentName: "Release planning",
			finalMessage: REPLY,
			link: `app/chats/${CHAT_ID}?project=project-1`,
			projectId: "project-1",
		});
	});

	it("skips the notification cleanly when the activity carries no workflow identity", async () => {
		// A standalone Activity (SDK 1.23+): no workflow above it, so no
		// workflow id to dedupe on. Inventing one would let duplicates
		// through, so the ping is dropped rather than sent unkeyed.
		h.current.mockReturnValue({ info: { workflowExecution: undefined } });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(streamAndSaveMessage(CHAT_ID, messages)).resolves.toBe(
			REPLY,
		);

		expect(h.createAgentReplyReadyNotifications).not.toHaveBeenCalled();
		// The reply itself must still be persisted — losing a bell ping is
		// not a reason to lose the message.
		expect(h.updateAiChat).toHaveBeenCalledTimes(1);
		// Load-bearing, and the reason the two assertions above are not
		// enough on their own: an *unguarded* read of `workflowExecution`
		// throws a TypeError here, and the surrounding try/catch swallows it
		// into exactly the same "no notification, reply still returned" shape.
		// Only the absence of the warning distinguishes a deliberate skip
		// from a caught crash. Verified by mutation: removing the guard in
		// `chat-activities.ts` fails this expectation and nothing else.
		expect(warn).not.toHaveBeenCalledWith(
			expect.stringContaining("agentReplyReady notification dispatch"),
			expect.anything(),
		);
		warn.mockRestore();
	});

	it("skips the notification for a chat with no project", async () => {
		// Pre-existing behaviour, pinned so it stays distinguishable from the
		// missing-workflow-identity case above: the notification's link and
		// payload presume a project context.
		h.getAiChatById.mockResolvedValue(chatRow({ projectId: null }));

		await expect(streamAndSaveMessage(CHAT_ID, messages)).resolves.toBe(
			REPLY,
		);

		expect(h.createAgentReplyReadyNotifications).not.toHaveBeenCalled();
	});

	it("still returns the reply when the notification dispatch rejects", async () => {
		// Fire-and-forget: the fan-out is best-effort and must never fail the
		// activity, or a failed bell ping would retry the whole AI turn.
		h.createAgentReplyReadyNotifications.mockRejectedValue(
			new Error("notification store unavailable"),
		);

		await expect(streamAndSaveMessage(CHAT_ID, messages)).resolves.toBe(
			REPLY,
		);
	});
});
