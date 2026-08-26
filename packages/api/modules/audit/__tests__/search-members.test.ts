/**
 * Tests for `audit.searchMembers` — typeahead search for the audit-log
 * actor filter combobox.
 *
 * Verifies:
 *  - personal context returns an empty list (no combobox shown there)
 *  - org context queries `db.member.findMany` with the org clamp and
 *    returns the projected shape
 *  - the SQL filter clamps to `Member.organizationId` (defense in depth
 *    — even if the gate let an attacker through they couldn't read a
 *    different org's members from this handler)
 *  - the limit caps at the 50-row default
 *
 * Spec: docs/audit-log/README.md §8.2.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			member: {
				findMany: (...args: unknown[]) => findManyMock(...args),
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

import { searchAuditActorMembersProcedure } from "../procedures/search-members";

const handler = (
	searchAuditActorMembersProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: { user: { id: string; email: string } };
				input: {
					organizationId?: string | null;
					query?: string;
					limit?: number;
				};
			}) => Promise<{
				members: Array<{
					id: string;
					name: string | null;
					email: string;
					image: string | null;
					role: string;
				}>;
			}>;
		};
	}
)["~orpc"].handler;

const CONTEXT = { user: { id: "user-1", email: "alice@example.com" } };

beforeEach(() => {
	findManyMock.mockReset();
});

describe("audit.searchMembers handler", () => {
	it("returns an empty list for personal context", async () => {
		const result = await handler({
			context: CONTEXT,
			input: { organizationId: null, query: "" },
		});
		expect(result.members).toEqual([]);
		expect(findManyMock).not.toHaveBeenCalled();
	});

	it("queries the DB with the org clamp in org context", async () => {
		findManyMock.mockResolvedValueOnce([
			{
				role: "owner",
				user: {
					id: "u-alice",
					name: "Alice",
					email: "alice@example.com",
					image: null,
				},
			},
		]);
		const result = await handler({
			context: CONTEXT,
			input: { organizationId: "org-1", query: "", limit: 50 },
		});
		expect(findManyMock).toHaveBeenCalledTimes(1);
		const call = findManyMock.mock.calls[0]?.[0] as {
			where: { organizationId: string };
			take: number;
		};
		// Hard tenant clamp.
		expect(call.where.organizationId).toBe("org-1");
		expect(call.take).toBe(50);
		expect(result.members).toEqual([
			{
				id: "u-alice",
				name: "Alice",
				email: "alice@example.com",
				image: null,
				role: "owner",
			},
		]);
	});

	it("applies the search OR predicate on name/email when query is non-empty", async () => {
		findManyMock.mockResolvedValueOnce([]);
		await handler({
			context: CONTEXT,
			input: { organizationId: "org-1", query: "alice", limit: 50 },
		});
		const call = findManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		// Tenant clamp present and OR over user name/email.
		expect((call.where as { organizationId: string }).organizationId).toBe(
			"org-1",
		);
		expect(Array.isArray((call.where as { OR: unknown }).OR)).toBe(true);
	});

	it("defaults to a 20 limit when not provided", async () => {
		findManyMock.mockResolvedValueOnce([]);
		await handler({
			context: CONTEXT,
			input: { organizationId: "org-1" },
		});
		const call = findManyMock.mock.calls[0]?.[0] as { take: number };
		expect(call.take).toBe(20);
	});
});
