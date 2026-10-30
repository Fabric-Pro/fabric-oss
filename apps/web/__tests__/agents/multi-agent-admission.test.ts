// @vitest-environment node
/**
 * The shared chat admission (`admitTurn`, used by the Orchestrator stream
 * route, the Direct engine and the agent runtime) with a multi-agent turn in
 * the conversation: only its first agent's turn belongs to the conversation,
 * yet the conversation takes no new message while any agent still runs.
 *
 *   - first agent ended, another agent's workflow running: `in_progress`
 *     naming that agent's execution, and no turn is created;
 *   - Temporal cannot describe the running agent: `state_unavailable`;
 *   - every agent ended (or its workflow is gone): the turn is admitted;
 *   - the multi-agent turn's own key, retried, and a conversation whose
 *     latest turn is a single one, go straight to admission.
 */
import type { ConversationTurn } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	latest: vi.fn(),
	byKeys: vi.fn(async (): Promise<unknown[]> => []),
	admit: vi.fn(),
	describe: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getLatestConversationTurn: m.latest,
	getConversationTurnsByClientKeys: m.byKeys,
	admitConversationTurn: m.admit,
	abandonConversationTurnStart: vi.fn(),
	finalizeConversationTurn: vi.fn(),
	finalizeOrphanedConversationTurn: vi.fn(),
	getConversationTurnForExecution: vi.fn(),
	markConversationTurnActive: vi.fn(),
}));
vi.mock("@repo/temporal/temporal-client-errors", () => ({
	classifyTemporalClientError: (error: unknown) =>
		error instanceof Error && error.message === "not found"
			? "not_found"
			: "unavailable",
}));

const { admitTurn } = await import(
	"@saas/agents/lib/server/conversation-turn-admission"
);

const THREAD = "thread-example-0001";
const KEY = "ma_run-example-0001";

function turn(
	key: string,
	overrides: Partial<ConversationTurn> = {},
): ConversationTurn {
	const base = {
		id: `turn-${key}`,
		userId: "user-1",
		organizationId: "org-1",
		conversationId: key === KEY ? THREAD : null,
		clientRequestKey: key,
		executionId: `orch-${key}`,
		status: "ACTIVE",
		createdAt: new Date("2026-10-01T10:00:00.000Z"),
	};
	// The row's remaining columns are not read by admission.
	return { ...base, ...overrides } as ConversationTurn;
}

function admit(clientRequestKey = "run-example-0002") {
	return admitTurn({
		userId: "user-1",
		organizationId: "org-1",
		conversationId: THREAD,
		clientRequestKey,
		newExecutionId: () => "orch-new",
		executionMode: "balanced",
		question: "Next question",
		temporalClient: {
			workflow: {
				getHandle: () => ({ describe: m.describe }),
				start: vi.fn(),
			},
		},
		settleCompleted: () => ({
			outcome: "COMPLETED",
			terminalReason: "completed",
		}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.latest.mockResolvedValue(turn(KEY, { status: "COMPLETED" }));
	m.byKeys.mockResolvedValue([turn(`${KEY}_a1`)]);
	m.describe.mockResolvedValue({ status: { name: "RUNNING" } });
	m.admit.mockResolvedValue({ outcome: "created", turn: turn("run-new") });
});

describe("admission after a multi-agent turn", () => {
	it("refuses while another agent of the turn still runs", async () => {
		const admission = await admit();

		expect(admission).toEqual({
			kind: "refused",
			refusal: { reason: "in_progress", executionId: `orch-${KEY}_a1` },
		});
		expect(m.byKeys).toHaveBeenCalledWith(
			expect.objectContaining({
				clientRequestKeys: [`${KEY}_a1`, `${KEY}_a2`, `${KEY}_a3`],
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("fails closed when Temporal cannot describe the agent", async () => {
		m.describe.mockRejectedValue(new Error("transport down"));

		expect(await admit()).toEqual({
			kind: "refused",
			refusal: { reason: "state_unavailable" },
		});
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("admits once every agent has ended", async () => {
		m.byKeys.mockResolvedValue([
			turn(`${KEY}_a1`, { status: "COMPLETED" }),
			turn(`${KEY}_a2`),
		]);
		m.describe.mockRejectedValue(new Error("not found"));

		expect(await admit()).toMatchObject({ kind: "created" });
		expect(m.admit).toHaveBeenCalledTimes(1);
	});

	it("leaves the turn's own retry and single turns to admission", async () => {
		expect(await admit(KEY)).toMatchObject({ kind: "created" });
		expect(m.byKeys).not.toHaveBeenCalled();

		m.latest.mockResolvedValue(turn("run-single", { status: "COMPLETED" }));
		expect(await admit()).toMatchObject({ kind: "created" });
		expect(m.byKeys).not.toHaveBeenCalled();
	});
});
