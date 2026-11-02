import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getOauthStateMock,
	getMcpConfigMock,
	getMembershipMock,
	consumeStateMock,
	updateTokensMock,
	fetchMock,
} = vi.hoisted(() => ({
	getOauthStateMock: vi.fn(),
	getMcpConfigMock: vi.fn(),
	getMembershipMock: vi.fn(),
	consumeStateMock: vi.fn(),
	updateTokensMock: vi.fn(),
	fetchMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createOauthState: vi.fn(),
	deleteOauthState: vi.fn(),
	consumeOauthState: (...args: unknown[]) => consumeStateMock(...args),
	getMcpConfigByIdInternal: (...args: unknown[]) => getMcpConfigMock(...args),
	getOauthState: (...args: unknown[]) => getOauthStateMock(...args),
	getOrganizationById: vi.fn(),
	getOrganizationMembership: (...args: unknown[]) =>
		getMembershipMock(...args),
	updateMcpAtlassianCloudTokens: (...args: unknown[]) =>
		updateTokensMock(...args),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `enc:${value}`,
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrl: vi.fn(),
	safeFetchOutbound: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));
vi.mock("../../../../orpc/procedures", () => {
	const builder = (kind: string) => {
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (fn: unknown) => ({ handler: fn, builder: kind }),
		});
		return chain;
	};
	return {
		protectedProcedure: builder("protected"),
		publicProcedure: builder("public"),
		tenantProtectedProcedure: builder("tenantProtected"),
		requirePermission: () => ({}),
		Permissions: { MCP_CONNECT: "mcp:connect", MCP_UPDATE: "mcp:update" },
	};
});

import { atlassianCloudProcedures } from "../atlassian-cloud";

const callback = atlassianCloudProcedures.callback as unknown as {
	builder: string;
	handler: (args: {
		input: { code: string; state: string };
		context?: { user: { id: string } };
	}) => Promise<{ success: boolean; message: string }>;
};

const state = {
	id: "state-row",
	state: "opaque-state",
	configId: "example-config",
	userId: "starter-user",
	organizationId: null as string | null,
	redirectUri: "https://app.example.com/api/mcp/atlassian-cloud/callback",
	codeVerifier: "verifier",
	expiresAt: new Date(Date.now() + 600_000),
};
const config = {
	id: "example-config",
	userId: "starter-user" as string | null,
	organizationId: null as string | null,
};

function call(userId?: string) {
	return callback.handler({
		input: { code: "example-code", state: "opaque-state" },
		...(userId ? { context: { user: { id: userId } } } : {}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubEnv("ATLASSIAN_CLOUD_OAUTH_CLIENT_ID", "example-client");
	vi.stubEnv("ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET", "example-secret");
	getOauthStateMock.mockResolvedValue(state);
	getMcpConfigMock.mockResolvedValue(config);
	consumeStateMock.mockResolvedValue(true);
	fetchMock
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "example-access",
					expires_in: 3600,
				}),
				{ status: 200 },
			),
		)
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify([
					{ id: "example-cloud", url: "https://example.com" },
				]),
				{ status: 200 },
			),
		);
});

afterEach(() => vi.unstubAllEnvs());

describe("Atlassian Cloud callback binding", () => {
	it("uses a session-bound procedure", () => {
		expect(callback.builder).toBe("protected");
	});

	it("refuses a different user with the same response as an unknown state", async () => {
		const other = await call("other-user").catch((error: Error) => error);
		getOauthStateMock.mockResolvedValue(null);
		const unknown = await call("starter-user").catch(
			(error: Error) => error,
		);
		expect(other).toMatchObject({ code: "FORBIDDEN" });
		expect(unknown).toMatchObject({ code: "FORBIDDEN" });
		expect(other.message).toBe(unknown.message);
		expect(consumeStateMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateTokensMock).not.toHaveBeenCalled();
	});

	it("refuses another organization admin who did not start the flow", async () => {
		getOauthStateMock.mockResolvedValue({
			...state,
			organizationId: "example-org",
		});
		getMcpConfigMock.mockResolvedValue({
			...config,
			userId: null,
			organizationId: "example-org",
		});
		getMembershipMock.mockResolvedValue({ role: "admin" });

		await expect(call("other-user")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(consumeStateMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateTokensMock).not.toHaveBeenCalled();
	});

	it("refuses an anonymous caller", async () => {
		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateTokensMock).not.toHaveBeenCalled();
	});

	it("allows the starter and saves the grant", async () => {
		expect(await call("starter-user")).toMatchObject({ success: true });
		expect(consumeStateMock).toHaveBeenCalledWith(state);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(updateTokensMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a second redemption before exchange", async () => {
		consumeStateMock
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		expect(await call("starter-user")).toMatchObject({ success: true });
		await expect(call("starter-user")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(updateTokensMock).toHaveBeenCalledTimes(1);
	});

	it("allows only one of two concurrent callbacks to exchange a code", async () => {
		let spent = false;
		consumeStateMock.mockImplementation(async () => {
			if (spent) {
				return false;
			}
			spent = true;
			return true;
		});
		const outcomes = await Promise.allSettled([
			call("starter-user"),
			call("starter-user"),
		]);
		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(updateTokensMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a demoted organization admin", async () => {
		getOauthStateMock.mockResolvedValue({
			...state,
			organizationId: "example-org",
		});
		getMcpConfigMock.mockResolvedValue({
			...config,
			userId: null,
			organizationId: "example-org",
		});
		getMembershipMock.mockResolvedValue({ role: "member" });
		await expect(call("starter-user")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(getMembershipMock).toHaveBeenCalledWith(
			"example-org",
			"starter-user",
		);
		expect(consumeStateMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateTokensMock).not.toHaveBeenCalled();
	});

	it("refuses an unreadable organization role", async () => {
		getOauthStateMock.mockResolvedValue({
			...state,
			organizationId: "example-org",
		});
		getMcpConfigMock.mockResolvedValue({
			...config,
			userId: null,
			organizationId: "example-org",
		});
		getMembershipMock.mockRejectedValue(new Error("unavailable"));
		await expect(call("starter-user")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows the starter while they remain an organization owner", async () => {
		getOauthStateMock.mockResolvedValue({
			...state,
			organizationId: "example-org",
		});
		getMcpConfigMock.mockResolvedValue({
			...config,
			userId: null,
			organizationId: "example-org",
		});
		getMembershipMock.mockResolvedValue({ role: "owner" });
		expect(await call("starter-user")).toMatchObject({ success: true });
		expect(updateTokensMock).toHaveBeenCalledTimes(1);
	});

	it("allows the owner of a user config that also carries an organization", async () => {
		getOauthStateMock.mockResolvedValue({
			...state,
			organizationId: "example-org",
		});
		getMcpConfigMock.mockResolvedValue({
			...config,
			organizationId: "example-org",
		});
		expect(await call("starter-user")).toMatchObject({ success: true });
		expect(getMembershipMock).not.toHaveBeenCalled();
		expect(updateTokensMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a config whose owner changed after the flow started", async () => {
		getMcpConfigMock.mockResolvedValue({ ...config, userId: "other-user" });
		await expect(call("starter-user")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(updateTokensMock).not.toHaveBeenCalled();
	});

	it("refuses a config with no owner or organization", async () => {
		getMcpConfigMock.mockResolvedValue({ ...config, userId: null });
		await expect(call("starter-user")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
