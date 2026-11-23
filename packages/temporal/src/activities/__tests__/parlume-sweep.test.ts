import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { requestParlumeSessionSweep } = await import("../parlume-sweep");

describe("requestParlumeSessionSweep", () => {
	beforeEach(() => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "example-secret");
		vi.stubEnv("FABRIC_INTERNAL_URL", "https://fabric.example.com");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("asks the web app to sweep every project with the service token", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ swept: 2 })),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(requestParlumeSessionSweep()).resolves.toEqual({
			swept: 2,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://fabric.example.com/api/internal/parlume/sweep",
			expect.objectContaining({
				method: "POST",
				headers: { "X-Agent-Service-Token": "example-secret" },
			}),
		);
	});

	it("fails the run when the web app cannot sweep, for the next tick to retry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 503 })),
		);

		await expect(requestParlumeSessionSweep()).rejects.toThrow(
			"Parlume session sweep request failed (HTTP 503).",
		);
	});

	it("does not call the web app without the service secret", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(requestParlumeSessionSweep()).rejects.toMatchObject({
			nonRetryable: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
