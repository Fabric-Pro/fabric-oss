/**
 * Pins the tenant arms of `getMcpConfigById` (Fizzy #2897).
 *
 * The Next.js MCP routes skip their organization check when the request names
 * no organization, on the strength of this lookup's personal arm: with no
 * organization it matches only a row whose `organizationId` IS NULL and whose
 * `userId` is the caller's. If the personal arm ever dropped
 * `organizationId: null`, a request with no organization would find the
 * caller's organization-owned configs — after they had left that organization —
 * and the routes' check would never run. Every falsy spelling the routes can
 * pass (undefined, null, "") must take that arm.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		mCPConfig: {
			findFirst: (...args: unknown[]) => findFirstMock(...args),
		},
	},
}));

import { getMcpConfigById } from "../prisma/queries/mcp";

type FindFirstArgs = { where: Record<string, unknown> };

function lastWhere() {
	expect(findFirstMock).toHaveBeenCalledTimes(1);
	return (findFirstMock.mock.calls[0]?.[0] as FindFirstArgs).where;
}

describe("getMcpConfigById — tenant arms", () => {
	beforeEach(() => {
		findFirstMock.mockReset();
		findFirstMock.mockResolvedValue(null);
	});

	it.each([
		["undefined", undefined],
		["null", null],
		["an empty string", ""],
	])(
		"with organization %s, matches only the caller's own no-organization row",
		async (_label, organizationId) => {
			await getMcpConfigById("cfg_1", {
				userId: "user_1",
				// The routes pass whatever the request body held.
				organizationId: organizationId as string | undefined,
			});

			expect(lastWhere()).toEqual({
				id: "cfg_1",
				userId: "user_1",
				organizationId: null,
			});
		},
	);

	it("with an organization, matches only the caller's row in that organization", async () => {
		await getMcpConfigById("cfg_1", {
			userId: "user_1",
			organizationId: "org_1",
		});

		expect(lastWhere()).toEqual({
			id: "cfg_1",
			userId: "user_1",
			organizationId: "org_1",
		});
	});

	it("reads nothing without a caller", async () => {
		expect(await getMcpConfigById("cfg_1")).toBeNull();
		expect(
			await getMcpConfigById("cfg_1", {
				userId: "",
				organizationId: "org_1",
			}),
		).toBeNull();
		expect(findFirstMock).not.toHaveBeenCalled();
	});
});
