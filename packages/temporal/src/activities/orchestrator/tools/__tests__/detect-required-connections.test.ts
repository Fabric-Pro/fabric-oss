/**
 * Unit tests for `checkServerConnection`, covering the `hasValidCredentials`
 * gate it wraps (not exported, so covered through this entry point).
 *
 * `needsReauth` describes an OAuth GRANT and is cleared only by an OAuth
 * reconnect. Before this fix, `hasValidCredentials` short-circuited on
 * `config.needsReauth` before branching on `authType`, so a config edited
 * away from OAuth (e.g. to API_KEY) could still carry a stale `needsReauth`
 * from its earlier OAuth life and be reported as having no valid
 * credentials even though its current API key works. The short-circuit must
 * only apply to configs that are actually on OAuth2.
 *
 * The Prisma client is mocked at the module boundary so the test runs
 * without a live DB, following the convention in
 * `find-default-mcp-config.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIntegrationResolve = vi.fn();
const mockMcpServerFindUnique = vi.fn();
const mockMcpServerFindMany = vi.fn();
const mockMcpConfigFindFirst = vi.fn();

const mockGitLabConnectionStatus = vi.fn();

vi.mock("@repo/database", async () => ({
	...(await vi.importActual<Record<string, unknown>>(
		"@repo/database/prisma/hidden-mcp-server-keys",
	)),
	// Mirrors the real predicate (prisma/queries/lib/gitlab-personal-keys.ts).
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	resolveWorkflowIntegrationForProvider: (...args: unknown[]) =>
		mockIntegrationResolve(...args),
	db: {
		mCPServer: {
			findUnique: (...args: unknown[]) =>
				mockMcpServerFindUnique(...args),
			findMany: (...args: unknown[]) => mockMcpServerFindMany(...args),
		},
		mCPConfig: {
			findFirst: (...args: unknown[]) => mockMcpConfigFindFirst(...args),
		},
	},
}));

vi.mock("@repo/integrations/gitlab", () => ({
	getGitLabConnectionStatus: (...args: unknown[]) =>
		mockGitLabConnectionStatus(...args),
}));

import {
	checkServerConnection,
	detectMissingIntegrations,
	detectRequiredConnections,
	searchSystemServersForTask,
} from "../detect-required-connections";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("checkServerConnection — needsReauth scoped to OAuth2 configs", () => {
	it("treats an API_KEY config with a stale needsReauth flag as having valid credentials", async () => {
		mockMcpServerFindUnique.mockResolvedValueOnce({
			id: "srv-1",
			key: "example-server",
			name: "Example Server",
			description: null,
			authMethods: ["OAUTH2", "API_KEY"],
			isSystemProvided: true,
			iconUrl: null,
			category: null,
		});
		mockMcpConfigFindFirst.mockResolvedValueOnce({
			id: "cfg-1",
			authType: "API_KEY",
			encryptedApiKey: "encrypted-live-key",
			encryptedAccessToken: null,
			tokenExpiresAt: null,
			// Left over from an earlier OAuth life on this same config; the
			// current API_KEY credential is unaffected by it.
			needsReauth: true,
		});

		const result = await checkServerConnection(
			"srv-1",
			"user-1",
			undefined,
		);

		expect(result).toEqual({ isConnected: true });
	});
});

describe("checkServerConnection — GitLab personal servers follow the connection whatever the auth type", () => {
	const gitlabServer = {
		id: "srv-gl",
		key: "gitlab",
		name: "GitLab",
		description: null,
		authMethods: ["OAUTH2"],
		isSystemProvided: true,
		iconUrl: null,
		category: null,
	};

	it.each(["API_KEY", "NONE"])(
		"reports a %s GitLab config as needing a connection when GitLab is not connected, though it stores a key",
		async (authType) => {
			mockMcpServerFindUnique.mockResolvedValueOnce(gitlabServer);
			mockMcpConfigFindFirst.mockResolvedValueOnce({
				id: "cfg-gl",
				authType,
				encryptedApiKey: "encrypted-glpat",
				encryptedAccessToken: null,
				tokenExpiresAt: null,
				needsReauth: false,
			});
			mockGitLabConnectionStatus.mockResolvedValueOnce({
				connected: false,
				needsReauth: false,
			});

			const result = await checkServerConnection(
				"srv-gl",
				"user-1",
				"org-1",
			);

			expect(result.isConnected).toBe(false);
			expect(mockGitLabConnectionStatus).toHaveBeenCalledWith({
				userId: "user-1",
				organizationId: "org-1",
			});
		},
	);

	it("reports an API_KEY GitLab config as connected when the GitLab connection is usable", async () => {
		mockMcpServerFindUnique.mockResolvedValueOnce(gitlabServer);
		mockMcpConfigFindFirst.mockResolvedValueOnce({
			id: "cfg-gl",
			authType: "API_KEY",
			encryptedApiKey: null,
			encryptedAccessToken: null,
			tokenExpiresAt: null,
			needsReauth: false,
		});
		mockGitLabConnectionStatus.mockResolvedValueOnce({
			connected: true,
			needsReauth: false,
		});

		expect(
			await checkServerConnection("srv-gl", "user-1", "org-1"),
		).toEqual({ isConnected: true });
	});

	it("still reports a GitLab server with no config row as needing one", async () => {
		mockMcpServerFindUnique.mockResolvedValueOnce(gitlabServer);
		mockMcpConfigFindFirst.mockResolvedValueOnce(null);

		const result = await checkServerConnection("srv-gl", "user-1", "org-1");

		expect(result.isConnected).toBe(false);
		expect(mockGitLabConnectionStatus).not.toHaveBeenCalled();
	});
});

// A GitLab personal server is connected through the person's one GitLab
// connection, which is OAuth: the prompt must offer the OAuth sign-in even when
// the registry row advertises API_KEY, because a pasted key is never read.
describe("required-connection auth type — GitLab servers are OAuth whatever the registry says", () => {
	const serverRow = (key: string, authMethods: string[]) => ({
		id: `srv-${key}`,
		key,
		name: key,
		description: null,
		authMethods,
		isSystemProvided: true,
		iconUrl: null,
		category: null,
	});

	it.each([
		["gitlab", "OAUTH2"],
		["gitlab-official", "OAUTH2"],
		// Control: any other server keeps the auth type its registry row names.
		["example-server", "API_KEY"],
	])(
		"checkServerConnection: %s advertising only API_KEY asks for %s",
		async (key, expected) => {
			mockMcpServerFindUnique.mockResolvedValueOnce(
				serverRow(key, ["API_KEY"]),
			);
			mockMcpConfigFindFirst.mockResolvedValueOnce(null);

			const result = await checkServerConnection(
				`srv-${key}`,
				"user-1",
				"org-1",
			);

			expect(result.isConnected).toBe(false);
			expect(result.requiredConnection?.authType).toBe(expected);
		},
	);

	it("detectRequiredConnections: a GitLab server advertising only API_KEY asks for OAUTH2", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([
			serverRow("gitlab", ["API_KEY"]),
			serverRow("example-server", ["API_KEY"]),
		]);
		mockMcpConfigFindFirst.mockResolvedValue(null);

		const result = await detectRequiredConnections({
			query: "open a merge request",
			userId: "user-1",
			organizationId: "org-1",
			matchedServerNames: ["gitlab", "example-server"],
		});

		expect(
			Object.fromEntries(
				result.requiredConnections.map((c) => [c.serverId, c.authType]),
			),
		).toEqual({ "srv-gitlab": "OAUTH2", "srv-example-server": "API_KEY" });
	});
});

it("uses the same authorized provider resolution for shared connection discovery", async () => {
	mockIntegrationResolve.mockResolvedValue({ id: "shared-example" });
	const result = await detectMissingIntegrations({
		userId: "actor",
		organizationId: "org-example",
		matchedIntegrations: [
			{
				provider: "GMAIL",
				name: "Gmail",
				capabilities: [],
				confidence: 1,
			},
		],
	});
	expect(result.hasMissingIntegrations).toBe(false);
	expect(mockIntegrationResolve).toHaveBeenCalledWith(
		"GMAIL",
		"actor",
		"org-example",
	);
});

describe("hidden system servers with no connection", () => {
	const serverRow = (key: string, authMethods: string[]) => ({
		id: `srv-${key}`,
		key,
		name: key,
		description: null,
		authMethods,
		isSystemProvided: true,
		iconUrl: null,
		category: null,
	});

	it("skips a hidden system server when it has no connection", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([
			serverRow("brave-search", ["API_KEY"]),
			serverRow("example-server", ["API_KEY"]),
		]);
		mockMcpConfigFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		const result = await detectRequiredConnections({
			query: "search the web",
			userId: "user-1",
			organizationId: "org-1",
			matchedServerNames: ["brave-search", "example-server"],
		});

		expect(result.requiredConnections.map((c) => c.serverId)).toEqual([
			"srv-example-server",
		]);
	});

	it("still reports a hidden system server when its existing connection needs re-authentication", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([
			serverRow("brave-search", ["OAUTH2"]),
		]);
		mockMcpConfigFindFirst.mockResolvedValueOnce({
			id: "cfg-brave",
			authType: "OAUTH2",
			encryptedApiKey: null,
			encryptedAccessToken: "expired-token",
			tokenExpiresAt: null,
			needsReauth: true,
		});

		const result = await detectRequiredConnections({
			query: "search the web",
			userId: "user-1",
			organizationId: "org-1",
			matchedServerNames: ["brave-search"],
		});

		expect(result.requiredConnections.map((c) => c.serverId)).toEqual([
			"srv-brave-search",
		]);
		expect(result.requiredConnections[0]?.reason).toContain(
			"needs to be re-authenticated",
		);
	});

	it("checkServerConnection: returns isConnected: false without requiredConnection for a hidden server with no config", async () => {
		mockMcpServerFindUnique.mockResolvedValueOnce(
			serverRow("brave-search", ["API_KEY"]),
		);
		mockMcpConfigFindFirst.mockResolvedValueOnce(null);

		const result = await checkServerConnection(
			"srv-brave-search",
			"user-1",
			"org-1",
		);

		expect(result).toEqual({ isConnected: false });
	});

	it("checkServerConnection: still returns requiredConnection for a hidden server when its config needs re-authentication", async () => {
		mockMcpServerFindUnique.mockResolvedValueOnce(
			serverRow("brave-search", ["OAUTH2"]),
		);
		mockMcpConfigFindFirst.mockResolvedValueOnce({
			id: "cfg-brave",
			authType: "OAUTH2",
			encryptedApiKey: null,
			encryptedAccessToken: "expired-token",
			tokenExpiresAt: null,
			needsReauth: true,
		});

		const result = await checkServerConnection(
			"srv-brave-search",
			"user-1",
			"org-1",
		);

		expect(result.isConnected).toBe(false);
		expect(result.requiredConnection?.serverId).toBe("srv-brave-search");
		expect(result.requiredConnection?.reason).toContain(
			"needs to be re-authenticated",
		);
	});

	it("searchSystemServersForTask: skips hidden system servers with no config so they do not take top-5 slots", async () => {
		const searchServers = [
			serverRow("brave-search", ["API_KEY"]),
			serverRow("example-search-1", ["API_KEY"]),
			serverRow("example-search-2", ["API_KEY"]),
			serverRow("example-search-3", ["API_KEY"]),
			serverRow("example-search-4", ["API_KEY"]),
			serverRow("example-search-5", ["API_KEY"]),
		].map((s) => ({
			...s,
			name: `${s.key} search`,
			tags: ["search"],
		}));

		mockMcpServerFindMany.mockResolvedValueOnce(searchServers);
		mockMcpConfigFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		const matches = await searchSystemServersForTask(
			"search the web",
			"user-1",
			"org-1",
		);

		expect(matches.some((m) => m.server.key === "brave-search")).toBe(
			false,
		);
		expect(matches).toHaveLength(5);
	});
});
