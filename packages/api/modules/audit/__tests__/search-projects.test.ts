/**
 * Tests for `audit.searchProjects` — typeahead search for the audit-log
 * project filter combobox.
 *
 * Mirrors search-members.test.ts — verifies tenant isolation,
 * personal-context short-circuit, and the query shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const projectFindManyMock = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			project: {
				findMany: (...args: unknown[]) => projectFindManyMock(...args),
			},
		},
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: vi.fn().mockReturnValue(""),
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { searchAuditProjectsProcedure } from "../procedures/search-projects";

const handler = (
	searchAuditProjectsProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: { user: { id: string; email: string } };
				input: {
					organizationId?: string | null;
					query?: string;
					limit?: number;
				};
			}) => Promise<{
				projects: Array<{
					id: string;
					name: string;
					icon: string | null;
				}>;
			}>;
		};
	}
)["~orpc"].handler;

const CONTEXT = { user: { id: "user-1", email: "alice@example.com" } };

beforeEach(() => {
	projectFindManyMock.mockReset();
});

describe("audit.searchProjects handler", () => {
	it("returns an empty list for personal context", async () => {
		const result = await handler({
			context: CONTEXT,
			input: { organizationId: null, query: "" },
		});
		expect(result.projects).toEqual([]);
		expect(projectFindManyMock).not.toHaveBeenCalled();
	});

	it("queries the DB with the org clamp in org context", async () => {
		projectFindManyMock.mockResolvedValueOnce([
			{ id: "proj-1", name: "Alpha", icon: null },
		]);
		const result = await handler({
			context: CONTEXT,
			input: { organizationId: "org-1", query: "", limit: 50 },
		});
		expect(projectFindManyMock).toHaveBeenCalledTimes(1);
		const call = projectFindManyMock.mock.calls[0]?.[0] as {
			where: { organizationId: string; deletedAt: null };
			take: number;
		};
		// Hard tenant clamp + soft-deleted filter.
		expect(call.where.organizationId).toBe("org-1");
		expect(call.where.deletedAt).toBeNull();
		expect(call.take).toBe(50);
		expect(result.projects).toEqual([
			{ id: "proj-1", name: "Alpha", icon: null },
		]);
	});

	it("applies a substring filter on name when query is non-empty", async () => {
		projectFindManyMock.mockResolvedValueOnce([]);
		await handler({
			context: CONTEXT,
			input: { organizationId: "org-1", query: "alpha", limit: 50 },
		});
		const call = projectFindManyMock.mock.calls[0]?.[0] as {
			where: {
				organizationId: string;
				name?: { contains: string; mode: string };
			};
		};
		expect(call.where.organizationId).toBe("org-1");
		expect(call.where.name?.contains).toBe("alpha");
	});

	it("defaults to a 20 limit when not provided", async () => {
		projectFindManyMock.mockResolvedValueOnce([]);
		await handler({
			context: CONTEXT,
			input: { organizationId: "org-1" },
		});
		const call = projectFindManyMock.mock.calls[0]?.[0] as { take: number };
		expect(call.take).toBe(20);
	});
});
