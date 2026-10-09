import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	order: [] as string[],
}));

vi.mock("@repo/observability", () => ({
	initAppInsights: () => mocks.order.push("init"),
}));
vi.mock("@shared/lib/web-app-insights", () => ({
	startWebAppInsights: () => mocks.order.push("role"),
}));

beforeEach(() => {
	mocks.order.length = 0;
	vi.resetModules();
});

describe("start-web-telemetry", () => {
	it("sets the cloud role, then initialises custom events and metrics, on import", async () => {
		await import("../app/start-web-telemetry");

		expect(mocks.order).toEqual(["role", "init"]);
	});

	it.each([
		"../app/api/auth/callback/google/route.ts",
		"../app/api/vscode-auth/approve/route.ts",
		"../app/api/vscode-auth/deny/route.ts",
	])(
		"is imported by %s, which loads @repo/api without the catch-all route",
		async (path) => {
			const { readFileSync } = await import("node:fs");
			const source = readFileSync(new URL(path, import.meta.url), "utf8");

			expect(source).toMatch(/import "(\.\.\/)+start-web-telemetry";/);
		},
	);
});
