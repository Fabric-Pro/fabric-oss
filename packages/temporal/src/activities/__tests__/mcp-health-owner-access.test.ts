/**
 * The MCP health probe lists tools with the config owner's stored
 * credential. An organization config whose owner has left the organization,
 * or whose role no longer allows reading through MCP, is not probed: the
 * credential is never decrypted or sent, and the health status is left as it
 * was (Fizzy #2903).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	setMcpConfigHealth: vi.fn(),
	canRead: vi.fn(),
	isMember: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	getMcpConfigByIdInternal: async () => db.config,
	setMcpConfigHealth: (...args: unknown[]) => db.setMcpConfigHealth(...args),
	getValidAccessToken: vi.fn(),
	canReadOrganizationMcpConfigs: (...args: unknown[]) => db.canRead(...args),
	canConnectOrganizationMcpConfigs: vi.fn(),
	isOrganizationMember: (...args: unknown[]) => db.isMember(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createMcpClient = vi.hoisted(() => vi.fn());
const getValidMcpTransportAuth = vi.hoisted(() => vi.fn());
vi.mock("@repo/mcp", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createMcpClient: (...args: unknown[]) => createMcpClient(...args),
	closeMcpClient: async () => undefined,
	getValidMcpTransportAuth: (...args: unknown[]) =>
		getValidMcpTransportAuth(...args),
}));

const decryptApiKey = vi.hoisted(() => vi.fn());
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	decryptApiKey: (value: string) => decryptApiKey(value),
}));

import { checkAndUpdateMcpHealth } from "../mcp-activities";

function apiKeyConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_1",
		userId: "user_a",
		organizationId: "org_a",
		baseUrl: "https://mcp.example.com/mcp",
		failoverUrl: null,
		transport: "HTTP",
		authType: "API_KEY",
		encryptedApiKey: "enc:stored-key",
		consecutiveFailures: 1,
		mcpServer: {
			key: "example",
			defaultUrl: "https://mcp.example.com/mcp",
			transport: "HTTP",
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	decryptApiKey.mockImplementation((value: string) =>
		value.replace(/^enc:/, ""),
	);
	createMcpClient.mockResolvedValue({ tools: async () => ({}) });
	getValidMcpTransportAuth.mockResolvedValue({ accessToken: "oauth-token" });
	db.canRead.mockResolvedValue(true);
	db.isMember.mockResolvedValue(true);
});

describe("checkAndUpdateMcpHealth — the config owner's organization access", () => {
	it("probes a config whose owner may still read through it", async () => {
		db.config = apiKeyConfig();

		await checkAndUpdateMcpHealth("cfg_1");

		expect(db.canRead).toHaveBeenCalledWith("user_a", "org_a");
		expect(createMcpClient).toHaveBeenCalledTimes(1);
		expect(db.setMcpConfigHealth).toHaveBeenCalledWith(
			expect.objectContaining({ status: "HEALTHY" }),
		);
	});

	it("skips a config whose owner has left: no decrypt, no connection, status untouched", async () => {
		db.config = apiKeyConfig();
		db.canRead.mockResolvedValue(false);
		db.isMember.mockResolvedValue(false);

		await checkAndUpdateMcpHealth("cfg_1");

		expect(decryptApiKey).not.toHaveBeenCalled();
		expect(createMcpClient).not.toHaveBeenCalled();
		expect(db.setMcpConfigHealth).not.toHaveBeenCalled();
	});

	it("skips a config whose owner's role no longer allows reading", async () => {
		db.config = apiKeyConfig();
		db.canRead.mockResolvedValue(false);
		db.isMember.mockResolvedValue(true);

		await checkAndUpdateMcpHealth("cfg_1");

		expect(createMcpClient).not.toHaveBeenCalled();
		expect(db.setMcpConfigHealth).not.toHaveBeenCalled();
	});

	it("fails the activity, without probing, when the access read fails", async () => {
		db.config = apiKeyConfig();
		db.canRead.mockRejectedValue(new Error("database unavailable"));

		await expect(checkAndUpdateMcpHealth("cfg_1")).rejects.toThrow(
			"database unavailable",
		);
		expect(decryptApiKey).not.toHaveBeenCalled();
		expect(createMcpClient).not.toHaveBeenCalled();
		expect(db.setMcpConfigHealth).not.toHaveBeenCalled();
	});

	it("does not check a personal config (no organization)", async () => {
		db.config = apiKeyConfig({ organizationId: null });

		await checkAndUpdateMcpHealth("cfg_1");

		expect(db.canRead).not.toHaveBeenCalled();
		expect(createMcpClient).toHaveBeenCalledTimes(1);
	});

	it("does not decrypt or connect an API key config to a different failover path", async () => {
		db.config = apiKeyConfig({
			failoverUrl: "https://mcp.example.com/failover",
		});

		await checkAndUpdateMcpHealth("cfg_1");

		expect(decryptApiKey).not.toHaveBeenCalled();
		expect(createMcpClient).not.toHaveBeenCalled();
		expect(db.setMcpConfigHealth).toHaveBeenCalledWith(
			expect.objectContaining({ status: "DEGRADED" }),
		);
	});

	it("uses a stored API key when the destination differs only by a trailing slash", async () => {
		db.config = apiKeyConfig({
			baseUrl: "https://mcp.example.com/mcp/",
			failoverUrl: "https://mcp.example.com/mcp",
		});

		await checkAndUpdateMcpHealth("cfg_1");

		expect(decryptApiKey).toHaveBeenCalledWith("enc:stored-key");
		expect(createMcpClient).toHaveBeenCalledWith(
			expect.objectContaining({
				serverUrl: "https://mcp.example.com/mcp",
				headers: { Authorization: "Bearer stored-key" },
			}),
		);
	});

	it("passes the config read's OAuth grant generation to the credential resolver", async () => {
		db.config = apiKeyConfig({
			authType: "OAUTH2",
			encryptedApiKey: null,
			oauthGrantGeneration: 7,
		});

		await checkAndUpdateMcpHealth("cfg_1");

		expect(getValidMcpTransportAuth).toHaveBeenCalledWith({
			configId: "cfg_1",
			userId: "user_a",
			organizationId: "org_a",
			endpoint: "https://mcp.example.com/mcp",
			expectedGrantGeneration: 7,
		});
		expect(createMcpClient).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: { Authorization: "Bearer oauth-token" },
			}),
		);
	});
});
