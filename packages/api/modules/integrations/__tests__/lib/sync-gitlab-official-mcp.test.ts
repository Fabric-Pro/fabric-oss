import { describe, expect, it, vi } from "vitest";
import {
	type SyncTx,
	syncGitlabOfficialMcpConfig,
} from "../../lib/sync-gitlab-official-mcp";

type Row = {
	id: string;
	userId: string | null;
	organizationId: string | null;
	mcpServerId: string;
	oauthClientId: string | null;
	[key: string]: unknown;
};

/**
 * A transaction double that applies the tenant filter, so a row belonging to
 * someone else (or to another context) is invisible the way it is in Prisma.
 */
function buildTx(opts: { serverId?: string | null; rows?: Row[] } = {}) {
	const rows = [...(opts.rows ?? [])];
	const serverId =
		opts.serverId === undefined ? "srv-official" : opts.serverId;
	const matches = (row: Row, where: Record<string, unknown>) =>
		Object.entries(where).every(([key, value]) => row[key] === value);
	const tx = {
		rows,
		mCPServer: {
			findFirst: vi.fn(async () => (serverId ? { id: serverId } : null)),
		},
		mCPConfig: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					rows.find((row) => matches(row, where)) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Row }) => {
				const row = {
					id: `cfg-${rows.length + 1}`,
					oauthClientId: null,
					...data,
				};
				rows.push(row);
				return row;
			}),
			delete: vi.fn(async ({ where }: { where: { id: string } }) => {
				const index = rows.findIndex((row) => row.id === where.id);
				return rows.splice(index, 1)[0];
			}),
		},
	};
	return tx;
}

const official = (extra: Partial<Row> = {}): Row => ({
	id: "cfg-official",
	userId: "u1",
	organizationId: "org-1",
	mcpServerId: "srv-official",
	oauthClientId: null,
	...extra,
});

const tenant = { userId: "u1", organizationId: "org-1" };

describe("syncGitlabOfficialMcpConfig", () => {
	it("creates a tokenless row when capable and none exists", async () => {
		const tx = buildTx();
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: true,
			},
		);
		expect(result).toEqual({ ok: true, action: "created" });
		expect(tx.rows).toHaveLength(1);
		const data = tx.mCPConfig.create.mock.calls[0][0].data as Row;
		expect(data).toMatchObject({
			userId: "u1",
			organizationId: "org-1",
			mcpServerId: "srv-official",
		});
		// The row is a transport record: no token column is ever written.
		for (const column of [
			"encryptedAccessToken",
			"accessTokenHash",
			"encryptedRefreshToken",
			"tokenExpiresAt",
		]) {
			expect(data).not.toHaveProperty(column);
		}
	});

	it("keeps an existing row as it is when capable (no token or breaker write)", async () => {
		const tx = buildTx({
			rows: [official({ oauthClientId: "dcr-client" })],
		});
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: true,
			},
		);
		expect(result).toEqual({ ok: true, action: "kept" });
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
	});

	it("deletes a row with no client registration when the probe says incapable", async () => {
		const tx = buildTx({ rows: [official()] });
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: false,
			},
		);
		expect(result).toEqual({ ok: true, action: "deleted" });
		expect(tx.rows).toHaveLength(0);
	});

	it("never deletes a row holding the client registration that may have issued the credential", async () => {
		const tx = buildTx({
			rows: [official({ oauthClientId: "dcr-client" })],
		});
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: false,
			},
		);
		expect(result).toEqual({ ok: true, action: "kept-registration" });
		expect(tx.mCPConfig.delete).not.toHaveBeenCalled();
		expect(tx.rows).toHaveLength(1);
	});

	it("never deletes the row the connection names as its issuer, even without a registration", async () => {
		const tx = buildTx({ rows: [official()] });
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: false,
				protectedConfigIds: ["cfg-official"],
			},
		);
		expect(result).toEqual({ ok: true, action: "kept-registration" });
		expect(tx.rows).toHaveLength(1);
	});

	it("is a no-op when incapable and none exists", async () => {
		const tx = buildTx();
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: false,
			},
		);
		expect(result).toEqual({ ok: true, action: "noop" });
	});

	it("only ever touches the caller's own row in this context (exclusive tenant filter)", async () => {
		const tx = buildTx({
			rows: [
				official({ id: "cfg-personal", organizationId: null }),
				official({ id: "cfg-teammate", userId: "u2" }),
			],
		});
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: false,
			},
		);
		expect(result).toEqual({ ok: true, action: "noop" });
		expect(tx.rows.map((row) => row.id)).toEqual([
			"cfg-personal",
			"cfg-teammate",
		]);
		expect(tx.mCPConfig.findFirst.mock.calls[0][0].where).toEqual({
			userId: "u1",
			organizationId: "org-1",
			mcpServerId: "srv-official",
		});
	});

	it("reports server-not-seeded when the gitlab-official MCPServer row is missing", async () => {
		const tx = buildTx({ serverId: null });
		const result = await syncGitlabOfficialMcpConfig(
			tx as unknown as SyncTx,
			{
				...tenant,
				capable: true,
			},
		);
		expect(result).toEqual({ ok: false, reason: "server-not-seeded" });
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
	});
});
