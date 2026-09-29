import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	updateManyAndReturn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: (...args: unknown[]) => mocks.findUnique(...args),
			updateManyAndReturn: (...args: unknown[]) =>
				mocks.updateManyAndReturn(...args),
		},
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-meeting-baas", () => ({
	deleteParlumeMeetingBotData: vi.fn(),
	getParlumeBridgeSettings: vi.fn(),
}));

import { POST } from "../route";

function request(body: object, token?: string) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/verify-stream",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { "X-Agent-Service-Token": token } : {}),
			},
			body: JSON.stringify(body),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.updateManyAndReturn.mockResolvedValue([{ streamGeneration: 2 }]);
});

describe("Parlume stream verification", () => {
	it("fails closed without the Fabric service credential", async () => {
		const response = await POST(
			request({
				sessionId: "s1",
				streamToken: "a".repeat(32),
				botId: "b1",
			}),
		);
		expect(response.status).toBe(401);
		expect(mocks.findUnique).not.toHaveBeenCalled();
	});

	it("returns pending without accepting stream data before the start write binds the bot", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "s1",
			providerBotId: null,
			streamTokenDigest: createHash("sha256")
				.update("a".repeat(32))
				.digest("hex"),
			status: "PENDING",
			hardStopAt: new Date("2030-01-01T00:00:00.000Z"),
		});

		const response = await POST(
			request(
				{ sessionId: "s1", streamToken: "a".repeat(32), botId: "b1" },
				"service-secret",
			),
		);

		expect(response.status).toBe(202);
		expect(mocks.updateManyAndReturn).not.toHaveBeenCalled();
	});

	it("rejects a bot id from another session", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "s1",
			providerBotId: "b1",
			streamTokenDigest: createHash("sha256")
				.update("a".repeat(32))
				.digest("hex"),
			status: "JOINING",
			hardStopAt: new Date("2030-01-01T00:00:00.000Z"),
		});

		const response = await POST(
			request(
				{
					sessionId: "s1",
					streamToken: "a".repeat(32),
					botId: "other",
				},
				"service-secret",
			),
		);

		expect(response.status).toBe(401);
		expect(mocks.updateManyAndReturn).not.toHaveBeenCalled();
	});

	it("advances the durable generation and clears a stale close when a newer stream verifies", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "s1",
			providerBotId: "b1",
			streamTokenDigest: createHash("sha256")
				.update("a".repeat(32))
				.digest("hex"),
			status: "ACTIVE",
			hardStopAt: new Date("2030-01-01T00:00:00.000Z"),
		});

		const response = await POST(
			request(
				{ sessionId: "s1", streamToken: "a".repeat(32), botId: "b1" },
				"service-secret",
			),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ streamGeneration: 2 });
		expect(mocks.updateManyAndReturn).toHaveBeenCalledWith({
			where: {
				id: "s1",
				providerBotId: "b1",
				status: "ACTIVE",
			},
			data: {
				streamClosedAt: null,
				streamGeneration: { increment: 1 },
			},
			select: { streamGeneration: true },
		});
	});
});
