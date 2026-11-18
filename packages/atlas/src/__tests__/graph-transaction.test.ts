import { beforeEach, expect, it, vi } from "vitest";

const { transaction, findMany, calls, tx } = vi.hoisted(() => {
	const calls: string[] = [];
	const op = (name: string) =>
		vi.fn(async () => {
			calls.push(name);
		});
	return {
		transaction: vi.fn(),
		findMany: vi.fn(async () => []),
		calls,
		tx: {
			atlasCrossEdge: {
				deleteMany: op("cross delete"),
				createMany: op("cross create"),
			},
			atlasEdge: {
				deleteMany: op("edge delete"),
				createMany: op("edge create"),
			},
			atlasNode: {
				deleteMany: op("node delete"),
				createMany: op("node create"),
			},
			atlasAnalysis: { update: op("signature") },
		},
	};
});
vi.mock("@repo/database", () => ({
	db: { $transaction: transaction, atlasNode: { findMany } },
	Prisma: {},
}));

import {
	GRAPH_REWRITE_TIMEOUT_MS,
	persistBusinessGraph,
	persistTechnicalGraph,
	replaceCrossEdges,
} from "../queries";

beforeEach(() => {
	calls.length = 0;
	vi.clearAllMocks();
	transaction.mockImplementation(async (fn) => fn(tx));
});
const ctx = { userId: "user-1", organizationId: "org-1" };
const args = { analysisId: "analysis-1", projectId: "project-1" };
function check(expected: string[]) {
	expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
		timeout: GRAPH_REWRITE_TIMEOUT_MS,
		maxWait: 2000,
	});
	expect(calls).toEqual(expected);
}
it("rewrites cross edges on the transaction", async () => {
	await replaceCrossEdges(ctx, args.projectId, [
		{
			mode: "TECHNICAL",
			kind: "DEPENDS_ON",
			detection: "IMPORT",
			sourceAnalysisId: "a",
			sourceKey: "a",
			targetAnalysisId: "b",
			targetKey: "b",
			weight: 1,
			description: null,
		},
	] as never);
	check(["cross delete", "cross create"]);
});
it("rewrites technical graph on the transaction", async () => {
	await persistTechnicalGraph(ctx, {
		...args,
		graph: { nodes: [], edges: [] } as never,
		changedModuleKeys: new Set(),
	});
	check(["edge delete", "node delete", "node create", "edge create"]);
});
it("rewrites business graph and signature on the transaction", async () => {
	await persistBusinessGraph(ctx, {
		...args,
		draft: { capabilities: [], relations: [] },
		signature: "signature",
	});
	check([
		"edge delete",
		"node delete",
		"node create",
		"edge create",
		"signature",
	]);
});
