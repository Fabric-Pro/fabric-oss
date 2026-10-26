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
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ cancel: mocks.cancel }) },
	}),
}));
vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: (value: string) => value === "service",
}));

import { POST } from "../route";

function request(token = "service", overrides: Record<string, unknown> = {}) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/interrupt",
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": token },
			body: JSON.stringify({
				sessionId: "session",
				botId: "bot",
				voiceGeneration: 4,
				...overrides,
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
	it("does not touch actions when no turn was running", async () => {
		mocks.session.mockResolvedValue({
			id: "session",
			activeTurnId: null,
			voiceGeneration: 3,
		});
		expect((await POST(request())).status).toBe(200);
		expect(mocks.actions).not.toHaveBeenCalled();
	});
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
					status: "EXECUTING",
					turnId: "turn",
				}),
				data: expect.objectContaining({ status: "OUTCOME_UNKNOWN" }),
			}),
		);
		expect(mocks.cancel).toHaveBeenCalledOnce();
	});
	it("notes a mute on the running turn without cancelling it or its actions", async () => {
		mocks.session.mockResolvedValue({ activeTurnId: "turn" });
		mocks.turns.mockResolvedValue({ count: 1 });

		const response = await POST(
			request("service", { voiceGeneration: 3, kind: "mute" }),
		);

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.session).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ voiceGeneration: 3 }),
			}),
		);
		expect(mocks.turns).toHaveBeenCalledWith({
			where: {
				id: "turn",
				status: { in: ["PENDING", "RUNNING"] },
				interruptedAt: null,
			},
			data: { interruptedAt: expect.any(Date) },
		});
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.actions).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("accepts no mute when no turn is running on that generation", async () => {
		mocks.session.mockResolvedValue(null);

		const response = await POST(request("service", { kind: "mute" }));

		expect(await response.json()).toEqual({ accepted: false });
		expect(mocks.turns).not.toHaveBeenCalled();
	});
	it("does not clear a newer turn when session state changed during interruption", async () => {
		mocks.claim.mockResolvedValue({ count: 0 });
		expect((await POST(request())).status).toBe(409);
		expect(mocks.actions).not.toHaveBeenCalled();
		expect(mocks.turns).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});
