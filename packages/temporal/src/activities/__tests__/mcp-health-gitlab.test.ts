/**
 * The MCP health probe connects to the failover URL when one is set. For a
 * GitLab personal server that URL is where the owner's GitLab connection
 * token would go, so it must pass the same origin check as the saved
 * endpoint, and the probe's transport must use the GitLab fetch.
 *
 * A GitLab personal config holds no token of its own, whatever auth type it
 * names: one with an owner is probed with that owner's GitLab connection
 * (an API key saved on it is never decrypted), and one with no owner is
 * refused as unhealthy before anything is decrypted, rather than falling
 * through to the generic direct-decrypt path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	setMcpConfigHealth: vi.fn(),
	getValidAccessToken: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	getMcpConfigByIdInternal: async () => db.config,
	authorizeMcpConfigAccess: async () => db.config,
	// The GitLab credential checks the caller still belongs to the config's
	// organization; they do.
	isOrganizationMember: async () => true,
	// The owner gate before the probe (Fizzy #2903): they may read.
	canReadOrganizationMcpConfigs: async () => true,
	canConnectOrganizationMcpConfigs: async () => true,
	setMcpConfigHealth: (...args: unknown[]) => db.setMcpConfigHealth(...args),
	getValidAccessToken: (...args: unknown[]) =>
		db.getValidAccessToken(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getGitLabConnectionToken = vi.hoisted(() => vi.fn());
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabConnectionToken: (...args: unknown[]) =>
		getGitLabConnectionToken(...args),
}));

const createMcpClient = vi.hoisted(() => vi.fn());
vi.mock("@repo/mcp", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createMcpClient: (...args: unknown[]) => createMcpClient(...args),
	closeMcpClient: async () => undefined,
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
}));

import { checkAndUpdateMcpHealth } from "../mcp-activities";

function gitlabConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: "cfg_gl",
		userId: "user_a",
		organizationId: "org_a",
		baseUrl: null,
		failoverUrl: null,
		transport: "HTTP",
		authType: "OAUTH2",
		consecutiveFailures: 0,
		mcpServer: {
			key: "gitlab-official",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
			transport: "HTTP",
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getGitLabConnectionToken.mockResolvedValue({
		ok: true,
		accessToken: "connection-token",
		issuer: null,
		origin: "https://gitlab.com",
		integrationId: "wi_1",
		generation: 1,
		settings: {},
	});
	createMcpClient.mockResolvedValue({ tools: async () => ({}) });
});

describe("checkAndUpdateMcpHealth — GitLab personal server", () => {
	it("gives a failover URL on another origin no token and opens no connection", async () => {
		db.config = gitlabConfig({
			failoverUrl: "https://failover.example.com/mcp",
		});

		await checkAndUpdateMcpHealth("cfg_gl");

		expect(createMcpClient).not.toHaveBeenCalled();
		expect(db.setMcpConfigHealth).toHaveBeenCalledWith(
			expect.objectContaining({ status: "DEGRADED" }),
		);
	});

	it("probes a failover URL on the credential's origin through the GitLab fetch", async () => {
		db.config = gitlabConfig({
			failoverUrl: "https://gitlab.com/api/v4/mcp-failover",
		});

		await checkAndUpdateMcpHealth("cfg_gl");

		expect(createMcpClient).toHaveBeenCalledTimes(1);
		const [options] = createMcpClient.mock.calls[0] as [
			{
				serverUrl: string;
				headers: Record<string, string>;
				fetch?: (url: string, init?: RequestInit) => Promise<Response>;
			},
		];
		expect(options.serverUrl).toBe(
			"https://gitlab.com/api/v4/mcp-failover",
		);
		expect(options.headers.Authorization).toBe("Bearer connection-token");
		expect(options.fetch).toBeTypeOf("function");
		// The fetch refuses anything off the credential's origin.
		await expect(
			options.fetch?.("https://failover.example.com/mcp"),
		).rejects.toMatchObject({ code: "origin-mismatch" });
	});

	it.each(["API_KEY", "NONE"])(
		"probes a %s config with the owner's connection token, never a key stored on it",
		async (authType) => {
			db.config = gitlabConfig({
				authType,
				encryptedApiKey: "enc:pasted-key",
			});

			await checkAndUpdateMcpHealth("cfg_gl");

			expect(getGitLabConnectionToken).toHaveBeenCalledTimes(1);
			expect(createMcpClient).toHaveBeenCalledTimes(1);
			const [options] = createMcpClient.mock.calls[0] as [
				{ headers: Record<string, string> },
			];
			expect(options.headers.Authorization).toBe(
				"Bearer connection-token",
			);
			expect(JSON.stringify(options.headers)).not.toContain("pasted-key");
			expect(db.getValidAccessToken).not.toHaveBeenCalled();
		},
	);

	it("refuses an organization-level config with no owner: no token is decrypted and no connection is opened", async () => {
		db.config = gitlabConfig({
			userId: null,
			encryptedAccessToken: "enc:legacy-copy",
		});

		await checkAndUpdateMcpHealth("cfg_gl");

		expect(createMcpClient).not.toHaveBeenCalled();
		expect(getGitLabConnectionToken).not.toHaveBeenCalled();
		expect(db.setMcpConfigHealth).toHaveBeenCalledWith(
			expect.objectContaining({ status: "DEGRADED" }),
		);
	});
});
