/**
 * `persistGitLabToken` is the API-layer composition around the GitLab
 * connection service's `connectGitLab`: probe the issuer's origin, write the
 * connection (with the capability result) and, in the same transaction, the
 * `gitlab` registry row and the `gitlab-official` capability sync.
 *
 * The connection write itself — encryption, issuer, generation fence, the
 * lifecycle lock — is the service's and is tested in `@repo/integrations`.
 * Here `connectGitLab` is a double that records its input and runs the
 * caller's in-transaction step against an in-memory transaction, so these
 * tests pin what this module adds: what it asks the service to write, and
 * that nothing it writes puts a token on an MCPConfig.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const connectGitLabMock = vi.fn();
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	connectGitLab: (...args: unknown[]) => connectGitLabMock(...args),
}));

import {
	ensureGitLabRegistryRow,
	persistGitLabToken,
} from "../../lib/gitlab-token";

/** An in-memory transaction that applies flat `where` filters. */
function buildTx(seed: { servers?: Row[]; configs?: Row[] } = {}) {
	const servers = seed.servers ?? [
		{ id: "srv-gitlab", key: "gitlab", isSystemProvided: true },
		{ id: "srv-official", key: "gitlab-official", isSystemProvided: true },
	];
	const configs = [...(seed.configs ?? [])];
	const matches = (row: Row, where: Record<string, unknown>) =>
		Object.entries(where).every(([key, value]) => row[key] === value);
	return {
		configs,
		mCPServer: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					servers.find((row) => matches(row, where)) ?? null,
			),
		},
		mCPConfig: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					configs.find((row) => matches(row, where)) ?? null,
			),
			create: vi.fn(
				async ({ data }: { data: Record<string, unknown> }) => {
					const row = {
						id: `cfg-${configs.length + 1}`,
						oauthClientId: null,
						...data,
					};
					configs.push(row);
					return row;
				},
			),
			delete: vi.fn(async ({ where }: { where: { id: string } }) => {
				const index = configs.findIndex((row) => row.id === where.id);
				return configs.splice(index, 1)[0];
			}),
		},
	};
}

let tx: ReturnType<typeof buildTx>;

function connectRunsInTransaction(
	result: Record<string, unknown> = {
		written: true,
		integrationId: "wi-1",
		generation: 3,
	},
) {
	connectGitLabMock.mockImplementation(
		async (
			_tenant: unknown,
			input: {
				alsoInTransaction?: (
					tx: unknown,
					written: { integrationId: string; generation: number },
				) => Promise<void>;
			},
		) => {
			if (result.written) {
				await input.alsoInTransaction?.(tx, {
					integrationId: "wi-1",
					generation: 3,
				});
			}
			return result;
		},
	);
}

const probe = (status: string, capable: boolean, httpStatus = 200) =>
	vi.fn(async () => ({ status, capable, httpStatus }));

const APP_ISSUER = {
	kind: "app" as const,
	clientId: "app-client",
	origin: "https://gitlab.com",
};

function input(overrides: Record<string, unknown> = {}) {
	return {
		userId: "u1",
		organizationId: "org-1",
		token: {
			accessToken: "access-1",
			refreshToken: "refresh-1",
			expiresAt: new Date("2026-10-02T12:00:00Z"),
			scopes: ["api"],
		},
		gitlabUser: {
			id: 42,
			username: "dev",
			name: "Dev Example",
			avatarUrl: null,
		},
		issuer: APP_ISSUER,
		freshGrant: true,
		...overrides,
	} as Parameters<typeof persistGitLabToken>[0];
}

const TOKEN_COLUMNS = [
	"encryptedAccessToken",
	"accessTokenHash",
	"encryptedRefreshToken",
	"tokenExpiresAt",
];

beforeEach(() => {
	connectGitLabMock.mockReset();
	tx = buildTx();
	connectRunsInTransaction();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("persistGitLabToken", () => {
	it("hands the connection service the token, its issuer, the fence and the probe result", async () => {
		const result = await persistGitLabToken(
			input({ expectedGeneration: 2 }),
			{ probe: probe("ok", true) },
		);

		expect(result).toEqual({
			written: true,
			workflowIntegrationId: "wi-1",
			generation: 3,
		});
		const [tenant, written] = connectGitLabMock.mock.calls[0];
		expect(tenant).toEqual({ userId: "u1", organizationId: "org-1" });
		expect(written).toMatchObject({
			accessToken: "access-1",
			refreshToken: "refresh-1",
			scopes: ["api"],
			issuer: APP_ISSUER,
			account: { id: 42, username: "dev" },
			freshGrant: true,
			expectedGeneration: 2,
			settingsPatch: {
				useOfficialMcp: true,
				mcpProbe: {
					status: "ok",
					httpStatus: 200,
					baseUrl: "https://gitlab.com",
				},
			},
		});
	});

	it("probes the GitLab instance that issued the token", async () => {
		const probeFn = probe("ok", true);
		await persistGitLabToken(
			input({
				issuer: {
					kind: "app",
					clientId: "app-client",
					origin: "https://gitlab.example.com",
				},
			}),
			{ probe: probeFn },
		);
		expect(probeFn).toHaveBeenCalledWith({
			baseUrl: "https://gitlab.example.com",
			accessToken: "access-1",
		});
	});

	it("reports a fenced-out write as stale and runs none of its in-transaction writes", async () => {
		connectRunsInTransaction({
			written: false,
			reason: "stale",
			generation: 5,
		});
		const result = await persistGitLabToken(
			input({ expectedGeneration: 2 }),
			{
				probe: probe("ok", true),
			},
		);
		expect(result).toEqual({ written: false, reason: "stale" });
		expect(tx.configs).toHaveLength(0);
	});

	it("creates the gitlab registry row and the gitlab-official row without any token on either", async () => {
		await persistGitLabToken(input(), { probe: probe("ok", true) });

		expect(tx.configs.map((row) => row.mcpServerId).sort()).toEqual([
			"srv-gitlab",
			"srv-official",
		]);
		for (const row of tx.configs) {
			expect(row).toMatchObject({
				userId: "u1",
				organizationId: "org-1",
			});
			for (const column of TOKEN_COLUMNS) {
				expect(row).not.toHaveProperty(column);
			}
		}
	});

	it("leaves the capability flag and the official row alone on a non-authoritative probe", async () => {
		tx = buildTx({
			configs: [
				{
					id: "cfg-official",
					userId: "u1",
					organizationId: "org-1",
					mcpServerId: "srv-official",
					oauthClientId: null,
				},
			],
		});
		await persistGitLabToken(input(), {
			probe: probe("network-error", false, 0),
		});

		const written = connectGitLabMock.mock.calls[0][1];
		expect(written.settingsPatch).not.toHaveProperty("useOfficialMcp");
		expect(written.settingsPatch.mcpProbe).toMatchObject({
			status: "network-error",
		});
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
	});

	it("an incapable probe never deletes the registration that issued the credential", async () => {
		tx = buildTx({
			configs: [
				{
					id: "cfg-official",
					userId: "u1",
					organizationId: "org-1",
					mcpServerId: "srv-official",
					oauthClientId: null,
				},
			],
		});
		await persistGitLabToken(
			input({
				issuer: {
					kind: "mcp-dcr",
					mcpConfigId: "cfg-official",
					serverKey: "gitlab-official",
					clientId: "dcr-client",
					origin: "https://gitlab.com",
				},
			}),
			{ probe: probe("not-found", false, 404) },
		);

		expect(
			connectGitLabMock.mock.calls[0][1].settingsPatch.useOfficialMcp,
		).toBe(false);
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.configs.some((row) => row.id === "cfg-official")).toBe(true);
	});

	it("an incapable probe removes a plain official row the credential does not depend on", async () => {
		tx = buildTx({
			configs: [
				{
					id: "cfg-official",
					userId: "u1",
					organizationId: "org-1",
					mcpServerId: "srv-official",
					oauthClientId: null,
				},
			],
		});
		await persistGitLabToken(input(), {
			probe: probe("not-found", false, 404),
		});
		expect(tx.mCPConfig.delete).toHaveBeenCalledWith({
			where: { id: "cfg-official" },
		});
	});
});

describe("ensureGitLabRegistryRow", () => {
	it("creates the row once and never duplicates it", async () => {
		await ensureGitLabRegistryRow(tx as never, {
			userId: "u1",
			organizationId: "org-1",
		});
		await ensureGitLabRegistryRow(tx as never, {
			userId: "u1",
			organizationId: "org-1",
		});
		expect(tx.configs).toHaveLength(1);
		expect(tx.configs[0]).toMatchObject({
			mcpServerId: "srv-gitlab",
			authType: "OAUTH2",
			needsReauth: false,
		});
	});

	it("scopes the lookup exclusively to the tenant context", async () => {
		tx = buildTx({
			configs: [
				{
					id: "cfg-personal",
					userId: "u1",
					organizationId: null,
					mcpServerId: "srv-gitlab",
				},
			],
		});
		await ensureGitLabRegistryRow(tx as never, {
			userId: "u1",
			organizationId: "org-1",
		});
		expect(tx.configs).toHaveLength(2);
		expect(tx.mCPConfig.findFirst.mock.calls[0][0].where).toEqual({
			userId: "u1",
			organizationId: "org-1",
			mcpServerId: "srv-gitlab",
		});

		await ensureGitLabRegistryRow(tx as never, {
			userId: "u1",
			organizationId: null,
		});
		expect(tx.configs).toHaveLength(2);
	});

	it("skips (and logs) when the gitlab catalog row is not seeded", async () => {
		tx = buildTx({ servers: [] });
		await ensureGitLabRegistryRow(tx as never, {
			userId: "u1",
			organizationId: "org-1",
		});
		expect(tx.configs).toHaveLength(0);
		expect(console.error).toHaveBeenCalled();
	});
});
