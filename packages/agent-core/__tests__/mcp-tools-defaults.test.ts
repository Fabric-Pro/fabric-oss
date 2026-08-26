/**
 * Unit tests for the managed-default MCP helpers exported from
 * `packages/agent-core/src/services/mcp-tools.ts`:
 *
 *   1. `getDefaultEnabledMcpConfigIds(userId, organizationId)`.
 *      Returns the MCPConfig ids for every server flagged
 *      `defaultEnabled=true AND isSystemProvided=true` scoped to the
 *      caller's tenant (XOR filter — `organizationId` is EITHER provided
 *      OR null, never an OR).
 *   2. `seedDefaultMcpConfigsForTenant({ userId, organizationId })`.
 *      Idempotent helper that all three Better Auth hooks call so adding
 *      the next default-enabled server (e.g., Mermaid) costs zero hook
 *      code.
 *
 * The Prisma client is mocked at the module boundary; assertions verify
 * the WHERE clause shape and the resulting call sequence. This keeps the
 * tests fast and lets them run anywhere `pnpm --filter @repo/agent-core
 * test` runs (no live DB required). Full integration coverage (post-signup
 * hook fires and persists a real row) lives in
 * `packages/auth/lib/__tests__/seed-default-mcp-configs.integration.test.ts`
 * — written separately because the auth and agent-core packages keep
 * their unit suites independent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMcpConfigFindMany = vi.fn();
const mockMcpServerFindMany = vi.fn();
const mockMcpConfigFindFirst = vi.fn();
const mockMcpConfigCreate = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		mCPConfig: {
			findMany: (...args: unknown[]) => mockMcpConfigFindMany(...args),
			findFirst: (...args: unknown[]) => mockMcpConfigFindFirst(...args),
			create: (...args: unknown[]) => mockMcpConfigCreate(...args),
		},
		mCPServer: {
			findMany: (...args: unknown[]) => mockMcpServerFindMany(...args),
		},
	},
	// Re-exports used by other parts of mcp-tools.ts (tested elsewhere).
	listMcpConfigsForTenant: vi.fn(),
}));

// mcp-tools.ts also imports from @repo/mcp for client creation — mock it
// so the module load doesn't pull in real MCP client code.
vi.mock("@repo/mcp", () => ({
	closeMcpClient: vi.fn(),
	createMcpClientForConfig: vi.fn(),
}));

import {
	getDefaultEnabledMcpConfigIds,
	getDetailedMcpToolInfo,
	seedDefaultMcpConfigsForTenant,
} from "../src/services/mcp-tools";

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getDefaultEnabledMcpConfigIds
// ---------------------------------------------------------------------------

describe("getDefaultEnabledMcpConfigIds", () => {
	it("returns the ids of every enabled default-MCP config for a personal-context tenant", async () => {
		mockMcpConfigFindMany.mockResolvedValueOnce([
			{ id: "cfg-excalidraw-1" },
		]);

		const result = await getDefaultEnabledMcpConfigIds("user-1", null);

		expect(result).toEqual(["cfg-excalidraw-1"]);
		// XOR filter — personal context REQUIRES organizationId: null literal
		// in the where clause (a missing key would match every org's rows).
		expect(mockMcpConfigFindMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: null,
				enabled: true,
				mcpServer: {
					defaultEnabled: true,
					isSystemProvided: true,
				},
			},
			select: { id: true },
		});
	});

	it("returns the ids for an org-context tenant with the org id in the filter", async () => {
		mockMcpConfigFindMany.mockResolvedValueOnce([
			{ id: "cfg-excalidraw-2" },
		]);

		const result = await getDefaultEnabledMcpConfigIds("user-1", "org-7");

		expect(result).toEqual(["cfg-excalidraw-2"]);
		expect(mockMcpConfigFindMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: "org-7",
				enabled: true,
				mcpServer: {
					defaultEnabled: true,
					isSystemProvided: true,
				},
			},
			select: { id: true },
		});
	});

	it("returns [] for tenants without the sentinel row (rollout window)", async () => {
		// During the rollout window an existing tenant may not yet have the
		// backfill applied. The helper is tolerant — returns [] instead of
		// throwing so the orchestrator-start path keeps the caller's
		// original `enabledMcpConfigIds` array.
		mockMcpConfigFindMany.mockResolvedValueOnce([]);

		const result = await getDefaultEnabledMcpConfigIds(
			"user-unknown",
			null,
		);

		expect(result).toEqual([]);
	});

	it("does not cross tenants — org A's call cannot return org B's config", async () => {
		// Two consecutive calls — one for org A, one for org B. The mock
		// returns different sets per call. We verify the WHERE clause for
		// each call carries the right organizationId so the XOR filter is
		// honored, and the result for org A never carries org B's id.
		mockMcpConfigFindMany
			.mockResolvedValueOnce([{ id: "cfg-org-a" }])
			.mockResolvedValueOnce([{ id: "cfg-org-b" }]);

		const orgA = await getDefaultEnabledMcpConfigIds("user-1", "org-A");
		const orgB = await getDefaultEnabledMcpConfigIds("user-1", "org-B");

		expect(orgA).toEqual(["cfg-org-a"]);
		expect(orgB).toEqual(["cfg-org-b"]);
		expect(mockMcpConfigFindMany).toHaveBeenNthCalledWith(1, {
			where: expect.objectContaining({
				userId: "user-1",
				organizationId: "org-A",
			}),
			select: { id: true },
		});
		expect(mockMcpConfigFindMany).toHaveBeenNthCalledWith(2, {
			where: expect.objectContaining({
				userId: "user-1",
				organizationId: "org-B",
			}),
			select: { id: true },
		});
	});

	it("returns multiple ids when the registry has multiple default-enabled servers", async () => {
		// Forward-looking — once a future spec flips Mermaid to
		// `defaultEnabled=true`, the same helper picks it up without code
		// changes. Asserting this contract today locks the multi-server
		// behavior before that spec ships.
		mockMcpConfigFindMany.mockResolvedValueOnce([
			{ id: "cfg-excalidraw" },
			{ id: "cfg-mermaid" },
		]);

		const result = await getDefaultEnabledMcpConfigIds("user-1", null);

		expect(result).toEqual(["cfg-excalidraw", "cfg-mermaid"]);
	});
});

// ---------------------------------------------------------------------------
// getDetailedMcpToolInfo — needsReauth circuit-breaker discovery filter
// ---------------------------------------------------------------------------

describe("getDetailedMcpToolInfo", () => {
	it("excludes OAuth configs tripped by the refresh circuit breaker from discovery", async () => {
		mockMcpConfigFindMany.mockResolvedValueOnce([]);

		await getDetailedMcpToolInfo({
			userId: "user-1",
			enabledMcpConfigIds: null,
			skipConnection: true,
		});

		expect(mockMcpConfigFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					enabled: true,
					// A bare `needsReauth: false` would also hide a config
					// since edited to API_KEY / NONE, whose flag describes a
					// retired OAuth grant and can only be cleared by an OAuth
					// reconnect the config no longer has. The predicate must
					// exclude a tripped config only while it is still OAuth.
					OR: [
						{ authType: { not: "OAUTH2" } },
						{ needsReauth: false },
					],
				}),
			}),
		);
	});

	it("keeps the tenant filter intact alongside the breaker predicate", async () => {
		// Prisma ANDs top-level keys, so the added `OR` must compose with the
		// XOR tenant filter and the explicit id filter rather than replace
		// them. Asserting the whole `where` (not `objectContaining`) is what
		// makes a widened query fail here: an `OR` that swallowed the tenant
		// keys would leak another user's configs into discovery.
		mockMcpConfigFindMany.mockResolvedValueOnce([]);

		await getDetailedMcpToolInfo({
			userId: "user-1",
			organizationId: "org-7",
			enabledMcpConfigIds: ["cfg-a", "cfg-b"],
			skipConnection: true,
		});

		expect(mockMcpConfigFindMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: "org-7",
				enabled: true,
				OR: [{ authType: { not: "OAUTH2" } }, { needsReauth: false }],
				id: { in: ["cfg-a", "cfg-b"] },
			},
			include: { mcpServer: true },
			// Deliberate: row order decides which servers survive the
			// per-request tool-schema budget, so it must not be left to
			// Postgres' physical order (Fizzy #2040). Asserted here rather
			// than dropped to `objectContaining`, which would also stop this
			// test failing on a widened `where`.
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		});
	});

	it("surfaces a tripped non-OAuth config that the predicate let through", async () => {
		// The predicate runs in Postgres, so the filtering itself is asserted
		// above. What this pins is the consequence: a row the database DID
		// return — an API_KEY config still carrying a stale flag — reaches the
		// caller as a usable server rather than being dropped somewhere later.
		mockMcpConfigFindMany.mockResolvedValueOnce([
			{
				id: "cfg-api-key",
				displayName: "Stale Flag Server",
				authType: "API_KEY",
				needsReauth: true,
				mcpServer: { name: "Example" },
			},
		]);

		const result = await getDetailedMcpToolInfo({
			userId: "user-1",
			enabledMcpConfigIds: null,
			skipConnection: true,
		});

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			configId: "cfg-api-key",
			configName: "Stale Flag Server",
		});
	});
});

// ---------------------------------------------------------------------------
// seedDefaultMcpConfigsForTenant
// ---------------------------------------------------------------------------

describe("seedDefaultMcpConfigsForTenant", () => {
	const EXCALIDRAW = { id: "srv-excalidraw", key: "excalidraw" };
	const MERMAID = { id: "srv-mermaid", key: "mermaid" };

	it("is a no-op when the registry has zero default-enabled servers", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([]);

		await seedDefaultMcpConfigsForTenant({
			userId: "user-1",
			organizationId: null,
		});

		expect(mockMcpConfigFindFirst).not.toHaveBeenCalled();
		expect(mockMcpConfigCreate).not.toHaveBeenCalled();
	});

	it("inserts one sentinel row when no existing row is present (personal context)", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([EXCALIDRAW]);
		mockMcpConfigFindFirst.mockResolvedValueOnce(null);
		mockMcpConfigCreate.mockResolvedValueOnce({ id: "cfg-new" });

		await seedDefaultMcpConfigsForTenant({
			userId: "user-1",
			organizationId: null,
		});

		expect(mockMcpConfigCreate).toHaveBeenCalledTimes(1);
		expect(mockMcpConfigCreate).toHaveBeenCalledWith({
			data: {
				mcpServerId: EXCALIDRAW.id,
				userId: "user-1",
				organizationId: null,
				authType: "NONE",
				enabled: true,
				isManagedDefault: true,
			},
		});
	});

	it("does NOT insert when an existing row is already present (idempotency)", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([EXCALIDRAW]);
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-existing" });

		await seedDefaultMcpConfigsForTenant({
			userId: "user-1",
			organizationId: null,
		});

		// Existence check fired but create did NOT — calling the helper
		// twice for the same tenant produces one row, not two.
		expect(mockMcpConfigFindFirst).toHaveBeenCalledTimes(1);
		expect(mockMcpConfigCreate).not.toHaveBeenCalled();
	});

	it("inserts one row for the missing server when two registry rows exist (mixed pre-existing state)", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([EXCALIDRAW, MERMAID]);
		// Excalidraw already exists; Mermaid does not.
		mockMcpConfigFindFirst
			.mockResolvedValueOnce({ id: "cfg-existing-excalidraw" })
			.mockResolvedValueOnce(null);
		mockMcpConfigCreate.mockResolvedValueOnce({ id: "cfg-new-mermaid" });

		await seedDefaultMcpConfigsForTenant({
			userId: "user-1",
			organizationId: null,
		});

		expect(mockMcpConfigCreate).toHaveBeenCalledTimes(1);
		expect(mockMcpConfigCreate).toHaveBeenCalledWith({
			data: {
				mcpServerId: MERMAID.id,
				userId: "user-1",
				organizationId: null,
				authType: "NONE",
				enabled: true,
				isManagedDefault: true,
			},
		});
	});

	it("honors XOR tenant filter — org context inserts with the org id, never with both keys mixed", async () => {
		mockMcpServerFindMany.mockResolvedValueOnce([EXCALIDRAW]);
		mockMcpConfigFindFirst.mockResolvedValueOnce(null);
		mockMcpConfigCreate.mockResolvedValueOnce({ id: "cfg-new-org" });

		await seedDefaultMcpConfigsForTenant({
			userId: "user-1",
			organizationId: "org-42",
		});

		// Existence check uses the same tuple as the insert — every read
		// and every write carries `(userId, organizationId, mcpServerId)`.
		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: "org-42",
				mcpServerId: EXCALIDRAW.id,
			},
			select: { id: true },
		});
		expect(mockMcpConfigCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userId: "user-1",
				organizationId: "org-42",
				mcpServerId: EXCALIDRAW.id,
				isManagedDefault: true,
			}),
		});
	});

	it("personal-context existence check uses organizationId: null (not undefined / missing)", async () => {
		// Personal-context calls pass `organizationId: null` — never
		// `undefined` — so the WHERE clause matches the XOR backfill
		// invariant (`organizationId IS NULL`).
		mockMcpServerFindMany.mockResolvedValueOnce([EXCALIDRAW]);
		mockMcpConfigFindFirst.mockResolvedValueOnce(null);
		mockMcpConfigCreate.mockResolvedValueOnce({ id: "cfg-new" });

		await seedDefaultMcpConfigsForTenant({
			userId: "user-1",
			organizationId: null,
		});

		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: null,
				mcpServerId: EXCALIDRAW.id,
			},
			select: { id: true },
		});
	});
});
