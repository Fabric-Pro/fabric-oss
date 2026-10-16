/**
 * `ownMcpConfigIds` is how a scheduled agent proves every MCP connection it
 * names is the workflow owner's own, in this organization. The agent runs as
 * the owner, so a lookup that dropped either half of the scope would let one
 * person's connection be reached through another person's workflow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		mCPConfig: {
			findMany: (...args: unknown[]) => findManyMock(...args),
		},
	},
}));

import { ownMcpConfigIds } from "../prisma/queries/mcp";

const actor = { userId: "user-1", organizationId: "org-example-a" };

describe("ownMcpConfigIds", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		findManyMock.mockResolvedValue([]);
	});

	it("asks only for the actor's own rows in the actor's organization", async () => {
		await ownMcpConfigIds(["cfg-1", "cfg-2"], actor);

		const where = findManyMock.mock.calls[0]?.[0].where;
		expect(where).toEqual({
			organizationId: "org-example-a",
			userId: "user-1",
			id: { in: ["cfg-1", "cfg-2"] },
		});
	});

	it("looks each id up once", async () => {
		await ownMcpConfigIds(["cfg-1", "cfg-1"], actor);

		const where = findManyMock.mock.calls[0]?.[0].where;
		expect(where.id).toEqual({ in: ["cfg-1"] });
	});

	it("returns what the query found, with the fields that name a server", async () => {
		const rows = [
			{
				id: "cfg-1",
				enabled: true,
				displayName: null,
				mcpServer: { name: "Example Server" },
			},
		];
		findManyMock.mockResolvedValue(rows);

		const found = await ownMcpConfigIds(["cfg-1"], actor);

		expect(found).toEqual(rows);
		const select = findManyMock.mock.calls[0]?.[0].select;
		expect(select).toMatchObject({
			id: true,
			enabled: true,
			displayName: true,
			mcpServer: { select: { name: true } },
		});
	});

	it("does not query when no id is asked for", async () => {
		const found = await ownMcpConfigIds([], actor);

		expect(found).toEqual([]);
		expect(findManyMock).not.toHaveBeenCalled();
	});
});
