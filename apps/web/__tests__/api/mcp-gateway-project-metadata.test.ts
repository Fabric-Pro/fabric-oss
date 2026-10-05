/**
 * `/.well-known/oauth-protected-resource/api/mcp-gateway/projects/<id>` — the
 * document a project's gateway URL points a client at.
 *
 * Its `resource` is exactly the project's URL: that is the value a client
 * compares with the URL it was configured with, and the one it asks for when it
 * signs in. Any well-formed id is answered the same way and the database is
 * never asked, so the document says nothing about which projects exist.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getOAuthServerConfig = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getOAuthServerConfig: (args: unknown) => getOAuthServerConfig(args),
		},
	},
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	getBaseUrl: () => "https://app.example.com",
}));

// A project's metadata must never reach the database. Any read fails the test.
vi.mock(
	"@repo/database",
	() =>
		new Proxy(
			{},
			{
				get: (_target, name) => {
					throw new Error(
						`the metadata route read ${String(name)} from the database`,
					);
				},
			},
		),
);

const ISSUER = "https://app.example.com/api/auth";
const ROUTE =
	"../../app/.well-known/oauth-protected-resource/api/mcp-gateway/projects/[projectId]/route";

async function get(projectId: string) {
	const { GET } = await import(ROUTE);
	return GET(
		new Request(
			`https://app.example.com/.well-known/oauth-protected-resource/api/mcp-gateway/projects/${projectId}`,
		),
		{ params: Promise.resolve({ projectId }) },
	) as Promise<Response>;
}

beforeEach(() => {
	vi.clearAllMocks();
	getOAuthServerConfig.mockResolvedValue({ issuer: ISSUER });
});

describe("a project gateway's protected-resource metadata", () => {
	it("names the project's URL as the resource, with the issuer and the scopes an agent may hold", async () => {
		const response = await get("project-example-one");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			resource:
				"https://app.example.com/api/mcp-gateway/projects/project-example-one",
			authorization_servers: [ISSUER],
			scopes_supported: [
				"mcp:read",
				"instructions:read",
				"instructions:write",
				"offline_access",
			],
			bearer_methods_supported: ["header"],
			resource_name: "Fabric",
		});
	});

	it("is public and cached like the organization-wide document", async () => {
		const response = await get("project-example-one");

		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=15, stale-while-revalidate=15",
		);
	});

	it("answers any well-formed id the same way, without asking the database", async () => {
		const known = await (await get("project-example-one")).json();
		const unknown = await (await get("project-that-does-not-exist")).json();

		expect(unknown.authorization_servers).toEqual(
			known.authorization_servers,
		);
		expect(unknown.resource).toBe(
			"https://app.example.com/api/mcp-gateway/projects/project-that-does-not-exist",
		);
	});

	it("answers a segment that cannot be a project id with 404, and builds no document for it", async () => {
		for (const segment of ["a.b", "a%2Fb", "a b", "x".repeat(65)]) {
			const response = await get(segment);

			expect(response.status, segment).toBe(404);
		}
		expect(getOAuthServerConfig).not.toHaveBeenCalled();
	});

	it("answers a preflight", async () => {
		const { OPTIONS } = await import(ROUTE);

		const response = OPTIONS() as Response;

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-methods")).toBe(
			"GET, OPTIONS",
		);
	});
});
