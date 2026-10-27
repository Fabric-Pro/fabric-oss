import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	updateManyAndReturn: vi.fn(),
	warm: vi.fn(),
	recap: vi.fn(),
	afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: mocks.findUnique,
			updateManyAndReturn: mocks.updateManyAndReturn,
		},
	},
}));
vi.mock("next/server", async (original) => ({
	...(await original<typeof import("next/server")>()),
	after: (callback: () => unknown) => {
		mocks.afterCallbacks.push(callback);
	},
}));
vi.mock("../../warm", () => ({ warmParlumeRuntime: mocks.warm }));
vi.mock("../../recap", () => ({ startParlumeRecap: mocks.recap }));

import { POST } from "../route";

function request() {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/verify-stream",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": "service-secret",
			},
			body: JSON.stringify({
				sessionId: "s1",
				streamToken: "a".repeat(32),
				botId: "b1",
			}),
		},
	);
}

function sessionIn(status: string, linkedMeetingId: string | null = null) {
	mocks.findUnique.mockResolvedValue({
		linkedMeetingId,
		id: "s1",
		providerBotId: "b1",
		streamTokenDigest: createHash("sha256")
			.update("a".repeat(32))
			.digest("hex"),
		status,
		hardStopAt: new Date("2030-01-01T00:00:00.000Z"),
		userId: "u1",
		organizationId: "o1",
		projectId: "p1",
		toolsReadOnly: true,
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.afterCallbacks.length = 0;
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.updateManyAndReturn.mockResolvedValue([{ streamGeneration: 1 }]);
	mocks.warm.mockResolvedValue(undefined);
	mocks.recap.mockResolvedValue(undefined);
});

describe("Parlume stream verification: warm-up", () => {
	it("warms the runtime after the response when the bot is first admitted", async () => {
		sessionIn("JOINING");

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.warm).not.toHaveBeenCalled();
		expect(mocks.afterCallbacks).toHaveLength(1);
		await mocks.afterCallbacks[0]?.();
		expect(mocks.warm).toHaveBeenCalledWith({
			origin: "https://fabric.example",
			session: {
				id: "s1",
				userId: "u1",
				organizationId: "o1",
				projectId: "p1",
				toolsReadOnly: true,
			},
		});
	});

	it.each(["ACTIVE", "LEAVING", "STOP_FAILED"])(
		"does not warm again when a %s meeting's stream reconnects",
		async (status) => {
			sessionIn(status);

			const response = await POST(request());

			expect(response.status).toBe(200);
			expect(mocks.afterCallbacks).toHaveLength(0);
		},
	);

	it("does not warm a stream that was refused", async () => {
		sessionIn("JOINING");
		mocks.updateManyAndReturn.mockResolvedValue([]);

		const response = await POST(request());

		expect(response.status).toBe(401);
		expect(mocks.afterCallbacks).toHaveLength(0);
	});
});

describe("Parlume stream verification: series recap", () => {
	it("starts the recap once the bot is first admitted to a meeting of a linked series", async () => {
		sessionIn("JOINING", "lm1");

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.afterCallbacks).toHaveLength(2);
		await Promise.all(mocks.afterCallbacks.map((callback) => callback()));
		expect(mocks.recap).toHaveBeenCalledExactlyOnceWith("s1");
	});

	it("starts no recap for a meeting that is not a linked series", async () => {
		sessionIn("JOINING");

		await POST(request());

		await Promise.all(mocks.afterCallbacks.map((callback) => callback()));
		expect(mocks.recap).not.toHaveBeenCalled();
	});

	it.each(["ACTIVE", "LEAVING", "STOP_FAILED"])(
		"does not start the recap again when a %s meeting's stream reconnects",
		async (status) => {
			sessionIn(status, "lm1");

			await POST(request());

			expect(mocks.afterCallbacks).toHaveLength(0);
			expect(mocks.recap).not.toHaveBeenCalled();
		},
	);
});
