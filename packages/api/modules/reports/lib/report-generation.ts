/**
 * Generating a report on demand: which report a caller may generate, and the
 * durable admission and start of its run. The report page's Generate button
 * (`instances/execute`) and Fabric Agent's `fabric_generate_report` both come
 * here, so one set of rules decides who may spend a report's AI credits.
 */

import { randomUUID } from "node:crypto";
import {
	admitTemplateInstanceExecution,
	assertPublicReportParameters,
	buildReportExecutionSnapshot,
	getProjectReportSetupReason,
	getTemplateInstance,
	getTemplateInstanceExecution,
	isFeatureEnabled,
	REPORT_EXECUTION_SNAPSHOT_KEY,
	reportExecutionAdmissionId,
	updateTemplateInstanceExecution,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { getTemporalClient } from "@repo/temporal";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	canGenerateReportInstance,
	type ReportCaller,
	reportGenerationRefusal,
} from "./report-access";
import { reportSourceConnectionFailure } from "./report-connection-test";
import { reportGenerationBlockedReason } from "./report-generation-readiness";
import { ReportGenerationError } from "./report-refusal";

type GeneratableReport = NonNullable<
	Awaited<ReturnType<typeof getTemplateInstance>>
>;

/**
 * The report, when the caller may see it, may generate it (they own it, as a
 * report runs on its owner's connections, and the project role allows it), its
 * project setup is complete and it is switched on.
 */
export async function loadGeneratableReport(
	instanceId: string,
	caller: ReportCaller,
	organizationId: string,
): Promise<GeneratableReport> {
	const instance = await getTemplateInstance({
		id: instanceId,
		userId: caller.id,
		organizationId,
	});
	if (!instance) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Template instance not found or access denied",
		);
	}
	if (!(await canGenerateReportInstance(instance, caller))) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			reportGenerationRefusal(instance, caller),
		);
	}
	const setupReason = getProjectReportSetupReason(
		instance.fabricConfig,
		instance.template.definition,
		instance.connections,
	);
	if (setupReason) {
		throw new ReportGenerationError("BAD_REQUEST", setupReason);
	}
	if (!instance.isActive) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"Cannot execute inactive template instance",
		);
	}
	return instance;
}

export type ReportGenerationStart = {
	executionId: string;
	workflowId: string;
	status: string;
	startConfirmed: boolean;
	message: string;
};

/**
 * Admits one run of the report and starts its workflow. The admission is
 * durable BEFORE the remote start, keyed by the idempotency key, so a retry
 * with the same key attaches to the same run instead of starting another.
 * Where the report suite is on, a new run first passes what the page checks: a
 * required source left unbound or a required parameter left empty is refused
 * (a stored binding that has gone stale passes here, because a run repairs it),
 * and its required data sources pass the live connection test, so a run that
 * would fail on one is refused, naming it, before it spends credits.
 *
 * `planEligible` is the caller's: true when a person started the run and
 * waits for it, so its AI steps may use their own ChatGPT plan; false for a
 * key or token, whose run stays on the organization's shared plans.
 */
export async function startReportGeneration({
	instance,
	caller,
	organizationId,
	parameters,
	idempotencyKey,
	planEligible,
}: {
	instance: GeneratableReport;
	caller: ReportCaller;
	organizationId: string;
	parameters?: Record<string, unknown>;
	idempotencyKey?: string;
	planEligible: boolean;
}): Promise<ReportGenerationStart> {
	assertPublicReportParameters(parameters);
	const requestId = idempotencyKey ?? randomUUID();
	const workflowId = `template-instance-${reportExecutionAdmissionId(JSON.stringify([organizationId, caller.id, instance.id, requestId]))}`;
	const executionId = reportExecutionAdmissionId(workflowId);
	// A retry attaches to the run it admitted, whatever the connection does now.
	const alreadyAdmitted =
		idempotencyKey !== undefined &&
		(await getTemplateInstanceExecution(executionId, {
			userId: caller.id,
			organizationId,
		})) !== null;
	if (
		!alreadyAdmitted &&
		(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))
	) {
		const stored = instance.parameterDefaults;
		const blockedReason = reportGenerationBlockedReason({
			...instance,
			parameterDefaults: {
				...(stored &&
				typeof stored === "object" &&
				!Array.isArray(stored)
					? stored
					: undefined),
				...parameters,
			},
		});
		if (blockedReason) {
			throw new ReportGenerationError("BAD_REQUEST", blockedReason);
		}
		const connectionFailure = await reportSourceConnectionFailure(
			instance,
			{ userId: caller.id, organizationId },
		);
		if (connectionFailure) {
			throw new ReportGenerationError("BAD_REQUEST", connectionFailure);
		}
	}
	const snapshot = await buildReportExecutionSnapshot({
		instance,
		organizationId,
		userId: caller.id,
		occurrenceAt: new Date(),
		origin: "manual",
	});
	const execution = await admitTemplateInstanceExecution({
		id: executionId,
		instanceId: instance.id,
		userId: caller.id,
		organizationId,
		workflowId,
		parameters: JSON.parse(
			JSON.stringify({
				...parameters,
				[REPORT_EXECUTION_SNAPSHOT_KEY]: snapshot,
			}),
		) as Prisma.InputJsonValue,
	});
	if (
		execution.runId ||
		["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)
	) {
		return {
			executionId: execution.id,
			workflowId,
			status: execution.status,
			startConfirmed: !!execution.runId,
			message: "Report execution already admitted",
		};
	}
	// An uncertain start or receipt failure stays pending for the existing
	// dispatcher to reconcile with this same ID.
	let startConfirmed = false;
	try {
		const client = await getTemporalClient();
		const handle = await client.workflow.start(
			"templateInstanceExecutionWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						executionId: execution.id,
						instanceId: instance.id,
						userId: caller.id,
						organizationId,
						reportingProtocol: 1,
						planEligible,
					},
				],
			}),
		);
		startConfirmed = true;
		await updateTemplateInstanceExecution({
			id: execution.id,
			workflowId,
			runId: handle.firstExecutionRunId,
		});
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			try {
				const client = await getTemporalClient();
				const description = await client.workflow
					.getHandle(workflowId)
					.describe();
				startConfirmed = true;
				await updateTemplateInstanceExecution({
					id: execution.id,
					runId: description.runId,
				});
			} catch {
				/* Keep durable intent for reconciliation. */
			}
		}
		// Never mark FAILED: the remote workflow may already be running. Reconciliation
		// uses the persisted occurrence and cannot start a second workflow after edits.
	}
	return {
		executionId: execution.id,
		workflowId,
		status: execution.status,
		startConfirmed,
		message: startConfirmed
			? "Template instance execution started"
			: "Execution admitted; awaiting start confirmation",
	};
}
