/**
 * Unit tests for `findDefaultMcpConfigActivity`.
 *
 * Resolves the tenant's MCPConfig row for a given `serverKey`, scoped via
 * the XOR tenant filter (`userId` + `organizationId ?? null`). Renamed from
 * `find-excalidraw-config.ts` when the helper was generalized. The
 * parameterized `serverKey` is the contract this test locks — passing
 * `serverKey: "mermaid"` MUST resolve a Mermaid fixture independently of
 * Excalidraw.
 *
 * The Prisma client is mocked at the module boundary so the test runs
 * without a live DB. Activities don't proxy through `proxyActivities` —
 * they import `db` directly — so we mock `@repo/database` the same way
 * the existing `mcp-tools-defaults.test.ts` does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMcpConfigFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			findFirst: (...args: unknown[]) => mockMcpConfigFindFirst(...args),
		},
	},
}));

import { findDefaultMcpConfigActivity } from "../find-default-mcp-config";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("findDefaultMcpConfigActivity", () => {
	// -----------------------------------------------------------------------
	// Tenant XOR — every read carries (userId, organizationId|null), never
	// an OR.
	// -----------------------------------------------------------------------

	it("personal-context lookup uses organizationId: null in the WHERE clause", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-1" });

		await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: null,
			userId: "user-1",
			organizationId: undefined,
		});

		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: null,
				enabled: true,
				mcpServer: { key: "excalidraw" },
			},
			select: { id: true },
		});
	});

	it("org-context lookup uses organizationId: <id> in the WHERE clause", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-2" });

		await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: null,
			userId: "user-1",
			organizationId: "org-42",
		});

		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: "org-42",
				enabled: true,
				mcpServer: { key: "excalidraw" },
			},
			select: { id: true },
		});
	});

	// -----------------------------------------------------------------------
	// enabledMcpConfigIds semantics — null/empty = tenant-level fallback,
	// non-empty = restricted lookup. Per the file's doc comment.
	// -----------------------------------------------------------------------

	it("does NOT add an id restriction when enabledMcpConfigIds is null", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-1" });

		await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: null,
			userId: "user-1",
			organizationId: undefined,
		});

		const where = mockMcpConfigFindFirst.mock.calls[0][0].where as Record<
			string,
			unknown
		>;
		expect(where.id).toBeUndefined();
	});

	it("does NOT add an id restriction when enabledMcpConfigIds is [] (model-as-agent default)", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-1" });

		await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: [],
			userId: "user-1",
			organizationId: undefined,
		});

		const where = mockMcpConfigFindFirst.mock.calls[0][0].where as Record<
			string,
			unknown
		>;
		expect(where.id).toBeUndefined();
	});

	it("ADDS an `id: { in: [...] }` restriction when enabledMcpConfigIds is non-empty", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-1" });

		await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: ["cfg-1", "cfg-2"],
			userId: "user-1",
			organizationId: undefined,
		});

		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: { in: ["cfg-1", "cfg-2"] },
			}),
			select: { id: true },
		});
	});

	// -----------------------------------------------------------------------
	// Return shape — `{ configId, mcpServerKey }` when found, `null` when not.
	// -----------------------------------------------------------------------

	it("returns the resolved config with mcpServerKey echoed back", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-99" });

		const result = await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: null,
			userId: "user-1",
			organizationId: undefined,
		});

		expect(result).toEqual({
			configId: "cfg-99",
			mcpServerKey: "excalidraw",
		});
	});

	it("returns null when no config exists in the resolved scope", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce(null);

		const result = await findDefaultMcpConfigActivity({
			serverKey: "excalidraw",
			enabledMcpConfigIds: null,
			userId: "user-unknown",
			organizationId: undefined,
		});

		expect(result).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Parameterized-case requirement: a different `serverKey` resolves a
	// different fixture row, independently of Excalidraw. Locks the
	// parameterization that was the renaming's whole point — passing
	// `"mermaid"` MUST end up in the WHERE clause's `mcpServer.key` field.
	// -----------------------------------------------------------------------

	it("parameterized — serverKey: 'mermaid' resolves a Mermaid row, independently of Excalidraw", async () => {
		mockMcpConfigFindFirst.mockResolvedValueOnce({ id: "cfg-mermaid-1" });

		const result = await findDefaultMcpConfigActivity({
			serverKey: "mermaid",
			enabledMcpConfigIds: null,
			userId: "user-1",
			organizationId: undefined,
		});

		expect(result).toEqual({
			configId: "cfg-mermaid-1",
			mcpServerKey: "mermaid",
		});
		expect(mockMcpConfigFindFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				organizationId: null,
				enabled: true,
				mcpServer: { key: "mermaid" },
			},
			select: { id: true },
		});
	});
});
