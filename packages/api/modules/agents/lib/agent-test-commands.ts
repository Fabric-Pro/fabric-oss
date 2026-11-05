import { createHash } from "node:crypto";
import { canExecuteOrganizationAgents, db, Prisma } from "@repo/database";
import {
	assertAgentTestSourceScope,
	boundAgentTest,
	loadAgentTestScope,
} from "@repo/temporal/agent-test-access";
import {
	AGENT_TEST_WORKFLOW,
	type AgentTestActor,
	type AgentTestCaseSummary,
	AgentTestError,
	type AgentTestRunSummary,
	type AgentTestScope,
	agentTestCaseArchiveSchema,
	agentTestCaseCreateSchema,
	agentTestCaseListSchema,
	agentTestCaseUpdateSchema,
	agentTestChecksSchema,
	agentTestCompareSchema,
	agentTestReportSchema,
	agentTestRunIdentitySchema,
	agentTestRunListSchema,
	agentTestRunStartSchema,
	agentTestScopeSchema,
} from "@repo/temporal/agent-test-contracts";
import { getTemporalClient } from "@repo/temporal/client";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { cancelAgentRunCommand } from "../../agent-deployments/lib/run-commands";
import { executeAgentForActor } from "../../external-api/procedures/execute-agent";
import { getCompletedAgentPreviewTestSource } from "./agent-preview-commands";

export type AgentTestAudit = (event: RecordAuditFromRequestInput) => unknown;
export type AgentTestSelectionPolicy = (scope: AgentTestScope) => unknown;
const digest = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
type CaseRow = NonNullable<
	Awaited<ReturnType<typeof db.agentTestCase.findFirst>>
>;
type RunRow = NonNullable<
	Awaited<ReturnType<typeof db.agentTestRun.findFirst>>
>;
const json = (v: unknown) => v as Prisma.InputJsonValue;
async function executing(actor: AgentTestActor) {
	if (
		!actor.organizationId ||
		!actor.userId ||
		!(await canExecuteOrganizationAgents(
			actor.userId,
			actor.organizationId,
		))
	) {
		throw new AgentTestError(
			"FORBIDDEN",
			"Your current role does not allow managing or running agent tests.",
		);
	}
}
async function sources(
	actor: AgentTestActor,
	raw: unknown,
	policy?: AgentTestSelectionPolicy,
) {
	const scope = await assertAgentTestSourceScope(actor, raw);
	await policy?.(scope);
	return scope;
}
async function testcase(
	actor: AgentTestActor,
	id: string,
	policy?: AgentTestSelectionPolicy,
) {
	const row = await db.agentTestCase.findFirst({
		where: {
			id,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
	});
	if (!row) {
		throw new AgentTestError(
			"NOT_FOUND",
			"Test case not found or access denied.",
		);
	}
	await sources(actor, row.sourceScopeJson, policy);
	return row;
}
async function testrun(
	actor: AgentTestActor,
	id: string,
	policy?: AgentTestSelectionPolicy,
) {
	const row = await db.agentTestRun.findFirst({
		where: {
			id,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
	});
	if (!row) {
		throw new AgentTestError(
			"NOT_FOUND",
			"Test run not found or access denied.",
		);
	}
	const scopes = row.sourceScopeJson as {
		origin: unknown;
		execution: unknown;
	};
	await sources(actor, scopes.origin, policy);
	await sources(actor, scopes.execution, policy);
	return row;
}
async function runSummary(
	actor: AgentTestActor,
	originalRow: RunRow,
	policy?: AgentTestSelectionPolicy,
): Promise<AgentTestRunSummary> {
	let row = await testrun(actor, originalRow.id, policy);
	let observedStatus: AgentTestRunSummary["status"] =
		row.status as AgentTestRunSummary["status"];
	let observedError = row.errorCode;
	if (row.status === "RUNNING" && !row.evaluationRunId) {
		observedStatus = "ADMITTING";
		observedError = "ASSESSMENT_UNCONFIRMED";
	} else if (row.status === "RUNNING") {
		try {
			const client = await getTemporalClient();
			const description = await client.workflow
				.getHandle(
					row.evaluationWorkflowId,
					row.evaluationRunId ?? undefined,
					{ followRuns: false },
				)
				.describe();
			const memo = description.memo?.fabricAgentTest as
				| Record<string, unknown>
				| undefined;
			if (
				description.type !== AGENT_TEST_WORKFLOW ||
				(row.evaluationRunId &&
					description.runId !== row.evaluationRunId) ||
				memo?.testRunId !== row.id ||
				memo?.userId !== actor.userId ||
				memo?.organizationId !== actor.organizationId ||
				memo?.requestHash !== row.requestHash
			) {
				throw new Error("Assessment identity mismatch");
			}
			if (
				description.status?.name &&
				description.status.name !== "RUNNING"
			) {
				row = await testrun(actor, row.id, policy);
				observedStatus = row.status as AgentTestRunSummary["status"];
				if (row.status === "RUNNING") {
					observedStatus = "ERROR";
					observedError = "ASSESSMENT_UNAVAILABLE";
				}
			}
		} catch (error) {
			if (
				error instanceof AgentTestError &&
				["NOT_FOUND", "FORBIDDEN"].includes(error.code)
			) {
				throw error;
			}
			// Preserve only authorized opaque recovery metadata when the observer cannot
			// be confirmed. Never hide the request key or release an unverified report.
			observedStatus = "ADMITTING";
			observedError = "ASSESSMENT_UNCONFIRMED";
		}
	}
	return {
		id: row.id,
		requestKey: row.requestKey,
		caseId: row.caseId,
		instanceId: row.instanceId,
		agentVersion: row.agentVersion,
		caseRevision: row.caseRevision,
		status: observedStatus,
		verdict:
			observedStatus === "COMPLETED" && row.executionId
				? (row.verdict as AgentTestRunSummary["verdict"])
				: null,
		executionId: row.executionId,
		errorCode: observedError,
		report:
			observedStatus === "COMPLETED" && row.executionId && row.reportJson
				? agentTestReportSchema.parse(row.reportJson)
				: null,
		createdAt: row.createdAt.toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null,
	};
}
async function caseSummary(
	actor: AgentTestActor,
	row: CaseRow,
	policy?: AgentTestSelectionPolicy,
): Promise<AgentTestCaseSummary> {
	const latest = await db.agentTestRun.findFirst({
		where: {
			caseId: row.id,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
	});
	let latestRun: AgentTestRunSummary | null = null;
	if (latest) {
		try {
			latestRun = await runSummary(actor, latest, policy);
		} catch (error) {
			if (
				!(error instanceof AgentTestError) ||
				!["NOT_FOUND", "FORBIDDEN"].includes(error.code)
			) {
				throw error;
			}
		}
	}
	await sources(actor, row.sourceScopeJson, policy);
	return {
		id: row.id,
		agentSId: row.agentSId,
		originInstanceId: row.originInstanceId,
		name: row.name,
		input: row.input,
		checks: agentTestChecksSchema.parse(row.checksJson),
		revision: row.revision,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		latestRun,
	};
}
export async function listAgentTestCasesCommand(
	actor: AgentTestActor,
	raw: unknown,
	policy?: AgentTestSelectionPolicy,
) {
	const input = agentTestCaseListSchema.parse(raw);
	const target = await loadAgentTestScope(actor, input.instanceId);
	await policy?.(target.scope);
	if (input.cursor) {
		const c = await db.agentTestCase.findFirst({
			where: {
				id: input.cursor,
				userId: actor.userId,
				organizationId: actor.organizationId,
				agentSId: target.instance.sId,
			},
		});
		if (!c) {
			throw new AgentTestError(
				"BAD_REQUEST",
				"Use a cursor from this agent's test cases.",
			);
		}
	}
	const rows = await db.agentTestCase.findMany({
		where: {
			userId: actor.userId,
			organizationId: actor.organizationId,
			agentSId: target.instance.sId,
			archivedAt: null,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: input.limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});
	const page = rows.slice(0, input.limit);
	const cases: AgentTestCaseSummary[] = [];
	for (const row of page) {
		try {
			cases.push(await caseSummary(actor, row, policy));
		} catch (error) {
			if (
				!(error instanceof AgentTestError) ||
				!["NOT_FOUND", "FORBIDDEN"].includes(error.code)
			) {
				throw error;
			}
		}
	}
	await sources(actor, target.scope, policy);
	return {
		cases,
		nextCursor:
			rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
	};
}
export async function createAgentTestCaseCommand(
	actor: AgentTestActor,
	raw: unknown,
	audit: AgentTestAudit,
	policy?: AgentTestSelectionPolicy,
) {
	await executing(actor);
	boundAgentTest(raw);
	const input = agentTestCaseCreateSchema.parse(raw);
	const target = await loadAgentTestScope(actor, input.instanceId);
	await policy?.(target.scope);
	boundAgentTest({ ...input, scope: target.scope });
	if (input.sourcePreview) {
		const draft = await getCompletedAgentPreviewTestSource(
			actor,
			input.sourcePreview,
			policy
				? (draft) =>
						policy({
							...target.scope,
							workspaceIds: draft.workspaceIds,
							skillIds: draft.skillIds,
						})
				: undefined,
		);
		const selections = (value: {
			projectId?: string;
			workspaceIds: string[];
			workspaceDocumentFilters: {
				workspaceId: string;
				documentIds: string[];
			}[];
			skillIds: string[];
		}) => ({
			projectId: value.projectId ?? null,
			workspaceIds: [...value.workspaceIds].sort(),
			workspaceDocumentFilters: value.workspaceDocumentFilters
				.filter((x) => value.workspaceIds.includes(x.workspaceId))
				.map((x) => ({
					workspaceId: x.workspaceId,
					documentIds: [...x.documentIds].sort(),
				}))
				.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
			skillIds: [...value.skillIds].sort(),
		});
		if (
			draft.instanceId !== target.instance.id ||
			digest(selections(draft)) !== digest(selections(target.scope))
		) {
			throw new AgentTestError(
				"CONFLICT",
				"Save your knowledge and access changes, then preview again before saving this test. Tests run the saved version.",
			);
		}
	}
	if (
		(await db.agentTestCase.count({
			where: {
				userId: actor.userId,
				organizationId: actor.organizationId,
				agentSId: target.instance.sId,
				archivedAt: null,
			},
		})) >= 100
	) {
		throw new AgentTestError(
			"BAD_REQUEST",
			"Archive an unused test before adding more than 100 cases for this agent.",
		);
	}
	const row = await db.agentTestCase.create({
		data: {
			userId: actor.userId,
			organizationId: actor.organizationId,
			originInstanceId: target.instance.id,
			agentSId: target.instance.sId,
			name: input.name,
			input: input.input,
			checksJson: json(input.checks),
			sourceScopeJson: json(target.scope),
		},
	});
	await audit({
		action: "org.agent_test_case.created",
		organizationId: actor.organizationId,
		resource: { type: "agent_test_case", id: row.id },
		metadata: { instanceId: target.instance.id, revision: row.revision },
	});
	return caseSummary(actor, row, policy);
}
export async function updateAgentTestCaseCommand(
	actor: AgentTestActor,
	raw: unknown,
	audit: AgentTestAudit,
	policy?: AgentTestSelectionPolicy,
) {
	await executing(actor);
	boundAgentTest(raw);
	const input = agentTestCaseUpdateSchema.parse(raw);
	await testcase(actor, input.caseId, policy);
	const changed = await db.agentTestCase.updateMany({
		where: {
			id: input.caseId,
			userId: actor.userId,
			organizationId: actor.organizationId,
			revision: input.revision,
			archivedAt: null,
		},
		data: {
			name: input.name,
			input: input.input,
			checksJson: json(input.checks),
			revision: { increment: 1 },
		},
	});
	if (!changed.count) {
		throw new AgentTestError(
			"CONFLICT",
			"This test changed. Reload it before saving your edits.",
		);
	}
	await audit({
		action: "org.agent_test_case.updated",
		organizationId: actor.organizationId,
		resource: { type: "agent_test_case", id: input.caseId },
		metadata: { revision: input.revision + 1 },
	});
	return caseSummary(
		actor,
		await testcase(actor, input.caseId, policy),
		policy,
	);
}
export async function archiveAgentTestCaseCommand(
	actor: AgentTestActor,
	raw: unknown,
	audit: AgentTestAudit,
	policy?: AgentTestSelectionPolicy,
) {
	await executing(actor);
	const input = agentTestCaseArchiveSchema.parse(raw);
	await testcase(actor, input.caseId, policy);
	const changed = await db.agentTestCase.updateMany({
		where: {
			id: input.caseId,
			userId: actor.userId,
			organizationId: actor.organizationId,
			revision: input.revision,
			archivedAt: null,
		},
		data: { archivedAt: new Date(), revision: { increment: 1 } },
	});
	if (!changed.count) {
		throw new AgentTestError(
			"CONFLICT",
			"This test changed. Reload it before archiving it.",
		);
	}
	await audit({
		action: "org.agent_test_case.archived",
		organizationId: actor.organizationId,
		resource: { type: "agent_test_case", id: input.caseId },
		metadata: { revision: input.revision },
	});
	return { archived: true as const };
}
async function startAssessment(actor: AgentTestActor, row: RunRow) {
	const client = await getTemporalClient();
	const memo = {
		version: 1,
		userId: actor.userId,
		organizationId: actor.organizationId,
		testRunId: row.id,
		requestHash: row.requestHash,
	};
	try {
		try {
			await client.workflow.start(
				AGENT_TEST_WORKFLOW,
				withCorrelationMemo({
					workflowId: row.evaluationWorkflowId,
					taskQueue: "agents",
					workflowExecutionTimeout: "45 minutes",
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					workflowIdConflictPolicy: "USE_EXISTING",
					memo: { fabricAgentTest: memo },
					args: [
						{
							testRunId: row.id,
							userId: actor.userId,
							organizationId: actor.organizationId,
						},
					],
				}),
			);
		} catch {
			// A lost acknowledgement may leave a running or already-completed observer.
			// Only the exact verified memo below is acceptable recovery evidence.
		}
		const description = await client.workflow
			.getHandle(
				row.evaluationWorkflowId,
				row.evaluationRunId ?? undefined,
				{ followRuns: false },
			)
			.describe();
		const observed = description.memo?.fabricAgentTest as
			| Record<string, unknown>
			| undefined;
		if (
			description.type !== AGENT_TEST_WORKFLOW ||
			(row.evaluationRunId !== null &&
				description.runId !== row.evaluationRunId) ||
			!observed ||
			Object.entries(memo).some(([k, v]) => observed[k] !== v)
		) {
			throw new Error("Test assessment identity mismatch");
		}
		await db.agentTestRun.updateMany({
			where: {
				id: row.id,
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
			data: { evaluationRunId: description.runId },
		});
	} catch {
		throw new AgentTestError(
			"SERVICE_UNAVAILABLE",
			"The agent run was accepted, but its test assessment could not be confirmed. Retry with the same request key to reconnect.",
		);
	}
}
export async function startAgentTestRunCommand(
	actor: AgentTestActor,
	raw: unknown,
	audit: AgentTestAudit,
	policy?: AgentTestSelectionPolicy,
) {
	await executing(actor);
	const input = agentTestRunStartSchema.parse(raw);
	const requestHash = digest(input);
	const test = await testcase(actor, input.caseId, policy);
	const target = await loadAgentTestScope(actor, input.instanceId);
	await policy?.(target.scope);
	if (target.instance.sId !== test.agentSId) {
		throw new AgentTestError(
			"BAD_REQUEST",
			"Choose a version of the same agent for this test.",
		);
	}
	const id = `agt-${digest([actor.organizationId, actor.userId, input.idempotencyKey])}`;
	let row = await db.agentTestRun.findFirst({
		where: {
			organizationId: actor.organizationId,
			userId: actor.userId,
			requestKey: input.idempotencyKey,
		},
	});
	if (row && row.requestHash !== requestHash) {
		throw new AgentTestError(
			"CONFLICT",
			"This request key belongs to a different test. Use a new key for a new test run.",
		);
	}
	if (!row) {
		// Serialize only the short test-case reservation. Native execution remains
		// outside the transaction and is owned by its existing Temporal admission.
		row = await db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`agent-test:${id}`}, 0))) AS admission_lock`;
			const existing = await tx.agentTestRun.findFirst({
				where: {
					id,
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
			});
			if (existing) {
				if (existing.requestHash !== requestHash) {
					throw new AgentTestError(
						"CONFLICT",
						"This request key belongs to another test.",
					);
				}
				return existing;
			}
			const current = await tx.agentTestCase.findFirst({
				where: {
					id: input.caseId,
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
			});
			if (
				!current ||
				current.archivedAt ||
				current.revision !== input.caseRevision ||
				current.agentSId !== target.instance.sId
			) {
				throw new AgentTestError(
					"CONFLICT",
					"This test changed. Reload it before starting a new run.",
					{ admission: "NOT_STARTED" },
				);
			}
			const scope = {
				origin: current.sourceScopeJson,
				execution: target.scope,
			};
			boundAgentTest({
				input: current.input,
				checks: current.checksJson,
				scope,
			});
			return tx.agentTestRun.upsert({
				where: { id },
				update: {},
				create: {
					id,
					userId: actor.userId,
					organizationId: actor.organizationId,
					caseId: current.id,
					instanceId: target.instance.id,
					agentSId: current.agentSId,
					agentVersion: target.instance.version,
					caseRevision: current.revision,
					caseInput: current.input,
					checksJson: json(current.checksJson),
					sourceScopeJson: json(scope),
					requestKey: input.idempotencyKey,
					requestHash,
					evaluationWorkflowId: `agent-test-${id}`,
				},
			});
		});
	}

	row = await testrun(actor, row.id, policy);
	if (["COMPLETED", "CANCELLED", "ERROR"].includes(row.status)) {
		return runSummary(actor, row, policy);
	}
	if (!row.executionId) {
		const frozen = row.sourceScopeJson as {
			origin: unknown;
			execution: unknown;
		};
		const executionScope = agentTestScopeSchema.parse(frozen.execution);
		if (!executionScope.configHash) {
			throw new AgentTestError(
				"CONFLICT",
				"This test has no frozen configuration. Start a new test run.",
			);
		}
		const testAuthority = {
			testRunId: row.id,
			origin: agentTestScopeSchema.parse(frozen.origin),
			execution: {
				...executionScope,
				configHash: executionScope.configHash,
			},
		};
		const started = await executeAgentForActor(
			row.instanceId,
			{
				input: { message: row.caseInput },
				idempotencyKey: `agent-test-${row.id}`,
			},
			actor,
			{
				requireApiExposure: actor.external === true,
				testAuthority,
				actor: {
					type: actor.external ? "api_key" : "user",
					userId: actor.userId,
				},
			},
		);
		if (started.error !== undefined) {
			const code =
				started.status === 403
					? "FORBIDDEN"
					: started.status === 404
						? "NOT_FOUND"
						: started.status === 409
							? "CONFLICT"
							: started.status === 503
								? "SERVICE_UNAVAILABLE"
								: "BAD_REQUEST";
			throw new AgentTestError(
				code,
				typeof started.error === "string"
					? started.error
					: started.error.message,
			);
		}
		if (!started.data.workflowId || !started.data.runId) {
			throw new AgentTestError(
				"SERVICE_UNAVAILABLE",
				"The saved-agent run is still being confirmed. Retry with the same request key.",
			);
		}
		await db.agentTestRun.updateMany({
			where: {
				id: row.id,
				userId: actor.userId,
				organizationId: actor.organizationId,
				status: "ADMITTING",
				executionId: null,
			},
			data: {
				executionId: started.data.executionId,
				nativeWorkflowId: started.data.workflowId,
				nativeRunId: started.data.runId,
				status: "RUNNING",
			},
		});
		row = await testrun(actor, row.id, policy);
		if (["COMPLETED", "CANCELLED", "ERROR"].includes(row.status)) {
			return runSummary(actor, row, policy);
		}
		if (
			row.executionId !== started.data.executionId ||
			row.nativeWorkflowId !== started.data.workflowId ||
			row.nativeRunId !== started.data.runId
		) {
			throw new AgentTestError(
				"CONFLICT",
				"The native execution receipt does not match this test. Inspect its existing run before retrying.",
			);
		}
	}
	await startAssessment(actor, row);
	await audit({
		action: "org.agent_test.started",
		organizationId: actor.organizationId,
		resource: { type: "agent_test_run", id: row.id },
		metadata: {
			instanceId: row.instanceId,
			caseId: row.caseId,
			caseRevision: row.caseRevision,
			agentVersion: row.agentVersion,
		},
	});
	return runSummary(actor, await testrun(actor, row.id, policy), policy);
}
export async function getAgentTestRunCommand(
	actor: AgentTestActor,
	raw: unknown,
	policy?: AgentTestSelectionPolicy,
) {
	const input = agentTestRunIdentitySchema.parse(raw);
	return runSummary(
		actor,
		await testrun(actor, input.testRunId, policy),
		policy,
	);
}
export async function listAgentTestRunsCommand(
	actor: AgentTestActor,
	raw: unknown,
	policy?: AgentTestSelectionPolicy,
) {
	const input = agentTestRunListSchema.parse(raw);
	await testcase(actor, input.caseId, policy);
	if (input.cursor) {
		const cursor = await db.agentTestRun.findFirst({
			where: {
				id: input.cursor,
				caseId: input.caseId,
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
		});
		if (!cursor) {
			throw new AgentTestError(
				"BAD_REQUEST",
				"Use a cursor from this test's runs.",
			);
		}
	}
	const rows = await db.agentTestRun.findMany({
		where: {
			caseId: input.caseId,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: input.limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});
	const page = rows.slice(0, input.limit);
	const runs: AgentTestRunSummary[] = [];
	for (const row of page) {
		try {
			runs.push(await runSummary(actor, row, policy));
		} catch (e) {
			if (
				!(e instanceof AgentTestError) ||
				!["NOT_FOUND", "FORBIDDEN"].includes(e.code)
			) {
				throw e;
			}
		}
	}
	await testcase(actor, input.caseId, policy);
	return {
		runs,
		nextCursor:
			rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
	};
}
export async function cancelAgentTestRunCommand(
	actor: AgentTestActor,
	raw: unknown,
	audit: AgentTestAudit,
	policy?: AgentTestSelectionPolicy,
) {
	await executing(actor);
	const input = agentTestRunIdentitySchema.parse(raw);
	const row = await testrun(actor, input.testRunId, policy);
	if (["COMPLETED", "CANCELLED", "ERROR"].includes(row.status)) {
		return {
			requested: false,
			testRun: await runSummary(actor, row, policy),
		};
	}
	if (!row.executionId) {
		throw new AgentTestError(
			"SERVICE_UNAVAILABLE",
			"The run's admission is still being confirmed. Retry its original request key before requesting cancellation.",
		);
	}
	const cancelled = await cancelAgentRunCommand(
		actor,
		{ executionId: row.executionId },
		async (e) => audit(e),
	);
	await audit({
		action: "org.agent_test.cancel_requested",
		organizationId: actor.organizationId,
		resource: { type: "agent_test_run", id: row.id },
		metadata: { executionId: row.executionId },
	});
	return {
		requested: cancelled.requested,
		testRun: await runSummary(
			actor,
			await testrun(actor, row.id, policy),
			policy,
		),
	};
}
export async function compareAgentTestRunsCommand(
	actor: AgentTestActor,
	raw: unknown,
	policy?: AgentTestSelectionPolicy,
) {
	const input = agentTestCompareSchema.parse(raw);
	const a = await testrun(actor, input.baselineRunId, policy);
	const b = await testrun(actor, input.candidateRunId, policy);
	if (
		a.caseId !== b.caseId ||
		a.caseRevision !== b.caseRevision ||
		a.caseInput !== b.caseInput ||
		digest(a.checksJson) !== digest(b.checksJson)
	) {
		throw new AgentTestError(
			"BAD_REQUEST",
			"Compare two runs of the same test revision and expectations.",
		);
	}
	const baseline = await runSummary(actor, a, policy);
	const candidate = await runSummary(actor, b, policy);
	if (
		!baseline.report ||
		!candidate.report ||
		baseline.status !== "COMPLETED" ||
		candidate.status !== "COMPLETED"
	) {
		throw new AgentTestError(
			"CONFLICT",
			"Wait for both test assessments to complete before comparing.",
		);
	}
	return {
		baseline,
		candidate,
		changes: {
			passed: candidate.report.passed - baseline.report.passed,
			total: baseline.report.total,
			verdictChanged: baseline.verdict !== candidate.verdict,
			durationMsDelta:
				baseline.report.durationMs !== null &&
				candidate.report.durationMs !== null
					? candidate.report.durationMs - baseline.report.durationMs
					: null,
			costDelta:
				baseline.report.totalCost !== null &&
				candidate.report.totalCost !== null
					? new Prisma.Decimal(candidate.report.totalCost)
							.minus(baseline.report.totalCost)
							.toString()
					: null,
		},
	};
}
