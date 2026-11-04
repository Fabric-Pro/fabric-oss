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
	GENERATE_OWNER_ONLY_MESSAGE,
	type ReportCaller,
} from "./report-access";

type ReportGenerationErrorCode = "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST";

/** A refusal written for the person, raised before anything was admitted. */
export class ReportGenerationError extends Error {
	constructor(
		readonly code: ReportGenerationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ReportGenerationError";
	}
}

type GeneratableReport = NonNullable<
	Awaited<ReturnType<typeof getTemplateInstance>>
>;

/**
 * The report, when the caller may see it, owns it (a report runs on its
 * owner's connections), its project setup is complete and it is switched on.
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
	if (!canGenerateReportInstance(instance, caller)) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			GENERATE_OWNER_ONLY_MESSAGE,
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
	const snapshot = await buildReportExecutionSnapshot({
		instance,
		organizationId,
		userId: caller.id,
		occurrenceAt: new Date(),
		origin: "manual",
	});
	const execution = await admitTemplateInstanceExecution({
		id: reportExecutionAdmissionId(workflowId),
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
