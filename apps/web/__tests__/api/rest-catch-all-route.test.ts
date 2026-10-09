/**
 * `app/api/[[...rest]]/route.ts` — schedules `flushAppInsights()` via
 * `after()` on every request, so Vercel's Fluid Compute freezing the process
 * between requests never strands a batch of telemetry unflushed. `after()`
 * throws outside a real Next.js request scope (node_modules/next/dist/
 * server/after/after.js), so it is mocked here rather than exercised for
 * real — this is a unit test of the wiring, not of `after()` itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
	flushAppInsights: vi.fn().mockResolvedValue(undefined),
	initAppInsights: vi.fn(),
	startWebAppInsights: vi.fn(),
	handle: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@repo/observability", () => ({
	flushAppInsights: mocks.flushAppInsights,
	initAppInsights: mocks.initAppInsights,
}));
vi.mock("@shared/lib/web-app-insights", () => ({
	startWebAppInsights: mocks.startWebAppInsights,
}));
vi.mock("@repo/api", () => ({ app: {} }));
vi.mock("hono/vercel", () => ({
	handle: () => mocks.handle,
}));

beforeEach(() => {
	mocks.after.mockReset();
	mocks.flushAppInsights.mockClear();
	mocks.handle.mockReset();
	mocks.handle.mockResolvedValue(new Response("ok", { status: 200 }));
});

describe("app/api/[[...rest]]/route.ts", () => {
	it("sets the cloud role before it initialises the custom-event transport", async () => {
		vi.resetModules();
		const order: string[] = [];
		mocks.startWebAppInsights.mockImplementation(() => order.push("role"));
		mocks.initAppInsights.mockImplementation(() => order.push("init"));

		await import("../../app/api/[[...rest]]/route");

		expect(order).toEqual(["role", "init"]);
	});

	it("schedules a flush via after() on a successful request", async () => {
		const { GET } = await import("../../app/api/[[...rest]]/route");

		const response = await GET(new Request("https://app.fabric.pro/api/x"));

		expect(response.status).toBe(200);
		expect(mocks.after).toHaveBeenCalledTimes(1);
		const scheduled = mocks.after.mock.calls[0]?.[0] as () => unknown;
		await scheduled();
		expect(mocks.flushAppInsights).toHaveBeenCalledTimes(1);
	});

	it("still schedules a flush when the underlying handler throws", async () => {
		mocks.handle.mockRejectedValue(new Error("boom"));
		const { POST } = await import("../../app/api/[[...rest]]/route");

		const response = await POST(
			new Request("https://app.fabric.pro/api/x", { method: "POST" }),
		);

		expect(response.status).toBe(500);
		expect(mocks.after).toHaveBeenCalledTimes(1);
	});
});
