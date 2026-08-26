import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
	dbMock: {
		testResultEvent: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			count: vi.fn(),
		},
		testCaseScriptRevision: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			count: vi.fn(),
		},
		$transaction: vi.fn(),
	},
}));

vi.mock("../../../client", () => ({ db: dbMock }));
vi.mock("../agentic-runs", () => ({
	AGENTIC_RUN_PROVIDER: "fabric-agentic",
}));

import {
	getTestCaseAgentRunEvidence,
	listTestCaseAgentRunSources,
	listTestCaseScriptRevisions,
} from "../test-case-script-revisions";

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.$transaction.mockImplementation((operations: Promise<unknown>[]) =>
		Promise.all(operations),
	);
});

describe("test case agent-run script sources", () => {
	it("keeps prior executions selectable and resolves their author snapshots", async () => {
		dbMock.testResultEvent.findMany.mockResolvedValue([
			{
				id: "event-new",
				result: "FAILED",
				occurredAt: new Date("2026-07-28T12:00:00Z"),
				_count: { agenticSteps: 3 },
				pipelineRun: {
					agenticRuns: [
						{
							id: "run-new",
							triggeredByUser: {
								name: "Ada",
								email: "ada@example.com",
							},
						},
					],
				},
			},
			{
				id: "event-old",
				result: "PASSED",
				occurredAt: new Date("2026-07-27T12:00:00Z"),
				_count: { agenticSteps: 2 },
				pipelineRun: {
					agenticRuns: [
						{
							id: "run-old",
							triggeredByUser: {
								name: null,
								email: "grace@example.com",
							},
						},
					],
				},
			},
		]);
		dbMock.testResultEvent.count.mockResolvedValue(2);

		const result = await listTestCaseAgentRunSources({
			projectId: "project-1",
			testCaseId: "case-1",
		});

		expect(result.total).toBe(2);
		expect(result.items.map((source) => source.resultEventId)).toEqual([
			"event-new",
			"event-old",
		]);
		expect(result.items.map((source) => source.triggeredByActor)).toEqual([
			"Ada",
			"grace@example.com",
		]);
		expect(
			dbMock.testResultEvent.findMany.mock.calls[0][0].where,
		).toMatchObject({
			testCaseId: "case-1",
			pipelineRun: {
				projectId: "project-1",
				provider: "fabric-agentic",
			},
			agenticSteps: { some: {} },
		});
	});

	it("loads only the selected event inside the same project and case", async () => {
		dbMock.testResultEvent.findFirst.mockResolvedValue({
			id: "event-old",
			result: "FAILED",
			occurredAt: new Date("2026-07-27T12:00:00Z"),
			_count: { agenticSteps: 1 },
			pipelineRun: {
				agenticRuns: [
					{
						id: "run-old",
						triggeredByUser: {
							name: "Ada",
							email: "ada@example.com",
						},
					},
				],
			},
			agenticSteps: [
				{
					order: 0,
					action: "Submit",
					expected: "Dashboard",
					status: "FAILED",
					observation: "Stayed on sign-in",
				},
			],
		});

		const result = await getTestCaseAgentRunEvidence({
			projectId: "project-1",
			testCaseId: "case-1",
			resultEventId: "event-old",
		});

		expect(result?.steps[0]?.observation).toBe("Stayed on sign-in");
		expect(
			dbMock.testResultEvent.findFirst.mock.calls[0][0].where,
		).toMatchObject({
			id: "event-old",
			testCaseId: "case-1",
			pipelineRun: {
				projectId: "project-1",
				provider: "fabric-agentic",
			},
		});
	});
});

describe("test case script revision history", () => {
	it("returns newest-first author and provenance summaries with a total", async () => {
		dbMock.testCaseScriptRevision.findMany.mockResolvedValue([
			{
				id: "revision-2",
				origin: "REVERT",
				authorNameSnapshot: "Ada",
				authorEmailSnapshot: "ada@example.com",
				sourceResultEventId: null,
				restoredFromRevisionId: "revision-1",
				createdAt: new Date("2026-07-28T12:00:00Z"),
			},
		]);
		dbMock.testCaseScriptRevision.count.mockResolvedValue(2);

		const result = await listTestCaseScriptRevisions({
			projectId: "project-1",
			testCaseId: "case-1",
		});

		expect(result.total).toBe(2);
		expect(result.items[0]).toMatchObject({
			id: "revision-2",
			origin: "REVERT",
			author: "Ada",
			restoredFromRevisionId: "revision-1",
		});
		expect(
			dbMock.testCaseScriptRevision.findMany.mock.calls[0][0],
		).toMatchObject({
			where: { projectId: "project-1", testCaseId: "case-1" },
			orderBy: { createdAt: "desc" },
		});
	});
});
