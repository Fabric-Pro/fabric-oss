/**
 * The public v1 sub-app's CORS preflight (Fizzy #2618).
 *
 * `@fabricorg/sdk` runs in browsers too, and a browser sends an OPTIONS
 * preflight before any cross-origin request whose method is not a simple one.
 * A method missing from the sub-app's `allowMethods` fails that preflight, so
 * the request never leaves the browser — which is what happened to the synced
 * context route, the first PUT on this surface. Every method a v1 route
 * answers is pinned here against the real `createPublicV1Routes`, with only
 * the route modules and the key middleware stubbed out.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	createUserApiKey: vi.fn(),
	db: {},
	listUserApiKeys: vi.fn(),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	// A preflight carries no key; if one ever reached this, it would 401.
	requireApiKey:
		() => async (c: { json: (b: unknown, s: number) => unknown }) =>
			c.json({ error: "Missing API key" }, 401),
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
}));

vi.mock("../../external-api/middleware/api-rate-limit", () => ({
	externalApiRateLimit:
		() => async (_c: unknown, next: () => Promise<void>) =>
			next(),
}));

for (const [modulePath, name] of [
	["../agents", "registerAgentRoutes"],
	["../channels", "registerChannelRoutes"],
	["../chats", "registerChatRoutes"],
	["../contexts", "registerContextRoutes"],
	["../documents", "registerDocumentRoutes"],
	["../features", "registerFeatureRoutes"],
	["../frames", "registerFrameRoutes"],
	["../instructions", "registerInstructionRoutes"],
	["../integrations", "registerIntegrationRoutes"],
	["../knowledge", "registerKnowledgeRoutes"],
	["../mcp", "registerMcpRoutes"],
	["../projects", "registerProjectRoutes"],
	["../prompts", "registerPromptRoutes"],
	["../reports", "registerReportRoutes"],
	["../skills", "registerSkillRoutes"],
	["../workflows", "registerWorkflowRoutes"],
	["../workspaces", "registerWorkspaceRoutes"],
] as const) {
	vi.doMock(modulePath, () => ({ [name]: () => undefined }));
}

const { createPublicV1Routes } = await import("../routes");

function preflight(path: string, method: string) {
	return new Request(`http://localhost${path}`, {
		method: "OPTIONS",
		headers: {
			Origin: "https://app.example.com",
			"Access-Control-Request-Method": method,
			"Access-Control-Request-Headers":
				"authorization, content-type, idempotency-key",
		},
	});
}

describe("public v1 CORS preflight", () => {
	it("allows PUT for the synced context route, without a key", async () => {
		const res = await createPublicV1Routes().fetch(
			preflight("/projects/project-1/contexts/synced-files", "PUT"),
		);

		expect(res.status).toBe(204);
		const allowed = (res.headers.get("access-control-allow-methods") ?? "")
			.split(",")
			.map((method) => method.trim());
		expect(allowed).toContain("PUT");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("allows DELETE for the synced context route, without a key (Fizzy #2636)", async () => {
		const res = await createPublicV1Routes().fetch(
			preflight("/projects/project-1/contexts/synced-files", "DELETE"),
		);

		expect(res.status).toBe(204);
		const allowed = (res.headers.get("access-control-allow-methods") ?? "")
			.split(",")
			.map((method) => method.trim());
		expect(allowed).toContain("DELETE");
		// A DELETE with a JSON body needs Content-Type allowed as well.
		expect(
			(
				res.headers.get("access-control-allow-headers") ?? ""
			).toLowerCase(),
		).toContain("content-type");
	});

	it.each([["GET"], ["POST"], ["PATCH"], ["DELETE"]])(
		"still allows %s",
		async (method) => {
			const res = await createPublicV1Routes().fetch(
				preflight("/projects/project-1", method),
			);

			expect(
				(res.headers.get("access-control-allow-methods") ?? "").split(
					",",
				),
			).toContain(method);
		},
	);
});
