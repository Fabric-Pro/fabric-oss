import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	countRegisteredAgents,
	listRegisteredAgents,
} from "../registered-agents";

interface Filter {
	OR: Array<{ scope: string; organizationId?: string; userId?: string }>;
	NOT?: { scope: string; agentId: { in: string[] } };
}
const m = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn() }));
vi.mock("../../client", () => ({ db: { registeredAgent: m } }));
const rows = [
	{ agentId: "cuga_generalist", scope: "SYSTEM" },
	{ agentId: "active-system", scope: "SYSTEM" },
	{
		agentId: "cuga-generalist",
		scope: "ORGANIZATION",
		organizationId: "example-org",
	},
	{
		agentId: "custom-cuga",
		scope: "ORGANIZATION",
		organizationId: "example-org",
	},
	{ agentId: "personal-only", scope: "USER", userId: "example-user" },
	{
		agentId: "other-org-only",
		scope: "ORGANIZATION",
		organizationId: "other-org",
	},
];
function matching(where: Filter) {
	return rows.filter(
		(row) =>
			where.OR.some(
				(clause) =>
					clause.scope === row.scope &&
					(!clause.organizationId ||
						clause.organizationId === row.organizationId) &&
					(!clause.userId || clause.userId === row.userId),
			) &&
			!(
				where.NOT?.scope === row.scope &&
				where.NOT.agentId.in.includes(row.agentId)
			),
	);
}
beforeEach(() => {
	m.findMany.mockImplementation(async ({ where, skip, take }) =>
		matching(where).slice(skip, skip + take),
	);
	m.count.mockImplementation(async ({ where }) => matching(where).length);
});
describe("registered agent discovery exclusions", () => {
	it("keeps count and list on the same exclusive organization scope", async () => {
		const options = {
			userId: "example-user",
			organizationId: "example-org",
		};
		const listed = await listRegisteredAgents(options);
		expect(listed).not.toContainEqual(rows[4]);
		expect(listed).not.toContainEqual(rows[5]);
		expect(await countRegisteredAgents(options)).toBe(listed.length);
		expect(m.findMany.mock.calls[0][0].where.OR).toEqual(
			m.count.mock.calls[0][0].where.OR,
		);
	});
	it("excludes retired SYSTEM rows before pagination and applies the same exclusion to count", async () => {
		const options = {
			userId: "example-user",
			organizationId: "example-org",
			excludeSystemAgentIds: ["cuga_generalist", "cuga-generalist"],
		};
		expect(
			await listRegisteredAgents({ ...options, limit: 1, offset: 0 }),
		).toEqual([rows[1]]);
		expect(
			await listRegisteredAgents({ ...options, limit: 1, offset: 1 }),
		).toEqual([rows[2]]);
		expect(await countRegisteredAgents(options)).toBe(3);
		expect(m.findMany.mock.calls[0][0].where.NOT).toEqual(
			m.count.mock.calls[0][0].where.NOT,
		);
	});
});
