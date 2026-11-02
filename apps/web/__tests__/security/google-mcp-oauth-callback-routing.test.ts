import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mcpCallback, betterAuthCallback } = vi.hoisted(() => ({
	mcpCallback: vi.fn(),
	betterAuthCallback: vi.fn(),
}));

vi.mock("@repo/api", () => ({ app: {} }));
vi.mock("hono/vercel", () => ({ handle: () => betterAuthCallback }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { mcp: { oauth: { callback: mcpCallback } } },
}));
vi.mock("../../app/start-web-telemetry", () => ({}));

import { GET } from "../../app/api/auth/callback/google/route";

const MCP_STATE = "01234567-89ab-4cde-8fab-0123456789ab";

beforeEach(() => {
	vi.clearAllMocks();
	betterAuthCallback.mockResolvedValue(new Response("better-auth"));
});

describe("Google callback routing", () => {
	it("sends an unknown or replayed MCP state to the bound callback", async () => {
		mcpCallback.mockRejectedValue(
			new Error(
				"This connection cannot be completed. Start it again from your account.",
			),
		);
		const response = await GET(
			new NextRequest(
				`https://app.example.com/api/auth/callback/google?code=example-code&state=${MCP_STATE}`,
			),
		);
		expect(mcpCallback).toHaveBeenCalledWith({
			code: "example-code",
			state: MCP_STATE,
			error: undefined,
		});
		expect(betterAuthCallback).not.toHaveBeenCalled();
		expect(await response.text()).toContain(
			"This connection cannot be completed.",
		);
	});

	it("forwards a Better Auth state to its own callback", async () => {
		const response = await GET(
			new NextRequest(
				"https://app.example.com/api/auth/callback/google?code=example-code&state=0123456789abcdef0123456789abcdef",
			),
		);
		expect(await response.text()).toBe("better-auth");
		expect(betterAuthCallback).toHaveBeenCalledOnce();
		expect(mcpCallback).not.toHaveBeenCalled();
	});
});
