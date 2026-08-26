/**
 * Unit tests for the 2026-05-19 Atlassian MCPConfig fixup script.
 *
 * Pins the filter and clear semantics for the operator-run cleanup that
 * accompanies the OAuth fix. AC-4, AC-8, AC-9 in `requirements.md`. Design
 * doc: `docs/superpowers/specs/2026-05-19-atlassian-mcp-oauth-fix-design.md`
 * §5.3.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, updateManyMock, deleteManyMock, disconnectMock } =
	vi.hoisted(() => ({
		findManyMock: vi.fn(),
		updateManyMock: vi.fn(),
		deleteManyMock: vi.fn(),
		disconnectMock: vi.fn(),
	}));

// Mock the Prisma generated client so we can assert on `Prisma.DbNull`
// sentinel usage without pulling the real generated bundle in.
vi.mock("../../prisma/generated/client", () => ({
	Prisma: {
		DbNull: { __dbNull: true },
	},
}));

vi.mock("../../prisma/client", () => ({
	db: {
		mCPConfig: {
			findMany: (...args: unknown[]) => findManyMock(...args),
			updateMany: (...args: unknown[]) => updateManyMock(...args),
		},
		mCPOAuthState: {
			deleteMany: (...args: unknown[]) => deleteManyMock(...args),
		},
		$disconnect: (...args: unknown[]) => disconnectMock(...args),
	},
}));

import { runFixAtlassianMcpConfigs } from "../../scripts/2026-05-19-fix-atlassian-mcp-configs";

const FIXTURE_CANDIDATES = [
	{
		id: "cfg-1",
		userId: "user-1",
		organizationId: null,
		baseUrl: "https://mcp.atlassian.com/v1/sse",
		oauthClientId: "stale-client-id-1",
	},
	{
		id: "cfg-2",
		userId: null,
		organizationId: "org-1",
		baseUrl: "https://mcp.atlassian.com/v1/sse",
		oauthClientId: "stale-client-id-2",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	findManyMock.mockResolvedValue(FIXTURE_CANDIDATES);
	// Default: every update succeeds (count=1).
	updateManyMock.mockResolvedValue({ count: 1 });
	deleteManyMock.mockResolvedValue({ count: 0 });
});

describe("runFixAtlassianMcpConfigs", () => {
	it("filters strictly to mcpServer.key === 'atlassian' (AC-9)", async () => {
		await runFixAtlassianMcpConfigs({ dryRun: false });
		const whereArg = findManyMock.mock.calls[0]?.[0] as {
			where: { mcpServer: { key: string } };
		};
		expect(whereArg.where.mcpServer).toEqual({ key: "atlassian" });
	});

	it("OR-clause matches only pre-fix shapes (safe to re-run after re-OAuth)", async () => {
		await runFixAtlassianMcpConfigs({ dryRun: false });
		const whereArg = findManyMock.mock.calls[0]?.[0] as {
			where: {
				OR: Array<Record<string, unknown>>;
			};
		};
		// First OR branch: legacy SSE baseUrl.
		expect(whereArg.where.OR[0]).toEqual({
			baseUrl: "https://mcp.atlassian.com/v1/sse",
		});
		// Second OR branch: dcrRegistrationEndpoint exists AND is not the
		// new endpoint. Crucially this does NOT match post-fix rows whose
		// dcrRegistrationEndpoint is the cf.mcp.atlassian.com one.
		expect(whereArg.where.OR[1]).toEqual({
			AND: [
				{ dcrRegistrationEndpoint: { not: null } },
				{
					dcrRegistrationEndpoint: {
						not: "https://cf.mcp.atlassian.com/v1/register",
					},
				},
			],
		});
	});

	it("clears the right DCR + cache fields on the matching rows", async () => {
		await runFixAtlassianMcpConfigs({ dryRun: false });
		// Two candidates → two updateMany calls.
		expect(updateManyMock).toHaveBeenCalledTimes(2);
		const firstCall = updateManyMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(firstCall.data).toEqual({
			baseUrl: null,
			oauthClientId: null,
			encryptedOauthClientSecret: null,
			dcrRegistrationEndpoint: null,
			// Nullable Json columns use the Prisma.DbNull sentinel — see
			// the production script for why literal null doesn't typecheck.
			dcrClientMetadata: { __dbNull: true },
			dcrRegisteredAt: null,
			oauthMetadataCache: { __dbNull: true },
			oauthMetadataCachedAt: null,
		});
	});

	it("dry-run mode makes NO writes", async () => {
		await runFixAtlassianMcpConfigs({ dryRun: true });
		expect(updateManyMock).not.toHaveBeenCalled();
		expect(deleteManyMock).not.toHaveBeenCalled();
	});

	it("is idempotent — a second run with no candidates is a no-op (AC-8)", async () => {
		findManyMock.mockResolvedValue([]);
		const result = await runFixAtlassianMcpConfigs({ dryRun: false });
		expect(updateManyMock).not.toHaveBeenCalled();
		expect(deleteManyMock).not.toHaveBeenCalled();
		expect(result).toEqual({
			candidates: 0,
			cleared: 0,
			raced: 0,
			oauthStatesRevoked: 0,
		});
	});

	it("uses a conditional update keyed on (id, oauthClientId) to guard against races", async () => {
		await runFixAtlassianMcpConfigs({ dryRun: false });
		const firstCall = updateManyMock.mock.calls[0]?.[0] as {
			where: { id: string; oauthClientId: string };
		};
		expect(firstCall.where).toEqual({
			id: "cfg-1",
			oauthClientId: "stale-client-id-1",
		});
		const secondCall = updateManyMock.mock.calls[1]?.[0] as {
			where: { id: string; oauthClientId: string };
		};
		expect(secondCall.where).toEqual({
			id: "cfg-2",
			oauthClientId: "stale-client-id-2",
		});
	});

	it("counts cleared vs raced based on updateMany result.count", async () => {
		updateManyMock
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 }); // raced
		const result = await runFixAtlassianMcpConfigs({ dryRun: false });
		expect(result.cleared).toBe(1);
		expect(result.raced).toBe(1);
	});

	it("revokes in-flight MCPOAuthState rows scoped to the touched configs", async () => {
		deleteManyMock.mockResolvedValue({ count: 3 });
		const result = await runFixAtlassianMcpConfigs({ dryRun: false });
		expect(deleteManyMock).toHaveBeenCalledWith({
			where: { configId: { in: ["cfg-1", "cfg-2"] } },
		});
		expect(result.oauthStatesRevoked).toBe(3);
	});
});
