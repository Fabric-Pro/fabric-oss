import { describe, expect, it, vi } from "vitest";

const { raw, deadline } = vi.hoisted(() => ({
	raw: vi.fn().mockResolvedValue([]),
	deadline: vi.fn().mockResolvedValue(0),
}));
vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<object>()),
	db: {
		$queryRaw: raw,
		$transaction: (run: (tx: object) => Promise<unknown>) =>
			run({ $queryRaw: raw, $executeRaw: deadline }),
	},
}));

import { searchProjectKnowledge } from "../prisma/queries/projects/knowledge-search";

it("parameterizes the project, host organization, literal needle and continuation", async () => {
	await searchProjectKnowledge({
		projectId: "example-project",
		organizationId: "example-org",
		query: "%' OR 1=1 --",
		limit: 10,
		after: {
			rank: 2,
			sourceKind: "context_page",
			sourceId: "example-page",
		},
	});
	const sql = raw.mock.calls[0][0];
	expect(sql.text).not.toContain("example-org");
	expect(sql.text).not.toContain("OR 1=1");
	expect(sql.values).toContain("example-org");
	expect(sql.values).toContain("%' OR 1=1 --");
	expect(sql.text).toContain("project_context_url_page");
	expect(sql.text).toContain("project_context_conversation_bundle");
	expect(sql.text).toContain('COLLATE "C"');
	expect(sql.values).toContain(11);
});
describe("query rejects a tenant-resolution failure", () => {
	it("never reaches SQL with an empty host organization", async () => {
		raw.mockClear();
		await expect(
			searchProjectKnowledge({
				projectId: "example-project",
				organizationId: "",
				query: "needle",
				limit: 10,
			}),
		).rejects.toThrow(/organizationId/);
		expect(raw).not.toHaveBeenCalled();
	});
});

it("sets a database execution deadline before scanning source bodies", async () => {
	deadline.mockClear();
	raw.mockClear();
	await searchProjectKnowledge({
		projectId: "example-project",
		organizationId: "example-org",
		query: "needle",
		limit: 10,
	});
	expect(deadline).toHaveBeenCalledOnce();
	expect(deadline.mock.calls[0][0].join("")).toContain(
		"SET LOCAL statement_timeout",
	);
	expect(deadline.mock.invocationCallOrder[0]).toBeLessThan(
		raw.mock.invocationCallOrder[0],
	);
});
