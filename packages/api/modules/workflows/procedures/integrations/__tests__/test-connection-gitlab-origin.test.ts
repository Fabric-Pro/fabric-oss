/**
 * The GitLab connection tests send the token to the instance address the
 * person entered or saved. An internal address there (loopback, private,
 * link-local / cloud metadata) or a non-https one is reported as invalid and
 * never fetched; a self-hosted public instance is tested through the
 * outbound guard; and a saved connection is tested against the instance that
 * issued it (its issuer's origin), not against gitlab.com.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	listWorkflowIntegrations: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listWorkflowIntegrations: h.listWorkflowIntegrations,
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	decryptApiKey: (value: string) => value,
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		protectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
	};
});

vi.stubGlobal("fetch", h.fetch);

const { testIntegrationConnectionProcedure } = await import(
	"../test-connection"
);
const { testSavedConnectionProcedure } = await import(
	"../test-saved-connection"
);

type Result = { success: boolean; error?: string };
const testEntered = (
	testIntegrationConnectionProcedure as unknown as {
		handler: (args: {
			input: { type: string; credentials: Record<string, string> };
		}) => Promise<Result>;
	}
).handler;
const testSaved = (
	testSavedConnectionProcedure as unknown as {
		handler: (args: {
			input: { type: string; organizationId?: string | null };
			context: {
				user: { id: string };
				session: { activeOrganizationId: string | null };
			};
		}) => Promise<Result>;
	}
).handler;

const INTERNAL = [
	"https://169.254.169.254",
	"https://127.0.0.1",
	"https://10.0.0.5",
	"http://gitlab.example.com",
];

beforeEach(() => {
	h.fetch.mockReset();
	h.fetch.mockResolvedValue(
		new Response(JSON.stringify({ username: "dev" }), { status: 200 }),
	);
	h.listWorkflowIntegrations.mockReset();
});

describe("testing entered GitLab credentials", () => {
	it.each(INTERNAL)("refuses %s without fetching", async (address) => {
		const result = await testEntered({
			input: {
				type: "GITLAB",
				credentials: {
					GITLAB_ACCESS_TOKEN: "glpat-example",
					GITLAB_URL: address,
				},
			},
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Invalid GitLab URL/);
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it("tests a self-hosted public instance through the outbound guard", async () => {
		await testEntered({
			input: {
				type: "GITLAB",
				credentials: {
					GITLAB_ACCESS_TOKEN: "glpat-example",
					domain: "gitlab.example.com",
				},
			},
		});

		const [url, init] = h.fetch.mock.calls[0] as [
			string,
			RequestInit & { dispatcher?: unknown },
		];
		expect(url).toBe("https://gitlab.example.com/api/v4/user");
		expect(init.dispatcher).toBeDefined();
	});
});

describe("testing a saved GitLab connection", () => {
	const context = {
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-1" },
	};

	function saved(credential: Record<string, unknown>) {
		h.listWorkflowIntegrations.mockResolvedValue([
			{ id: "wi-1", credentials: JSON.stringify(credential) },
		]);
	}

	it.each(INTERNAL)(
		"refuses an issuer recorded at %s without fetching",
		async (origin) => {
			saved({ access_token: "token", issuer: { kind: "pat", origin } });

			const result = await testSaved({
				input: { type: "GITLAB", organizationId: "org-1" },
				context,
			});

			expect(result.success).toBe(false);
			expect(h.fetch).not.toHaveBeenCalled();
		},
	);

	it("tests an OAuth connection against the instance that issued it, not gitlab.com", async () => {
		saved({
			access_token: "token",
			issuer: {
				kind: "mcp-dcr",
				mcpConfigId: "cfg-1",
				serverKey: "gitlab-official",
				clientId: "dcr-client",
				origin: "https://gitlab.example.com",
			},
		});

		await testSaved({
			input: { type: "GITLAB", organizationId: "org-1" },
			context,
		});

		expect(h.fetch.mock.calls[0]?.[0]).toBe(
			"https://gitlab.example.com/api/v4/user",
		);
	});
});
