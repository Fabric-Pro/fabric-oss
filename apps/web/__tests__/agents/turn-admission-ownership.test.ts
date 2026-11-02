// @vitest-environment node
/**
 * The shared chat admission (`admitTurn`) with another engine's live turn in
 * the conversation. An engine that says which turns are its own
 * (`ownsTurn`) never reconciles another engine's turn with its own settler:
 * a Deep Research run is never saved as a Direct answer, nor a Direct turn
 * as a research report. The new message is refused `in_progress`, and the
 * turn's own engine settles it. Without `ownsTurn` (the Orchestrator route),
 * a conflicting turn is reconciled as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	latest: vi.fn(),
	admit: vi.fn(),
	describe: vi.fn(),
	result: vi.fn(),
	finalize: vi.fn(),
	settle: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getLatestConversationTurn: m.latest,
	getConversationTurnsByClientKeys: vi.fn(async () => []),
	admitConversationTurn: m.admit,
	abandonConversationTurnStart: vi.fn(),
	finalizeConversationTurn: m.finalize,
	finalizeOrphanedConversationTurn: vi.fn(),
	getConversationTurnForExecution: vi.fn(),
	markConversationTurnActive: vi.fn(),
}));

const { admitTurn } = await import(
	"@saas/agents/lib/server/conversation-turn-admission"
);

const THREAD = "thread-example-0001";
const RESEARCH_EXECUTION = "wf-user-1-deep-researcher-example";

/** A live research run's turn row, as admission reads it. */
const researchTurn = {
	id: "turn-research",
	userId: "user-1",
	organizationId: "org-1",
	conversationId: THREAD,
	clientRequestKey: "run-example-0001",
	executionId: RESEARCH_EXECUTION,
	executionMode: "research",
	status: "ACTIVE",
	createdAt: new Date("2026-10-01T10:00:00.000Z"),
	updatedAt: new Date("2026-10-01T10:00:00.000Z"),
};

const createdTurn = {
	...researchTurn,
	id: "turn-direct",
	clientRequestKey: "run-example-0002",
	executionId: "direct-chat-new",
	executionMode: "direct",
	status: "START_PENDING",
};

function admit(ownsTurn?: (turn: { executionMode: string }) => boolean) {
	return admitTurn({
		userId: "user-1",
		organizationId: "org-1",
		conversationId: THREAD,
		clientRequestKey: "run-example-0002",
		newExecutionId: () => "direct-chat-new",
		executionMode: "direct",
		question: "Tell me more",
		temporalClient: {
			workflow: {
				getHandle: () => ({ describe: m.describe, result: m.result }),
				start: vi.fn(),
			},
		},
		settleCompleted: m.settle,
		ownsTurn,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.latest.mockResolvedValue(null);
	m.admit
		.mockResolvedValueOnce({ outcome: "conflict", turn: researchTurn })
		.mockResolvedValue({ outcome: "created", turn: createdTurn });
	m.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
	m.result.mockResolvedValue({ status: "completed" });
	m.settle.mockResolvedValue({
		outcome: "COMPLETED",
		terminalReason: "completed",
	});
	m.finalize.mockResolvedValue({ outcome: "finalized" });
});

describe("admission with another engine's live turn", () => {
	it("a conflicting live turn that ownsTurn rejects is refused in_progress with no reconcile and no settle", async () => {
		const admission = await admit(
			(turn) => turn.executionMode === "direct",
		);

		expect(admission).toEqual({
			kind: "refused",
			refusal: { reason: "in_progress", executionId: RESEARCH_EXECUTION },
		});
		expect(m.admit).toHaveBeenCalledTimes(1);
		expect(m.describe).not.toHaveBeenCalled();
		expect(m.result).not.toHaveBeenCalled();
		expect(m.settle).not.toHaveBeenCalled();
		expect(m.finalize).not.toHaveBeenCalled();
	});

	it("without ownsTurn the conflict is reconciled as before", async () => {
		const admission = await admit();

		expect(m.describe).toHaveBeenCalledTimes(1);
		expect(m.settle).toHaveBeenCalledWith(
			{ status: "completed" },
			researchTurn,
		);
		expect(m.finalize).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-research",
				outcome: "COMPLETED",
			}),
		);
		expect(admission).toEqual({ kind: "created", turn: createdTurn });
	});

	it("a conflicting turn ownsTurn accepts is reconciled with the engine's settler", async () => {
		const admission = await admit(
			(turn) => turn.executionMode === "research",
		);

		expect(m.settle).toHaveBeenCalledTimes(1);
		expect(admission).toEqual({ kind: "created", turn: createdTurn });
	});
});
