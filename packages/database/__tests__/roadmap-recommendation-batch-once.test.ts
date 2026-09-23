/**
 * `createRoadmapRecommendationBatchOnce` — the once-per-run batch write behind
 * `persistRoadmapRecommendations` (Fizzy #2208).
 *
 * Two attempts of the persist activity can overlap, so the run's advisory lock
 * must be taken inside the transaction BEFORE the lookup; a found row is
 * returned without writing, and only a miss creates.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executeRawMock = vi.fn();
const findFirstMock = vi.fn();
const createMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../prisma/client", () => {
	const tx = {
		$executeRaw: (...args: unknown[]) => executeRawMock(...args),
		pendingBacklogProposal: {
			findFirst: (args: unknown) => findFirstMock(args),
			create: (args: unknown) => createMock(args),
		},
	};
	return {
		db: {
			$transaction: (
				fn: (tx: unknown) => Promise<unknown>,
				options: unknown,
			) => {
				transactionMock(options);
				return fn(tx);
			},
		},
	};
});

import { createRoadmapRecommendationBatchOnce } from "../prisma/queries/projects/pending-backlog-proposals";

const PARAMS = {
	workflowRunId: "run-1",
	projectId: "project-1",
	proposal: { changes: [{ title: { to: "Saved searches" } }] },
	summary: "1 features recommended from project context",
	changeCount: 1,
	sourceMetadata: { workflowRunId: "run-1" },
	userId: "user-1",
	organizationId: "org-1",
};

function rawSql(callIndex: number): string {
	const [strings] = executeRawMock.mock.calls[callIndex] as [
		TemplateStringsArray,
		...unknown[],
	];
	return strings.join("?");
}

beforeEach(() => {
	vi.clearAllMocks();
	executeRawMock.mockResolvedValue(1);
	findFirstMock.mockResolvedValue(null);
	createMock.mockImplementation(
		async (args: { data: { changeCount: number } }) => ({
			id: "batch-new",
			changeCount: args.data.changeCount,
		}),
	);
});

describe("createRoadmapRecommendationBatchOnce", () => {
	it("takes the run's advisory lock before the lookup, in the (int4, int4) space", async () => {
		await createRoadmapRecommendationBatchOnce(PARAMS);

		expect(rawSql(0)).toMatch(/pg_advisory_xact_lock\(\?::int, \?::int\)/);
		expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
			findFirstMock.mock.invocationCallOrder[0],
		);
		expect(transactionMock).toHaveBeenCalledWith(
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
	});

	it("keys the lock on the run, so two runs never serialize on one id", async () => {
		await createRoadmapRecommendationBatchOnce(PARAMS);
		await createRoadmapRecommendationBatchOnce({
			...PARAMS,
			workflowRunId: "run-2",
		});

		const keyOf = (i: number) => executeRawMock.mock.calls[i]?.[2];
		expect(keyOf(0)).not.toBe(keyOf(1));
	});

	it("returns the run's existing batch without creating a second one", async () => {
		findFirstMock.mockResolvedValue({ id: "batch-prev", changeCount: 27 });

		const result = await createRoadmapRecommendationBatchOnce(PARAMS);

		expect(result).toEqual({
			id: "batch-prev",
			changeCount: 27,
			created: false,
		});
		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				source: "ROADMAP_RECOMMENDATION",
				sourceMetadata: { path: ["workflowRunId"], equals: "run-1" },
			},
			select: { id: true, changeCount: true },
		});
		expect(createMock).not.toHaveBeenCalled();
	});

	it("creates the ROADMAP_RECOMMENDATION row inside the same transaction on a miss", async () => {
		const result = await createRoadmapRecommendationBatchOnce(PARAMS);

		expect(result).toEqual({
			id: "batch-new",
			changeCount: 1,
			created: true,
		});
		expect(createMock).toHaveBeenCalledWith({
			data: expect.objectContaining({
				projectId: "project-1",
				source: "ROADMAP_RECOMMENDATION",
				changeCount: 1,
				userId: "user-1",
				organizationId: "org-1",
			}),
		});
		expect(createMock.mock.calls[0]?.[0].data).not.toHaveProperty(
			"workflowRunId",
		);
	});
});
