import { createHash, randomUUID } from "node:crypto";
import {
	canEditProject,
	canUpdateOrganizationWorkflows,
	db,
	hasProjectAccess,
	type Prisma,
	recordAuditTx,
	writeWorkflowRunState,
} from "@repo/database";
import { evaluateContextQuality } from "@repo/rag/lib/context-quality";
import {
	gradeResultQuality,
	type ResultQualityChecks,
} from "@repo/utils/result-quality";
import { ZodError } from "zod";
import {
	applyWorkflowCheckSchema,
	checkIdentitySchema,
	inspectWorkflowResultSchema,
	previewWorkflowCheckSchema,
	removeWorkflowCheckSchema,
	type SavedWorkflowCheck,
	saveWorkflowCheckSchema,
	workflowCheckCollectionSchema,
} from "./result-check-contracts";
import {
	loadEditableWorkflow,
	loadReadableWorkflow,
	requireWritableProject,
	type WorkflowActor,
	WorkflowCommandError,
} from "./workflow-command-context";

const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, Prisma.JsonValue> =>
	value && typeof value === "object" && !Array.isArray(value)
		? { ...(value as Record<string, Prisma.JsonValue>) }
		: {};

import { WORKFLOW_RESULT_CHECKS_KEY as CHECKS_KEY } from "./protected-check-settings";

function readCases(
	settings: unknown,
	workflowId: string,
): SavedWorkflowCheck[] {
	const raw = object(settings)[CHECKS_KEY];
	if (raw === undefined) {
		return [];
	}
	const parsed = workflowCheckCollectionSchema.safeParse(raw);
	if (!parsed.success) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"Saved checks use an unsupported configuration. Update Fabric or contact your workspace owner. Existing checks were left unchanged.",
		);
	}
	return parsed.data.workflowId === workflowId ? parsed.data.cases : [];
}
async function readable(actor: WorkflowActor, workflowId: string) {
	const workflow = await loadReadableWorkflow(actor, workflowId);
	if (workflow.projectId) {
		const project = await db.project.findFirst({
			where: {
				id: workflow.projectId,
				organizationId: actor.organizationId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (
			!project ||
			!(await hasProjectAccess(
				workflow.projectId,
				actor.userId,
				actor.organizationId,
			))
		) {
			throw new WorkflowCommandError("NOT_FOUND", "Workflow not found");
		}
	}
	return workflow;
}
/** Exact server-loaded evidence. No model, retrieval, workflow or external service is invoked. */
export async function inspectWorkflowResult(
	actor: WorkflowActor,
	raw: unknown,
) {
	const input = inspectWorkflowResultSchema.parse(raw);
	await readable(actor, input.workflowId);
	return readRecordedResult(actor, input);
}
async function readRecordedResult(
	actor: WorkflowActor,
	input: { workflowId: string; executionId: string; nodeId: string },
) {
	const execution = await db.workflowExecution.findFirst({
		where: {
			id: input.executionId,
			workflowId: input.workflowId,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
		select: {
			id: true,
			status: true,
			version: true,
			completedAt: true,
			logs: {
				where: { nodeId: input.nodeId },
				orderBy: [{ startedAt: "desc" }, { id: "desc" }],
				take: 1,
				select: {
					status: true,
					output: true,
					nodeType: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
	if (!execution) {
		throw new WorkflowCommandError("NOT_FOUND", "Run not found");
	}
	const step = execution.logs[0];
	if (
		step &&
		((step.userId != null && step.userId !== actor.userId) ||
			(step.organizationId != null &&
				step.organizationId !== actor.organizationId))
	)
		throw new WorkflowCommandError("NOT_FOUND", "Step result not found");
	if (!step && execution.status === "COMPLETED")
		throw new WorkflowCommandError(
			"NOT_FOUND",
			"This step has no recorded result in the selected run.",
		);
	if (execution.status !== "COMPLETED" || step?.status !== "COMPLETED") {
		throw new WorkflowCommandError(
			"CONFLICT",
			"Choose a completed run and step before checking its result.",
		);
	}
	const output = step.output;
	const fields = object(output);
	const answer =
		typeof fields.markdown === "string"
			? fields.markdown
			: typeof fields.text === "string"
				? fields.text
				: typeof output === "string"
					? output
					: null;
	if (!answer?.trim() || answer.length > 16_384) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Choose a text result of at most 16,384 characters. Results are never shortened for scoring.",
		);
	}
	const origin = {
		workflowId: input.workflowId,
		executionId: execution.id,
		nodeId: input.nodeId,
		version: execution.version,
		completedAt: execution.completedAt?.toISOString() ?? null,
		outputHash: digest(answer),
	};
	return {
		...origin,
		revision: digest(origin),
		recordedAnswer: answer,
		mode: "recorded-workflow-result" as const,
		targetInvoked: false as const,
		retrievalEvidence: "not-evaluated" as const,
	};
}
function score(answer: string, expectations: ResultQualityChecks) {
	const requiredPhrases = [...new Set(expectations.requiredPhrases)];
	const forbiddenPhrases = [...new Set(expectations.forbiddenPhrases)];
	const quality = gradeResultQuality(answer, {
		requiredPhrases,
		forbiddenPhrases,
		...(expectations.version !== undefined
			? { version: expectations.version }
			: {}),
		...(expectations.jsonSchema
			? { jsonSchema: expectations.jsonSchema }
			: {}),
		...(expectations.jsonAssertions
			? { jsonAssertions: expectations.jsonAssertions }
			: {}),
		...(expectations.grounding
			? { grounding: expectations.grounding }
			: {}),
	});
	const expectationResults = [
		...requiredPhrases.map((phrase) => ({
			kind: "required" as const,
			phrase,
			passed: answer.includes(phrase),
		})),
		...forbiddenPhrases.map((phrase) => ({
			kind: "forbidden" as const,
			phrase,
			passed: !answer.includes(phrase),
		})),
	];
	if (expectations.version === 2)
		return {
			report: {
				...quality,
				status:
					quality.status === "NOT_ASSESSED"
						? ("not-assessed" as const)
						: quality.status === "PASSED"
							? ("passed" as const)
							: ("failed" as const),
			},
			quality,
			expectations: expectationResults,
		};
	let report: ReturnType<typeof evaluateContextQuality>;
	try {
		report = evaluateContextQuality({
			version: 1,
			sources: [],
			cases: [
				{
					id: "recorded-workflow-result",
					recordedAnswer: answer,
					retrievedSourceIds: [],
					citedSourceIds: [],
					expectations: {
						expectedSourceIds: [],
						requiredPhrases,
						forbiddenPhrases,
					},
				},
			],
		});
	} catch (error) {
		if (error instanceof ZodError)
			throw new WorkflowCommandError(
				"BAD_REQUEST",
				"The recorded answer and phrases exceed the check limits. Use fewer or shorter phrases.",
			);
		throw error;
	}

	return { report, expectations: expectationResults };
}
export async function previewWorkflowCheck(actor: WorkflowActor, raw: unknown) {
	const input = previewWorkflowCheckSchema.parse(raw);
	const current = await inspectWorkflowResult(actor, {
		workflowId: input.workflowId,
		executionId: input.executionId,
		nodeId: input.nodeId,
	});
	if (current.revision !== input.expectedRevision) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The result changed. Inspect it again before checking.",
		);
	}
	const result = score(current.recordedAnswer, input);
	const final = await inspectWorkflowResult(actor, {
		workflowId: input.workflowId,
		executionId: input.executionId,
		nodeId: input.nodeId,
	});
	if (final.revision !== current.revision) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The result changed while checking. Inspect it again.",
		);
	}
	return {
		...result,
		origin: { ...final, recordedAnswer: undefined },
		saved: false as const,
	};
}
export async function listWorkflowChecks(actor: WorkflowActor, raw: unknown) {
	const { workflowId } = checkIdentitySchema.parse(raw);
	const workflow = await readable(actor, workflowId);
	return {
		cases: readCases(workflow.settings, workflowId),
		canManage:
			(await canUpdateOrganizationWorkflows(
				actor.userId,
				actor.organizationId,
			)) &&
			(!workflow.projectId ||
				(await canEditProject(workflow.projectId, actor.userId))),
	};
}
async function mutateCases(
	actor: WorkflowActor,
	workflowId: string,
	change: (cases: SavedWorkflowCheck[]) => {
		cases: SavedWorkflowCheck[];
		result: SavedWorkflowCheck;
		operation: "created" | "removed";
		changed: boolean;
	},
) {
	const workflow = await loadEditableWorkflow(actor, workflowId, "edit");
	if (workflow.projectId) {
		await requireWritableProject(actor, workflow.projectId);
	}
	return db.$transaction(async (tx) => {
		// Runtime writers take the same row lock. Re-read after locking; never overwrite their frame/failure state.
		await tx.$queryRaw`SELECT id FROM workflow WHERE id=${workflowId} AND "userId"=${actor.userId} AND "organizationId"=${actor.organizationId} FOR UPDATE`;
		const current = await tx.workflow.findFirst({
			where: {
				id: workflowId,
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
			select: { settings: true, projectId: true },
		});
		if (!current || current.projectId !== workflow.projectId) {
			throw new WorkflowCommandError(
				"CONFLICT",
				"The workflow changed. Refresh before saving a check.",
			);
		}
		if (
			current.settings !== null &&
			(typeof current.settings !== "object" ||
				Array.isArray(current.settings))
		)
			throw new WorkflowCommandError(
				"CONFLICT",
				"Workflow settings need review before saving checks. Existing settings were left unchanged.",
			);
		const changed = change(readCases(current.settings, workflowId));
		if (!changed.changed) {
			return changed.result;
		}
		const collection = workflowCheckCollectionSchema.parse({
			version: 1,
			workflowId,
			cases: changed.cases,
		});
		const settings = {
			...object(current.settings),
			[CHECKS_KEY]: collection,
		};
		if (Buffer.byteLength(JSON.stringify(settings), "utf8") > 128 * 1024) {
			throw new WorkflowCommandError(
				"BAD_REQUEST",
				"Saved workflow settings exceed 128 KiB. Remove unused checks first.",
			);
		}
		await writeWorkflowRunState(tx, {
			workflowId,
			organizationId: actor.organizationId,
			settings,
		});
		await recordAuditTx(tx, {
			action: `activity.workflows.checks.${changed.operation}`,
			actor: { type: "user", userId: actor.userId },
			organizationId: actor.organizationId,
			resource: { type: "workflow", id: workflowId },
			metadata: { checkId: changed.result.id },
		});
		return changed.result;
	});
}
function definitionHash(
	check: Pick<
		SavedWorkflowCheck,
		| "name"
		| "nodeId"
		| "baselineExecutionId"
		| "baselineVersion"
		| "baselineRevision"
		| "requiredPhrases"
		| "forbiddenPhrases"
		| "version"
		| "jsonSchema"
		| "jsonAssertions"
		| "grounding"
	>,
) {
	return digest({
		name: check.name,
		nodeId: check.nodeId,
		baselineExecutionId: check.baselineExecutionId,
		baselineVersion: check.baselineVersion,
		baselineRevision: check.baselineRevision,
		requiredPhrases: check.requiredPhrases,
		forbiddenPhrases: check.forbiddenPhrases,
		...(check.version !== undefined ? { version: check.version } : {}),
		...(check.jsonSchema ? { jsonSchema: check.jsonSchema } : {}),
		...(check.jsonAssertions
			? { jsonAssertions: check.jsonAssertions }
			: {}),
		...(check.grounding ? { grounding: check.grounding } : {}),
	});
}
export async function saveWorkflowCheck(actor: WorkflowActor, raw: unknown) {
	const input = saveWorkflowCheckSchema.parse(raw);
	const evaluated = await previewWorkflowCheck(actor, {
		workflowId: input.workflowId,
		executionId: input.executionId,
		nodeId: input.nodeId,
		expectedRevision: input.expectedRevision,
		requiredPhrases: input.requiredPhrases,
		forbiddenPhrases: input.forbiddenPhrases,
		...(input.version !== undefined ? { version: input.version } : {}),
		...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
		...(input.jsonAssertions
			? { jsonAssertions: input.jsonAssertions }
			: {}),
		...(input.grounding ? { grounding: input.grounding } : {}),
	});
	if (evaluated.report.status !== "passed") {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Adjust the expectations until this baseline result passes before saving the check.",
		);
	}
	const content = {
		name: input.name,
		nodeId: input.nodeId,
		baselineExecutionId: input.executionId,
		baselineVersion: evaluated.origin.version,
		baselineRevision: input.expectedRevision,
		requiredPhrases: [...new Set(input.requiredPhrases)],
		forbiddenPhrases: [...new Set(input.forbiddenPhrases)],
		...(input.version !== undefined ? { version: input.version } : {}),
		...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
		...(input.jsonAssertions
			? { jsonAssertions: input.jsonAssertions }
			: {}),
		...(input.grounding ? { grounding: input.grounding } : {}),
	};
	const fingerprint = definitionHash(content);
	return {
		check: await mutateCases(actor, input.workflowId, (cases) => {
			const existing = cases.find(
				(c) => definitionHash(c) === fingerprint,
			);
			if (existing) {
				return {
					cases,
					result: existing,
					operation: "created",
					changed: false,
				};
			}
			if (cases.length >= 20) {
				throw new WorkflowCommandError(
					"BAD_REQUEST",
					"A workflow can have up to 20 saved checks. Remove an unused check first.",
				);
			}
			const id = `check_${randomUUID()}`;
			const createdAt = new Date().toISOString();
			const check = {
				...content,
				id,
				createdAt,
				revision: digest({ id, content, createdAt }),
			};
			return {
				cases: [...cases, check],
				result: check,
				operation: "created",
				changed: true,
			};
		}),
	};
}
export async function applyWorkflowCheck(actor: WorkflowActor, raw: unknown) {
	const input = applyWorkflowCheckSchema.parse(raw);
	const workflow = await readable(actor, input.workflowId);
	const cases = readCases(workflow.settings, input.workflowId);
	const check = cases.find((c) => c.id === input.checkId);
	if (!check) {
		throw new WorkflowCommandError("NOT_FOUND", "Saved check not found");
	}
	if (check.revision !== input.expectedCaseRevision) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The check changed. Select it again.",
		);
	}
	const [baseline, candidate] = await Promise.all([
		readRecordedResult(actor, {
			workflowId: input.workflowId,
			executionId: check.baselineExecutionId,
			nodeId: check.nodeId,
		}),
		readRecordedResult(actor, {
			workflowId: input.workflowId,
			executionId: input.executionId,
			nodeId: check.nodeId,
		}),
	]);
	if (baseline.revision !== check.baselineRevision) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The baseline result changed. Save a new check before comparing.",
		);
	}
	const baselineScore = score(baseline.recordedAnswer, check);
	const candidateScore = score(candidate.recordedAnswer, check);
	// Recheck current case and evidence after scoring; a deleted/revoked source cannot be presented as current.
	const finalWorkflow = await readable(actor, input.workflowId);
	const final = {
		cases: readCases(finalWorkflow.settings, input.workflowId),
	};
	if (
		!final.cases.some(
			(c) => c.id === check.id && c.revision === check.revision,
		)
	) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The saved check was removed while comparing.",
		);
	}
	const [reloaded, finalBaseline] = await Promise.all([
		readRecordedResult(actor, {
			workflowId: input.workflowId,
			executionId: input.executionId,
			nodeId: check.nodeId,
		}),
		readRecordedResult(actor, {
			workflowId: input.workflowId,
			executionId: check.baselineExecutionId,
			nodeId: check.nodeId,
		}),
	]);
	if (
		reloaded.revision !== candidate.revision ||
		finalBaseline.revision !== baseline.revision
	) {
		throw new WorkflowCommandError(
			"CONFLICT",
			"The result changed while comparing.",
		);
	}
	return {
		check,
		baseline: {
			executionId: baseline.executionId,
			version: baseline.version,
			status: baselineScore.report.status,
		},
		candidate: {
			executionId: candidate.executionId,
			version: candidate.version,
			...candidateScore,
		},
		change:
			baselineScore.report.status === candidateScore.report.status
				? ("unchanged" as const)
				: candidateScore.report.status === "passed"
					? ("improved" as const)
					: ("regressed" as const),
		targetInvoked: false as const,
		retrievalEvidence: "not-evaluated" as const,
	};
}
export async function removeWorkflowCheck(actor: WorkflowActor, raw: unknown) {
	const input = removeWorkflowCheckSchema.parse(raw);
	await mutateCases(actor, input.workflowId, (cases) => {
		const check = cases.find((c) => c.id === input.checkId);
		if (!check) {
			throw new WorkflowCommandError(
				"NOT_FOUND",
				"Saved check not found",
			);
		}
		if (check.revision !== input.expectedCaseRevision) {
			throw new WorkflowCommandError(
				"CONFLICT",
				"The check changed. Refresh before removing it.",
			);
		}
		return {
			cases: cases.filter((c) => c.id !== check.id),
			result: check,
			operation: "removed",
			changed: true,
		};
	});
	return { removed: true as const };
}
