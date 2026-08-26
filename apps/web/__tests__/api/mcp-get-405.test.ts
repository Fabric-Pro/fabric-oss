/**
 * `GET /mcp` refuses the standalone SSE stream with 405 (issue #2254).
 *
 * Every request to this route builds a fresh in-memory `Server` with no
 * event store or cross-instance bridge (see `handleGetRequest`), so a
 * standalone GET SSE stream can never deliver a message — holding one
 * open only burns the full Vercel function budget until the platform
 * kills it at 300s, surfacing as a 504. The Streamable HTTP spec allows
 * refusing that stream with 405, which official SDK clients treat as
 * "standalone SSE unsupported" and carry on from.
 *
 * `getConformance` (the /mcp/conformance surface) is untouched by this
 * change and still delegates to `handleGetRequest` for its real SSE
 * stream — this file does not exercise that path.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@fabricorg/mcp-server", () => ({
	UpstashSessionStore: vi.fn(),
}));

vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: vi.fn(),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(),
}));

vi.mock("@saas/mcp/lib/gateway/platform-tools", () => ({
	executePlatformTool: vi.fn(),
	PLATFORM_TOOL_DEFINITIONS: [],
}));

describe("GET /mcp", () => {
	it("returns 405 with an empty body and Allow: POST, DELETE", async () => {
		const { GET } = await import("../../app/mcp/route");

		const response = await GET(
			new Request("https://example.test/mcp") as never,
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST, DELETE");
		expect(await response.text()).toBe("");
	});
});
