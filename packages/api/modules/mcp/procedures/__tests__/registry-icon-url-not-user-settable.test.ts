/**
 * Guard for an assumption in `apps/web/modules/saas/mcp/lib/server-provided-icon.ts`:
 * no person can set `MCPServer.iconUrl`, so a stored `data:image/` icon (or
 * one on the server's own origin) can only have come from the server, and a
 * reconnect may refresh it.
 *
 * If this fails because the registry now accepts `iconUrl`, do not just
 * update the test: give person-set icons a marker the refresh rule respects,
 * so a reconnect never overwrites them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual };
});

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { registryProcedures } from "../registry";

type Parseable = { parse: (value: unknown) => Record<string, unknown> };

function inputSchema(procedure: unknown): Parseable {
	return (procedure as { "~orpc": { inputSchema: Parseable } })["~orpc"]
		.inputSchema;
}

describe("users cannot set MCPServer.iconUrl (server-provided icon refresh assumption)", () => {
	it("registry create input drops iconUrl", () => {
		const parsed = inputSchema(registryProcedures.create).parse({
			key: "example-server",
			name: "Example server",
			transport: "HTTP",
			authMethods: ["NONE"],
			iconUrl: "data:image/png;base64,AAAA",
		});
		expect(parsed).not.toHaveProperty("iconUrl");
	});

	it("registry update input drops iconUrl", () => {
		const parsed = inputSchema(registryProcedures.update).parse({
			id: "server-1",
			iconUrl: "https://example.com/icon.svg",
		});
		expect(parsed).not.toHaveProperty("iconUrl");
	});
});
