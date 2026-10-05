/**
 * The one-off adoption of legacy `gitlab-official` MCP token copies, which
 * only `packages/api/scripts/backfill-gitlab-connections.ts` runs (no request
 * or worker path reaches it). Against the same in-memory database and real
 * per-key lock as the connection service's own tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitLabFakeDb,
	encryptedCredential,
	readCredential,
} from "./helpers/gitlab-fake-db";

const state = vi.hoisted(() => ({
	fake: null as unknown as ReturnType<
		typeof import("./helpers/gitlab-fake-db").createGitLabFakeDb
	>,
}));

vi.mock("@repo/database", () => ({
	get db() {
		return state.fake.db;
	},
}));

vi.mock("@repo/database/prisma/queries/lib/refresh-lock", () => ({
	withRefreshLock: (
		keys: string | readonly string[],
		fn: (
			tx: unknown,
			assertBudget: (ms: number) => void,
		) => Promise<unknown>,
	) => state.fake.withLock(keys, fn as never),
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const helpers = await import("./helpers/gitlab-fake-db");
	return {
		...(await importOriginal<object>()),
		decryptApiKey: helpers.fakeDecrypt,
		encryptApiKey: helpers.fakeEncrypt,
	};
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
	adoptGitLabConnection,
	adoptionFailureReason,
} from "../../src/gitlab/connection-legacy-adoption";
import {
	connectGitLab,
	getGitLabAccessToken,
	resetGitLabConnectionDepsForTests,
} from "../../src/gitlab/index";

const USER = "user-1";
const ORG = "org-1";
const HOUR = 60 * 60 * 1000;
const tenant = { userId: USER, organizationId: ORG };

const officialServer = {
	id: "srv-official",
	key: "gitlab-official",
	defaultUrl: "https://gitlab.com/api/v4/mcp",
};

const legacyServer = {
	id: "srv-gitlab",
	key: "gitlab",
	// Fabric's former in-process shim, not a GitLab instance.
	defaultUrl: "https://app.example.com/api/mcp/gitlab",
};

/** A config holding a personal access token as its API key, no OAuth copy. */
function apiKeyRow(extra: Record<string, unknown> = {}) {
	return officialRow({
		id: "cfg-gitlab",
		mcpServerId: legacyServer.id,
		oauthClientId: null,
		dcrClientMetadata: null,
		encryptedAccessToken: null,
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
		authType: "API_KEY",
		encryptedApiKey: "enc:glpat-saved-on-config",
		...extra,
	});
}

/** An active personal connection row without an issuer. */
function issuerlessRow(credential: Record<string, unknown>) {
	return {
		id: "wi-1",
		userId: USER,
		organizationId: ORG,
		provider: "GITLAB",
		name: "GitLab",
		workflowId: null,
		credentials: encryptedCredential(credential),
		settings: {},
		isActive: true,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	};
}

function officialRow(extra: Record<string, unknown> = {}) {
	return {
		id: "cfg-official",
		userId: USER,
		organizationId: ORG,
		mcpServerId: officialServer.id,
		baseUrl: null,
		oauthClientId: "dcr-client",
		encryptedOauthClientSecret: null,
		dcrClientMetadata: { token_endpoint_auth_method: "none" },
		encryptedAccessToken: "enc:mcp-access",
		encryptedRefreshToken: "enc:mcp-refresh",
		tokenExpiresAt: new Date(Date.now() + HOUR),
		needsReauth: false,
		enabled: true,
		authType: "OAUTH2",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-02-01T00:00:00Z"),
		...extra,
	};
}

beforeEach(() => {
	fetchMock.mockReset();
	resetGitLabConnectionDepsForTests();
	vi.stubEnv("GITLAB_CLIENT_ID", "app-client");
	vi.stubEnv("GITLAB_CLIENT_SECRET", "app-secret");
});

describe("adoptGitLabConnection (backfill only)", () => {
	it("adopts production's DCR copy, with its registration as the issuer, exactly once under concurrency", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialRow()],
		});

		const results = await Promise.all([
			adoptGitLabConnection(tenant),
			adoptGitLabConnection(tenant),
			adoptGitLabConnection(tenant),
		]);

		expect(results.filter((each) => each.applied)).toHaveLength(1);
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(readCredential(rows[0])).toMatchObject({
			access_token: "mcp-access",
			refresh_token: "mcp-refresh",
			connectionGeneration: 1,
			issuer: {
				kind: "mcp-dcr",
				mcpConfigId: "cfg-official",
				serverKey: "gitlab-official",
				clientId: "dcr-client",
				origin: "https://gitlab.com",
			},
		});
		// Evidence only: adoption never tried a refresh, and it never wrote
		// the copy.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.fake.tables.mCPConfig[0].encryptedAccessToken).toBe(
			"enc:mcp-access",
		);
		expect(await getGitLabAccessToken(USER, ORG)).toBe("mcp-access");
	});

	it("a dry run reports the plan and writes nothing", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialRow()],
		});

		const result = await adoptGitLabConnection(tenant, undefined, {
			dryRun: true,
		});

		expect(result).toEqual({
			plan: {
				action: "adopt-mcp",
				targetRowId: null,
				mcpConfigId: "cfg-official",
			},
			applied: false,
		});
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("does not resurrect a connection the person disconnected", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			// An old worker rotated the MCP copy after the disconnect.
			mCPConfig: [
				officialRow({ updatedAt: new Date("2026-03-01T00:00:00Z") }),
			],
			workflowIntegration: [
				{
					id: "wi-1",
					userId: USER,
					organizationId: ORG,
					provider: "GITLAB",
					name: "GitLab",
					workflowId: null,
					credentials: encryptedCredential({
						connectionGeneration: 3,
						disconnectedAt: "2026-02-15T00:00:00Z",
					}),
					settings: {},
					isActive: false,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-02-15T00:00:00Z"),
				},
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.applied).toBe(false);
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.isActive).toBe(false);
		expect(readCredential(row).access_token).toBeUndefined();
	});

	it("classifies an existing row without an issuer the way the service does", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				{
					id: "wi-1",
					userId: USER,
					organizationId: ORG,
					provider: "GITLAB",
					name: "GitLab",
					workflowId: null,
					credentials: encryptedCredential({
						GITLAB_ACCESS_TOKEN: "legacy-pat",
					}),
					settings: {},
					isActive: true,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					updatedAt: new Date("2026-01-01T00:00:00Z"),
				},
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result).toMatchObject({
			applied: true,
			plan: { action: "classify", issuer: { kind: "pat" } },
		});
		expect(
			readCredential(state.fake.tables.workflowIntegration[0]).issuer,
		).toEqual({ kind: "pat", origin: "https://gitlab.com" });
	});
});

describe("adoptGitLabConnection — an API key saved on a GitLab MCP config", () => {
	it("connects a gitlab config's key as a gitlab.com PAT when the config names no address", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [legacyServer],
			mCPConfig: [apiKeyRow()],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result).toMatchObject({
			applied: true,
			plan: {
				action: "adopt-pat",
				mcpConfigId: "cfg-gitlab",
				origin: "https://gitlab.com",
			},
		});
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(readCredential(rows[0])).toMatchObject({
			access_token: "glpat-saved-on-config",
			issuer: { kind: "pat", origin: "https://gitlab.com" },
		});
		expect(rows[0].settings).toMatchObject({
			adoptedFromMcpConfigId: "cfg-gitlab",
		});
		// Evidence only: nothing was sent to GitLab, and the copy is left for
		// the migration.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.fake.tables.mCPConfig[0].encryptedApiKey).toBe(
			"enc:glpat-saved-on-config",
		);
		expect(await getGitLabAccessToken(USER, ORG)).toBe(
			"glpat-saved-on-config",
		);
	});

	it("connects a gitlab-official config's key on the self-hosted instance its address names", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				apiKeyRow({
					id: "cfg-official",
					mcpServerId: officialServer.id,
					baseUrl: "https://gitlab.example.com/api/v4/mcp",
				}),
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.applied).toBe(true);
		expect(
			readCredential(state.fake.tables.workflowIntegration[0]).issuer,
		).toEqual({ kind: "pat", origin: "https://gitlab.example.com" });
	});

	it("adopts nothing from a config whose address is refused", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [legacyServer],
			mCPConfig: [apiKeyRow({ baseUrl: "https://127.0.0.1/api/v4" })],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result).toEqual({
			plan: { action: "none", reason: "no connection and no MCP copy" },
			applied: false,
		});
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("prefers the gitlab-official DCR copy over an API key", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer, legacyServer],
			mCPConfig: [officialRow(), apiKeyRow()],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.plan.action).toBe("adopt-mcp");
		expect(
			readCredential(state.fake.tables.workflowIntegration[0]),
		).toMatchObject({
			access_token: "mcp-access",
			issuer: { kind: "mcp-dcr" },
		});
	});

	it("does not resurrect a connection the person disconnected", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [legacyServer],
			mCPConfig: [apiKeyRow()],
			workflowIntegration: [
				{
					...issuerlessRow({
						connectionGeneration: 3,
						disconnectedAt: "2026-02-15T00:00:00Z",
					}),
					isActive: false,
				},
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.applied).toBe(false);
		const row = state.fake.tables.workflowIntegration[0];
		expect(row.isActive).toBe(false);
		expect(readCredential(row).access_token).toBeUndefined();
	});

	it("a dry run reports the PAT plan and writes nothing", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [legacyServer],
			mCPConfig: [apiKeyRow()],
		});

		const result = await adoptGitLabConnection(tenant, undefined, {
			dryRun: true,
		});

		expect(result).toEqual({
			plan: {
				action: "adopt-pat",
				targetRowId: null,
				mcpConfigId: "cfg-gitlab",
				origin: "https://gitlab.com",
				expectedGeneration: 0,
			},
			applied: false,
		});
		expect(state.fake.tables.workflowIntegration).toHaveLength(0);
	});

	it("drops the PAT when the person connects GitLab after the plan was made", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [legacyServer],
			mCPConfig: [apiKeyRow()],
		});
		// The person connects GitLab themselves between the plan and the
		// write: the adoption, planned against generation 0, must not
		// overwrite that connection.
		// The adoption reads the API key copies twice outside the lock: once
		// to plan, once right before the write. The connect lands between.
		const findMany = state.fake.db.mCPConfig.findMany;
		let apiKeyReads = 0;
		let connectedDuringPlan = false;
		state.fake.db.mCPConfig.findMany = (async (...args: unknown[]) => {
			const where = (
				args[0] as { where?: { mcpServer?: { key?: unknown } } }
			)?.where;
			const readsApiKeyCopies =
				typeof where?.mcpServer?.key === "object" &&
				where.mcpServer.key !== null &&
				"in" in where.mcpServer.key;
			if (readsApiKeyCopies) {
				apiKeyReads += 1;
			}
			if (readsApiKeyCopies && apiKeyReads === 2) {
				connectedDuringPlan = true;
				await connectGitLab(tenant, {
					accessToken: "freshly-entered-pat",
					refreshToken: null,
					expiresAt: null,
					scopes: [],
					issuer: { kind: "pat", origin: "https://gitlab.com" },
				});
			}
			return (findMany as (...a: unknown[]) => Promise<unknown>)(...args);
		}) as typeof findMany;

		const result = await adoptGitLabConnection(tenant);

		// Planned before the connect landed, and dropped at the write.
		expect(connectedDuringPlan).toBe(true);
		expect(result.plan).toMatchObject({
			action: "adopt-pat",
			expectedGeneration: 0,
		});
		expect(result.applied).toBe(false);
		const rows = state.fake.tables.workflowIntegration;
		expect(rows).toHaveLength(1);
		expect(readCredential(rows[0]).access_token).toBe(
			"freshly-entered-pat",
		);
	});
});

describe("adoptGitLabConnection — a grant shared with the gitlab-official registration", () => {
	// GITLAB_CLIENT_ID is configured (beforeEach), so the service alone would
	// call a refreshable issuer-less grant the integration app's.
	it.each([
		[
			"its access token",
			{ access_token: "mcp-access", refresh_token: "row-refresh" },
		],
		[
			"its refresh token",
			{ access_token: "row-access", refresh_token: "mcp-refresh" },
		],
	])(
		"marks an issuer-less row sharing %s with the DCR copy reconnect-required, never the app's",
		async (_label, credential) => {
			state.fake = createGitLabFakeDb({
				mCPServer: [officialServer],
				mCPConfig: [officialRow()],
				workflowIntegration: [issuerlessRow(credential)],
			});

			const result = await adoptGitLabConnection(tenant);

			expect(result.plan).toEqual({
				action: "reconnect-required",
				rowId: "wi-1",
				reason: "shared-with-mcp-registration",
			});
			const stored = readCredential(
				state.fake.tables.workflowIntegration[0],
			);
			expect(stored.issuer?.kind).not.toBe("app");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("still classifies an issuer-less grant the copy does not share as the app's (control)", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [officialRow()],
			workflowIntegration: [
				issuerlessRow({
					access_token: "row-access",
					refresh_token: "row-refresh",
				}),
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.plan).toMatchObject({
			action: "classify",
			issuer: { kind: "app" },
		});
	});
});

// A person can own several gitlab-official configs. The evidence (a
// registration, a token copy, a shared grant) may be on any of them, never
// only on whichever a query happens to return first: the decoy below is
// inserted first, so an unordered single-row read returns it.
describe("adoptGitLabConnection — several gitlab-official configs", () => {
	/** A gitlab-official config with no registration and no token copy. */
	const emptyDecoy = officialRow({
		id: "cfg-official-a-decoy",
		oauthClientId: null,
		dcrClientMetadata: null,
		encryptedAccessToken: null,
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
	});

	it.each([
		[
			"its access token",
			{ access_token: "mcp-access", refresh_token: "row-refresh" },
		],
		[
			"its refresh token",
			{ access_token: "row-access", refresh_token: "mcp-refresh" },
		],
	])(
		"finds a grant shared with the second config's registration through %s, past an empty decoy",
		async (_label, credential) => {
			state.fake = createGitLabFakeDb({
				mCPServer: [officialServer],
				mCPConfig: [
					emptyDecoy,
					officialRow({ id: "cfg-official-b-registered" }),
				],
				workflowIntegration: [issuerlessRow(credential)],
			});

			const result = await adoptGitLabConnection(tenant);

			expect(result.plan).toEqual({
				action: "reconnect-required",
				rowId: "wi-1",
				reason: "shared-with-mcp-registration",
			});
		},
	);

	it("finds a grant shared with the second config past a decoy holding another registration's grant", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialRow({
					id: "cfg-official-a-other",
					oauthClientId: "other-client",
					encryptedAccessToken: "enc:other-access",
					encryptedRefreshToken: "enc:other-refresh",
				}),
				officialRow({ id: "cfg-official-b-registered" }),
			],
			workflowIntegration: [
				issuerlessRow({
					access_token: "mcp-access",
					refresh_token: "row-refresh",
				}),
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.plan).toMatchObject({
			action: "reconnect-required",
			reason: "shared-with-mcp-registration",
		});
	});

	it("adopts the registered copy past an empty decoy", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				emptyDecoy,
				officialRow({ id: "cfg-official-b-registered" }),
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result).toMatchObject({
			applied: true,
			plan: {
				action: "adopt-mcp",
				mcpConfigId: "cfg-official-b-registered",
			},
		});
		expect(
			readCredential(state.fake.tables.workflowIntegration[0]),
		).toMatchObject({
			access_token: "mcp-access",
			issuer: {
				kind: "mcp-dcr",
				mcpConfigId: "cfg-official-b-registered",
				clientId: "dcr-client",
			},
		});
	});

	it("adopts the most recently updated of two adoptable copies, whichever is read first", async () => {
		state.fake = createGitLabFakeDb({
			mCPServer: [officialServer],
			mCPConfig: [
				officialRow({
					id: "cfg-official-a-older",
					oauthClientId: "older-client",
					encryptedAccessToken: "enc:older-access",
					updatedAt: new Date("2026-01-15T00:00:00Z"),
				}),
				officialRow({
					id: "cfg-official-b-newer",
					oauthClientId: "newer-client",
					encryptedAccessToken: "enc:newer-access",
					updatedAt: new Date("2026-03-01T00:00:00Z"),
				}),
			],
		});

		const result = await adoptGitLabConnection(tenant);

		expect(result.plan).toMatchObject({
			action: "adopt-mcp",
			mcpConfigId: "cfg-official-b-newer",
		});
		expect(
			readCredential(state.fake.tables.workflowIntegration[0]),
		).toMatchObject({
			access_token: "newer-access",
			issuer: { clientId: "newer-client" },
		});
	});
});

describe("adoptionFailureReason — what the backfill counts as a failure", () => {
	it("fails a pair whose connection credential cannot be decrypted, dry run included", async () => {
		state.fake = createGitLabFakeDb({
			workflowIntegration: [
				{
					...issuerlessRow({ access_token: "x" }),
					credentials: "not-fake-ciphertext",
				},
			],
		});

		for (const dryRun of [true, false]) {
			const result = await adoptGitLabConnection(tenant, undefined, {
				dryRun,
			});
			expect(result.plan).toEqual({
				action: "none",
				reason: "stored credential unreadable",
			});
			expect(adoptionFailureReason(result, { dryRun })).toMatch(
				/unreadable/,
			);
		}
	});

	it("fails a real run whose plan was not written, but not a dry run", () => {
		const result = {
			plan: {
				action: "adopt-pat" as const,
				targetRowId: null,
				mcpConfigId: "cfg-gitlab",
				origin: "https://gitlab.com",
				expectedGeneration: 0,
			},
			applied: false,
		};
		expect(adoptionFailureReason(result, { dryRun: false })).toMatch(
			/rerun/,
		);
		expect(adoptionFailureReason(result, { dryRun: true })).toBeNull();
	});

	it("does not fail settled outcomes", () => {
		for (const reason of [
			"already awaiting reconnect",
			"disconnected by the user",
			"already has an issuer",
			"no connection and no MCP copy",
		]) {
			expect(
				adoptionFailureReason(
					{ plan: { action: "none", reason }, applied: false },
					{ dryRun: false },
				),
			).toBeNull();
		}
	});
});
