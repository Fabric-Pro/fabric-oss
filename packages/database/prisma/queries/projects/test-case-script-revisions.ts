import type {
	AgenticStepStatus,
	Prisma,
	TestCaseScriptRevisionOrigin,
	TestResult,
} from "../../client";
import { db } from "../../client";
import { AGENTIC_RUN_PROVIDER } from "./agentic-runs";

export interface TestCaseAgentRunSource {
	resultEventId: string;
	runId: string | null;
	result: TestResult;
	occurredAt: Date;
	stepCount: number;
	triggeredByActor: string | null;
}

const sourceRunSelect = {
	id: true,
	result: true,
	occurredAt: true,
	_count: { select: { agenticSteps: true } },
	pipelineRun: {
		select: {
			agenticRuns: {
				where: { runMode: "MODE_A" as const },
				orderBy: { createdAt: "desc" as const },
				take: 1,
				select: {
					id: true,
					triggeredByUser: {
						select: { name: true, email: true },
					},
				},
			},
		},
	},
} as const;

type SourceRunRow = Prisma.TestResultEventGetPayload<{
	select: typeof sourceRunSelect;
}>;

function sourceRunActor(row: SourceRunRow): string | null {
	const user = row.pipelineRun?.agenticRuns[0]?.triggeredByUser;
	return user?.name?.trim() || user?.email || null;
}

/**
 * Historical Mode A executions available as script-generation evidence.
 *
 * Result events are append-only, so this intentionally exposes more than the
 * latest run. A user can select the run whose observed flow they want to turn
 * into a reusable script even after newer runs have happened.
 */
export async function listTestCaseAgentRunSources(input: {
	projectId: string;
	testCaseId: string;
	limit?: number;
	offset?: number;
}): Promise<{ items: TestCaseAgentRunSource[]; total: number }> {
	const where = {
		testCaseId: input.testCaseId,
		pipelineRun: {
			projectId: input.projectId,
			provider: AGENTIC_RUN_PROVIDER,
			agenticRuns: {
				some: { runMode: "MODE_A" as const },
			},
		},
		agenticSteps: { some: {} },
	};
	const [rows, total] = await db.$transaction([
		db.testResultEvent.findMany({
			where,
			orderBy: { occurredAt: "desc" },
			take: Math.min(input.limit ?? 25, 100),
			skip: input.offset ?? 0,
			select: sourceRunSelect,
		}),
		db.testResultEvent.count({ where }),
	]);

	return {
		items: rows.map((row) => ({
			resultEventId: row.id,
			runId: row.pipelineRun?.agenticRuns[0]?.id ?? null,
			result: row.result,
			occurredAt: row.occurredAt,
			stepCount: row._count.agenticSteps,
			triggeredByActor: sourceRunActor(row),
		})),
		total,
	};
}

export interface TestCaseAgentRunEvidence {
	resultEventId: string;
	result: TestResult;
	occurredAt: Date;
	triggeredByActor: string | null;
	steps: Array<{
		order: number;
		action: string;
		expected: string;
		status: AgenticStepStatus;
		observation: string | null;
	}>;
}

/**
 * Resolve one selected historical run, or the newest eligible run when no id
 * was supplied. The project and case predicates prevent a result id copied from
 * another project from becoming prompt context.
 */
export async function getTestCaseAgentRunEvidence(input: {
	projectId: string;
	testCaseId: string;
	resultEventId?: string;
}): Promise<TestCaseAgentRunEvidence | null> {
	const row = await db.testResultEvent.findFirst({
		where: {
			...(input.resultEventId ? { id: input.resultEventId } : {}),
			testCaseId: input.testCaseId,
			pipelineRun: {
				projectId: input.projectId,
				provider: AGENTIC_RUN_PROVIDER,
				agenticRuns: {
					some: { runMode: "MODE_A" },
				},
			},
			agenticSteps: { some: {} },
		},
		orderBy: { occurredAt: "desc" },
		select: {
			...sourceRunSelect,
			agenticSteps: {
				orderBy: { order: "asc" },
				select: {
					order: true,
					action: true,
					expected: true,
					status: true,
					observation: true,
				},
			},
		},
	});
	if (!row) {
		return null;
	}
	return {
		resultEventId: row.id,
		result: row.result,
		occurredAt: row.occurredAt,
		triggeredByActor: sourceRunActor(row),
		steps: row.agenticSteps,
	};
}

export interface TestCaseScriptRevisionSummary {
	id: string;
	origin: TestCaseScriptRevisionOrigin;
	author: string | null;
	sourceResultEventId: string | null;
	restoredFromRevisionId: string | null;
	createdAt: Date;
}

const revisionSummarySelect = {
	id: true,
	origin: true,
	authorNameSnapshot: true,
	authorEmailSnapshot: true,
	sourceResultEventId: true,
	restoredFromRevisionId: true,
	createdAt: true,
} as const;

export async function listTestCaseScriptRevisions(input: {
	projectId: string;
	testCaseId: string;
	limit?: number;
	offset?: number;
}): Promise<{ items: TestCaseScriptRevisionSummary[]; total: number }> {
	const where = {
		projectId: input.projectId,
		testCaseId: input.testCaseId,
	};
	const [rows, total] = await db.$transaction([
		db.testCaseScriptRevision.findMany({
			where,
			orderBy: { createdAt: "desc" },
			take: Math.min(input.limit ?? 20, 100),
			skip: input.offset ?? 0,
			select: revisionSummarySelect,
		}),
		db.testCaseScriptRevision.count({ where }),
	]);
	return {
		items: rows.map((row) => ({
			id: row.id,
			origin: row.origin,
			author:
				row.authorNameSnapshot?.trim() ||
				row.authorEmailSnapshot ||
				null,
			sourceResultEventId: row.sourceResultEventId,
			restoredFromRevisionId: row.restoredFromRevisionId,
			createdAt: row.createdAt,
		})),
		total,
	};
}

export async function getTestCaseScriptRevision(input: {
	projectId: string;
	testCaseId: string;
	revisionId: string;
}): Promise<{
	id: string;
	script: string;
	origin: TestCaseScriptRevisionOrigin;
	createdAt: Date;
} | null> {
	return db.testCaseScriptRevision.findFirst({
		where: {
			id: input.revisionId,
			projectId: input.projectId,
			testCaseId: input.testCaseId,
		},
		select: {
			id: true,
			script: true,
			origin: true,
			createdAt: true,
		},
	});
}
