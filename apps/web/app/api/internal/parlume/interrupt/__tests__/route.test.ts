import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	claim: vi.fn(),
	actions: vi.fn(),
	turns: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@repo/database", () => {
	const delegates = {
		parlumeMeetingSession: {
			findFirst: mocks.session,
			updateMany: mocks.claim,
		},
		parlumeAction: { updateMany: mocks.actions },
		parlumeMeetingTurn: { updateMany: mocks.turns },
	};
	return {
		db: {
			...delegates,
			$transaction: (run: (tx: typeof delegates) => Promise<unknown>) =>
				run(delegates),
		},
	};
});
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ cancel: mocks.cancel }) },
	}),
}));
vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: (value: string) => value === "service",
}));

import { POST } from "../route";

function request(token = "service") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/interrupt",
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": token },
			body: JSON.stringify({
				sessionId: "session",
				botId: "bot",
				voiceGeneration: 4,
			}),
		},
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({
		id: "session",
		activeTurnId: "turn",
		voiceGeneration: 3,
	});
	mocks.claim.mockResolvedValue({ count: 1 });
});
describe("Parlume generation interruption", () => {
	it.each([null, "confirmation-turn"])(
		"cancels a presented proposal when interrupted with active turn %s",
		async (activeTurnId) => {
			mocks.session.mockResolvedValue({
				id: "session",
				activeTurnId,
				voiceGeneration: 3,
			});
			let actionStatus = "AWAITING_CONFIRMATION";
			mocks.actions.mockImplementation(async ({ where, data }) => {
				const statuses =
					typeof where.status === "string"
						? [where.status]
						: where.status.in;
				if (
					statuses.includes(actionStatus) &&
					!where.turnId &&
					!where.confirmationTurnId
				) {
					actionStatus = data.status;
				}
				return { count: 1 };
			});
			expect((await POST(request())).status).toBe(200);
			expect(actionStatus).toBe("CANCELLED");
		},
	);
	it("authenticates before changing state", async () => {
		expect((await POST(request("wrong"))).status).toBe(401);
		expect(mocks.session).not.toHaveBeenCalled();
	});
	it("invalidates stale actions and cancels the active workflow", async () => {
		expect((await POST(request())).status).toBe(200);
		expect(mocks.claim).toHaveBeenCalledWith({
			where: { id: "session", voiceGeneration: 3, activeTurnId: "turn" },
			data: { voiceGeneration: 4, activeTurnId: null },
		});
		expect(mocks.actions).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: { in: ["PROPOSED", "AWAITING_CONFIRMATION"] },
				}),
				data: expect.objectContaining({ status: "CANCELLED" }),
			}),
		);
		expect(mocks.actions).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "EXECUTING" }),
				data: expect.objectContaining({ status: "OUTCOME_UNKNOWN" }),
			}),
		);
		expect(mocks.cancel).toHaveBeenCalledOnce();
	});
	it("does not clear a newer turn when session state changed during interruption", async () => {
		mocks.claim.mockResolvedValue({ count: 0 });
		expect((await POST(request())).status).toBe(409);
		expect(mocks.actions).not.toHaveBeenCalled();
		expect(mocks.turns).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});
