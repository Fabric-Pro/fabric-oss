import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
	authorized: vi.fn(),
	sweep: vi.fn(),
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: mocks.authorized,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-sweep", () => ({
	sweepOverdueParlumeSessions: mocks.sweep,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: vi.fn(),
}));

function request(token = "example-token") {
	return new NextRequest("https://example.com/api/internal/parlume/sweep", {
		method: "POST",
		headers: { "X-Agent-Service-Token": token },
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.authorized.mockReturnValue(true);
	mocks.sweep.mockResolvedValue(1);
});

describe("Parlume session sweep route", () => {
	it("refuses a caller without the service token", async () => {
		mocks.authorized.mockReturnValue(false);

		const response = await POST(request());

		expect(response.status).toBe(401);
		expect(mocks.authorized).toHaveBeenCalledWith("example-token");
		expect(mocks.sweep).not.toHaveBeenCalled();
	});

	it("sweeps every project and answers how many sessions it finalized", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ swept: 1 });
		expect(mocks.sweep).toHaveBeenCalledOnce();
		expect(mocks.sweep).toHaveBeenCalledWith();
	});

	it("answers 503 when the sweep cannot run, for the next tick to retry", async () => {
		mocks.sweep.mockRejectedValue(new Error("database unavailable"));

		const response = await POST(request());

		expect(response.status).toBe(503);
	});
});
