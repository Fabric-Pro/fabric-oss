import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fabricorg/mcp-server", () => ({ UpstashSessionStore: vi.fn() }));

vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: vi.fn().mockResolvedValue({ valid: false }),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("@repo/api/lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));
vi.mock("@saas/mcp/lib/record-cli-reach", () => ({
	recordCliReach: vi.fn(),
	toOAuthClientIdentity: (id: string) => ({ kind: "OAUTH_CLIENT", id }),
	toOrganizationKeyIdentity: (id: string) => ({
		kind: "ORGANIZATION_API_KEY",
		id,
	}),
	toUserKeyIdentity: (id: string) => ({ kind: "USER_API_KEY", id }),
}));

const verifyOAuthAccessToken = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		organizationApiKey: {
			findFirst: vi.fn().mockResolvedValue(null),
			update: vi.fn(),
		},
		user: { findUnique: vi.fn() },
	},
	isOrganizationMember: vi.fn().mockResolvedValue(true),
	resolveUserOrganization: vi.fn(),
	isOrganizationLive: vi.fn().mockResolvedValue(true),
	verifyOAuthAccessToken: (...args: unknown[]) =>
		verifyOAuthAccessToken(...args),
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	getBaseUrl: () => "https://app.example.com",
}));

const MCP_URL = "https://app.example.com/mcp";

function token(overrides: Record<string, unknown> = {}) {
	return {
		valid: true,
		tokenId: "token-1",
		clientRowId: "client-1",
		clientName: "Example CLI",
		userId: "user-1",
		userName: "Example User",
		email: "dev@example.com",
		role: "user",
		organizationId: "org-example",
		projectId: null,
		audience: null,
		scopes: ["mcp:read"],
		...overrides,
	};
}

async function initialize(rawToken: string) {
	const { POST } = await import("../../app/mcp/route");
	const response = await POST(
		new Request(MCP_URL, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				host: "localhost:3001",
				authorization: `Bearer ${rawToken}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			}),
		}) as never,
	);
	await response.text();
	return response;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
	vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
});

describe("POST /mcp OAuth resource binding", () => {
	it("refuses a project-bound OAuth token at the organization-wide URL", async () => {
		verifyOAuthAccessToken.mockResolvedValue(
			token({ projectId: "project-example" }),
		);

		const response = await initialize("fat_project");

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(
			'error="invalid_token"',
		);
	});

	it("accepts an organization-wide OAuth token issued for MCP", async () => {
		verifyOAuthAccessToken.mockResolvedValue(token());

		const response = await initialize("fat_organization");

		expect(response.status).toBe(200);
		expect(response.headers.get("mcp-session-id")).toBeTruthy();
	});

	it("rejects a valid OAuth token issued for another audience", async () => {
		verifyOAuthAccessToken.mockResolvedValue(token({ audience: "api" }));

		const response = await initialize("fat_api");

		expect(response.status).toBe(401);
	});

	it("refuses an invalid fat_ credential instead of creating an anonymous session", async () => {
		verifyOAuthAccessToken.mockResolvedValue(
			token({ valid: false, reason: "unknown" }),
		);

		const response = await initialize("fat_invalid");

		expect(response.status).toBe(401);
		expect(response.headers.get("mcp-session-id")).toBeNull();
	});
});
