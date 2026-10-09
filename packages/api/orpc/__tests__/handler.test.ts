import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	unlazyRouter: vi.fn(),
}));

vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	unlazyRouter: mocks.unlazyRouter,
}));

vi.mock("../router", async () => {
	const { os } = await import("@orpc/server");
	return {
		router: {
			ping: os
				.route({ method: "GET", path: "/ping" })
				.handler(async () => "pong"),
		},
	};
});

import { openApiHandler } from "../handler";

async function resolvedRouter() {
	const { router } = await import("../router");
	return router;
}

const handleRequest = (path: string) =>
	openApiHandler.handle(new Request(`http://localhost/api${path}`), {
		prefix: "/api",
		context: {},
	});

beforeEach(() => {
	mocks.unlazyRouter.mockReset();
});

describe("openApiHandler", () => {
	it("builds from the resolved router and serves a REST route", async () => {
		// Arrange
		mocks.unlazyRouter.mockResolvedValue(await resolvedRouter());

		// Act
		const { matched, response } = await handleRequest("/ping");

		// Assert
		expect(matched).toBe(true);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toBe("pong");
	});

	it("leaves an unmatched path unmatched so the API can answer 404", async () => {
		// Arrange
		mocks.unlazyRouter.mockResolvedValue(await resolvedRouter());

		// Act
		const { matched } = await handleRequest("/does-not-exist");

		// Assert
		expect(matched).toBe(false);
	});
});

describe("openApiHandler after a failed build", () => {
	it("retries the build instead of failing every later request", async () => {
		// Arrange
		vi.resetModules();
		mocks.unlazyRouter
			.mockRejectedValueOnce(new Error("module failed to load"))
			.mockResolvedValue(await resolvedRouter());
		const { openApiHandler: freshHandler } = await import("../handler");
		const request = () =>
			freshHandler.handle(new Request("http://localhost/api/ping"), {
				prefix: "/api",
				context: {},
			});

		// Act
		const first = request();
		await expect(first).rejects.toThrow("module failed to load");
		const second = await request();

		// Assert
		expect(second.matched).toBe(true);
		expect(mocks.unlazyRouter).toHaveBeenCalledTimes(2);
	});
});
