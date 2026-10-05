/**
 * `recheckGitlabCapabilities` re-probes the person's GitLab connection against
 * GitLab's official MCP server and records the answer through the connection
 * service's fenced settings write. The service is a double here (its own
 * tests live in `@repo/integrations`); these tests pin what the recheck asks
 * of it and what it does in the same transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const getGitLabConnectionTokenMock = vi.fn();
const patchGitLabConnectionSettingsMock = vi.fn();
vi.mock("@repo/integrations/gitlab", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabConnectionToken: (...args: unknown[]) =>
		getGitLabConnectionTokenMock(...args),
	patchGitLabConnectionSettings: (...args: unknown[]) =>
		patchGitLabConnectionSettingsMock(...args),
}));

import { GitLabReauthRequiredError } from "@repo/integrations/gitlab";
import {
	GitLabIntegrationNotConnectedError,
	recheckGitlabCapabilities,
} from "../../lib/gitlab-recheck";

function buildTx(configs: Row[] = []) {
	const rows = [...configs];
	const matches = (row: Row, where: Record<string, unknown>) =>
		Object.entries(where).every(([key, value]) => row[key] === value);
	return {
		rows,
		mCPServer: { findFirst: vi.fn(async () => ({ id: "srv-official" })) },
		mCPConfig: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					rows.find((row) => matches(row, where)) ?? null,
			),
			create: vi.fn(
				async ({ data }: { data: Record<string, unknown> }) => {
					const row = { id: `cfg-${rows.length + 1}`, ...data };
					rows.push(row);
					return row;
				},
			),
			delete: vi.fn(async ({ where }: { where: { id: string } }) => {
				const index = rows.findIndex((row) => row.id === where.id);
				return rows.splice(index, 1)[0];
			}),
		},
	};
}

let tx: ReturnType<typeof buildTx>;

function token(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		accessToken: "connection-token",
		issuer: {
			kind: "app",
			clientId: "app-client",
			origin: "https://gitlab.com",
		},
		origin: "https://gitlab.com",
		integrationId: "wi-1",
		generation: 4,
		settings: {},
		...overrides,
	};
}

const probe = (status: string, capable: boolean, httpStatus = 200) =>
	vi.fn(async () => ({ status, capable, httpStatus }));

const input = { userId: "u1", organizationId: "org-1" };

beforeEach(() => {
	getGitLabConnectionTokenMock.mockReset();
	patchGitLabConnectionSettingsMock.mockReset();
	tx = buildTx();
	patchGitLabConnectionSettingsMock.mockImplementation(
		async (
			_tenant: unknown,
			args: { alsoInTransaction?: (tx: unknown) => Promise<void> },
		) => {
			await args.alsoInTransaction?.(tx);
			return true;
		},
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recheckGitlabCapabilities", () => {
	it("throws not-connected when the person has no GitLab connection", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue({
			ok: false,
			reason: "not-connected",
			message: "GitLab is not connected",
		});
		await expect(
			recheckGitlabCapabilities({ input, probe: probe("ok", true) }),
		).rejects.toBeInstanceOf(GitLabIntegrationNotConnectedError);
		expect(patchGitLabConnectionSettingsMock).not.toHaveBeenCalled();
	});

	it("throws reauth-required, without probing, when the connection needs reconnecting", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue({
			ok: false,
			reason: "needs-reauth",
			message: "the GitLab connection needs to be reconnected",
		});
		const probeFn = probe("ok", true);
		await expect(
			recheckGitlabCapabilities({ input, probe: probeFn }),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
		expect(probeFn).not.toHaveBeenCalled();
	});

	it("probes the credential's own origin with the connection's (strictly fresh) token", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue(
			token({ origin: "https://gitlab.example.com" }),
		);
		const probeFn = probe("ok", true);
		await recheckGitlabCapabilities({ input, probe: probeFn });

		expect(getGitLabConnectionTokenMock).toHaveBeenCalledWith(
			{ userId: "u1", organizationId: "org-1" },
			{ mode: "strict", anyOrigin: true },
			undefined,
		);
		expect(probeFn).toHaveBeenCalledWith({
			baseUrl: "https://gitlab.example.com",
			accessToken: "connection-token",
		});
	});

	it("records a capable result fenced on the generation the token came from, and creates the official row", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue(token());
		const result = await recheckGitlabCapabilities({
			input,
			probe: probe("ok", true),
		});

		expect(result.useOfficialMcp).toBe(true);
		const [tenant, args] = patchGitLabConnectionSettingsMock.mock.calls[0];
		expect(tenant).toEqual({ userId: "u1", organizationId: "org-1" });
		expect(args).toMatchObject({
			expectedGeneration: 4,
			patch: {
				useOfficialMcp: true,
				mcpProbe: { status: "ok", baseUrl: "https://gitlab.com" },
			},
		});
		expect(tx.rows).toHaveLength(1);
		expect(tx.rows[0]).not.toHaveProperty("encryptedAccessToken");
	});

	it("keeps the previous flag and touches no MCP row on a non-authoritative probe", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue(
			token({ settings: { useOfficialMcp: true } }),
		);
		tx = buildTx([
			{
				id: "cfg-official",
				userId: "u1",
				organizationId: "org-1",
				mcpServerId: "srv-official",
				oauthClientId: null,
			},
		]);
		const result = await recheckGitlabCapabilities({
			input,
			probe: probe("network-error", false, 0),
		});
		expect(result.useOfficialMcp).toBe(true);
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
	});

	it("never deletes the official row holding the registration that issued the credential", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue(
			token({
				issuer: {
					kind: "mcp-dcr",
					mcpConfigId: "cfg-official",
					serverKey: "gitlab-official",
					clientId: "dcr-client",
					origin: "https://gitlab.com",
				},
			}),
		);
		tx = buildTx([
			{
				id: "cfg-official",
				userId: "u1",
				organizationId: "org-1",
				mcpServerId: "srv-official",
				oauthClientId: "dcr-client",
			},
		]);

		const result = await recheckGitlabCapabilities({
			input,
			probe: probe("not-found", false, 404),
		});

		expect(result.useOfficialMcp).toBe(false);
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.rows).toHaveLength(1);
	});

	it("drops its result (and says so) when the connection moved during the probe", async () => {
		getGitLabConnectionTokenMock.mockResolvedValue(token());
		patchGitLabConnectionSettingsMock.mockResolvedValue(false);

		await recheckGitlabCapabilities({ input, probe: probe("ok", true) });

		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("result not recorded"),
			expect.anything(),
		);
	});
});
