import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	claim: vi.fn(),
	actions: vi.fn(),
	turns: vi.fn(),
	finishedTurn: vi.fn(),
	cancel: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@repo/database", () => {
	const delegates = {
		parlumeMeetingSession: {
			findFirst: mocks.session,
			updateMany: mocks.claim,
		},
		parlumeAction: { updateMany: mocks.actions },
		parlumeMeetingTurn: {
			updateMany: mocks.turns,
			findFirst: mocks.finishedTurn,
		},
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
vi.mock("@repo/temporal/parlume-turn-audit", () => ({
	recordParlumeTurnAnswered: mocks.audit,
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
	mocks.turns.mockResolvedValue({ count: 1 });
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
	it("cancels the active workflow and leaves a confirmed change of that turn running", async () => {
		expect((await POST(request())).status).toBe(200);
		expect(mocks.claim).toHaveBeenCalledWith({
			where: { id: "session", voiceGeneration: 3, activeTurnId: "turn" },
			data: { voiceGeneration: 4, activeTurnId: null },
		});
		expect(mocks.actions).not.toHaveBeenCalled();
		expect(mocks.cancel).toHaveBeenCalledOnce();
	});
	// Talking over Parlume no longer changes its turn: a mute report from an
	// older bridge must not be taken for a cancel of the turn it spoke over.
	it("refuses a mute report and leaves the running turn alone", async () => {
		const response = await POST(
			request("service", { voiceGeneration: 3, kind: "mute" }),
		);

		expect(response.status).toBe(400);
		expect(mocks.session).not.toHaveBeenCalled();
		expect(mocks.turns).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
	it("ends a turn stopped aloud as STOPPED by voice, named after who said it", async () => {
		const response = await POST(
			request("service", { stop: { cause: "VOICE", by: "Dana Member" } }),
		);

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.turns).toHaveBeenCalledWith({
			where: { id: "turn", status: { in: ["PENDING", "RUNNING"] } },
			data: {
				status: "STOPPED",
				stopCause: "VOICE",
				stoppedBy: "Dana Member",
				interruptedAt: expect.any(Date),
				completedAt: expect.any(Date),
			},
		});
		expect(mocks.cancel).toHaveBeenCalledOnce();
	});
	it("records a replaced or cut-off turn as FAILED", async () => {
		expect((await POST(request())).status).toBe(200);
		expect(mocks.turns).toHaveBeenCalledWith({
			where: { id: "turn", status: { in: ["PENDING", "RUNNING"] } },
			data: {
				status: "FAILED",
				error: "Ended before the answer finished: a newer request replaced it, or the meeting connection closed.",
				interruptedAt: expect.any(Date),
				completedAt: expect.any(Date),
			},
		});
		expect(mocks.audit).toHaveBeenCalledOnce();
		expect(mocks.audit).toHaveBeenCalledWith({
			turnId: "turn",
			status: "FAILED",
		});
	});
	it("ends a turn someone stopped as STOPPED, with the cause and who stopped it, and cancels its workflow", async () => {
		const response = await POST(
			request("service", { stop: { cause: "PAGE", by: "Dana Member" } }),
		);

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.turns).toHaveBeenCalledWith({
			where: { id: "turn", status: { in: ["PENDING", "RUNNING"] } },
			data: {
				status: "STOPPED",
				stopCause: "PAGE",
				stoppedBy: "Dana Member",
				interruptedAt: expect.any(Date),
				completedAt: expect.any(Date),
			},
		});
		expect(mocks.cancel).toHaveBeenCalledOnce();
		expect(mocks.audit).toHaveBeenCalledOnce();
		expect(mocks.audit).toHaveBeenCalledWith({
			turnId: "turn",
			status: "STOPPED",
		});
	});
	it("audits no turn its worker had already ended", async () => {
		mocks.turns.mockResolvedValue({ count: 0 });

		const response = await POST(
			request("service", { stop: { cause: "PAGE", by: "Dana Member" } }),
		);

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	// On staging a typed stop and the page's Stop speaking silenced the answer
	// and posted "Stopped", but both turns stayed COMPLETED: the worker had
	// recorded the turn before the bridge's report arrived.
	it("records the stopped turn its worker already finished as STOPPED, without cancelling a workflow", async () => {
		mocks.session.mockResolvedValue({
			id: "session",
			activeTurnId: null,
			voiceGeneration: 3,
		});
		mocks.finishedTurn.mockResolvedValue({ id: "finished" });
		mocks.turns.mockResolvedValue({ count: 1 });

		const response = await POST(
			request("service", { stop: { cause: "CHAT", by: "Dana Member" } }),
		);

		expect(await response.json()).toEqual({ accepted: true });
		const [query] = mocks.finishedTurn.mock.calls[0];
		expect(query).toEqual({
			where: {
				sessionId: "session",
				voiceGeneration: 3,
				status: "COMPLETED",
				completedAt: { gte: expect.any(Date) },
				replyChannel: { not: "PAGE" },
			},
			orderBy: { completedAt: "desc" },
			select: { id: true },
		});
		const since = query.where.completedAt.gte.getTime();
		expect(Date.now() - since).toBeGreaterThanOrEqual(30_000);
		expect(Date.now() - since).toBeLessThan(31_000);
		expect(mocks.turns).toHaveBeenCalledWith({
			where: { id: "finished", status: "COMPLETED" },
			data: {
				status: "STOPPED",
				stopCause: "CHAT",
				stoppedBy: "Dana Member",
			},
		});
		expect(mocks.cancel).not.toHaveBeenCalled();
		// Its worker audited it when it completed: one row per turn.
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it("changes nothing when the stopped generation has no turn that just finished", async () => {
		mocks.session.mockResolvedValue({
			id: "session",
			activeTurnId: null,
			voiceGeneration: 3,
		});
		mocks.finishedTurn.mockResolvedValue(null);

		const response = await POST(
			request("service", { stop: { cause: "PAGE", by: null } }),
		);

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.turns).not.toHaveBeenCalled();
	});
	it("leaves finished turns alone when no one asked for the stop", async () => {
		mocks.session.mockResolvedValue({
			id: "session",
			activeTurnId: null,
			voiceGeneration: 3,
		});

		expect((await POST(request())).status).toBe(200);
		expect(mocks.finishedTurn).not.toHaveBeenCalled();
		expect(mocks.turns).not.toHaveBeenCalled();
	});
	it("refuses a stop with an unknown cause", async () => {
		const response = await POST(
			request("service", { stop: { cause: "CAP", by: null } }),
		);

		expect(response.status).toBe(400);
		expect(mocks.session).not.toHaveBeenCalled();
	});
	it("does not clear a newer turn when session state changed during interruption", async () => {
		mocks.claim.mockResolvedValue({ count: 0 });
		expect((await POST(request())).status).toBe(409);
		expect(mocks.actions).not.toHaveBeenCalled();
		expect(mocks.turns).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});
