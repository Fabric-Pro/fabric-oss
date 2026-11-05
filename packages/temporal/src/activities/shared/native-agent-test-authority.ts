import { isDeepStrictEqual } from "node:util";
import {
	type AgentExecutionDispatch,
	canExecuteOrganizationAgents,
	db,
	readAgentExecutionAdmission,
} from "@repo/database";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
	assertAgentTestSourceScope,
	loadAgentTestScope,
} from "../../lib/agent-test-access";
import { readWorkspaceDocumentFilters } from "../../lib/workspace-document-selection";

export type NativeTestAuthority = NonNullable<
	AgentExecutionDispatch["testAuthority"]
>;
export interface NativeTestBoundary {
	executionId: string;
	authority: NativeTestAuthority;
}
function refuse(): never {
	throw ApplicationFailure.nonRetryable(
		"The saved test's frozen source authority or configuration is no longer available. Start a new test after reviewing its saved settings.",
		"SAVED_AGENT_STEP_FORBIDDEN",
	);
}
/** Reuse live source checks; hashes bind the selectors/configuration, not usage timestamps. */
export async function assertFrozenAgentTestAuthority(
	actor: { userId: string; organizationId?: string },
	authority: NativeTestAuthority,
) {
	if (!actor.organizationId) {
		refuse();
	}
	if (
		!(await canExecuteOrganizationAgents(
			actor.userId,
			actor.organizationId,
		))
	) {
		refuse();
	}
	const owner = {
		userId: actor.userId,
		organizationId: actor.organizationId,
	};
	await assertAgentTestSourceScope(owner, authority.origin);
	await assertAgentTestSourceScope(owner, authority.execution);
	const current = await loadAgentTestScope(
		owner,
		authority.execution.instanceId,
	);
	if (
		!authority.execution.configHash ||
		current.instance.id !== authority.execution.instanceId ||
		current.scope.configHash !== authority.execution.configHash
	) {
		refuse();
	}
	return current;
}
/** Bind an activity's optional descriptor to immutable admission, never caller JSON. */
export async function assertNativeAgentTestBoundary(input: {
	userId: string;
	organizationId?: string;
	nativeTestBoundary?: NativeTestBoundary;
}) {
	if (!input.nativeTestBoundary) {
		return;
	}
	const info = Context.current().info;
	const actual = info.workflowExecution;
	if (!input.organizationId || !actual) {
		refuse();
	}
	const row = await db.agentDeploymentExecution.findFirst({
		where: {
			executionId: input.nativeTestBoundary.executionId,
			userId: input.userId,
			organizationId: input.organizationId,
		},
		select: {
			metadata: true,
			userId: true,
			organizationId: true,
			workflowId: true,
			runId: true,
			status: true,
			deployment: {
				select: { status: true, userId: true, organizationId: true },
			},
		},
	});
	const admission = row && readAgentExecutionAdmission(row);
	if (
		!row ||
		row.deployment.status === "TERMINATED" ||
		row.deployment.userId !== input.userId ||
		row.deployment.organizationId !== input.organizationId ||
		!admission?.dispatch.testAuthority ||
		row.workflowId !== actual.workflowId ||
		(row.runId !== null && row.runId !== actual.runId) ||
		admission.dispatch.workflowType !== info.workflowType ||
		!["PENDING", "RUNNING"].includes(row.status) ||
		!isDeepStrictEqual(
			admission.dispatch.testAuthority,
			input.nativeTestBoundary.authority,
		)
	) {
		refuse();
	}
	return assertFrozenAgentTestAuthority(
		input,
		admission.dispatch.testAuthority,
	);
}
/** A recorded context cannot name broader workspaces than its admitted frozen selection. */
export function assertFrozenAgentTestWorkspaceSelection(
	authority: NativeTestAuthority,
	selection: { workspaceIds?: string[]; workspaceDocumentFilters?: unknown },
) {
	const expected = authority.execution;
	if (
		!isDeepStrictEqual(
			selection.workspaceIds ?? [],
			expected.workspaceIds,
		) ||
		!isDeepStrictEqual(
			readWorkspaceDocumentFilters(
				selection.workspaceDocumentFilters,
				selection.workspaceIds ?? [],
			),
			readWorkspaceDocumentFilters(
				expected.workspaceDocumentFilters,
				expected.workspaceIds,
			),
		)
	) {
		refuse();
	}
}
export async function withNativeAgentTestBoundary<T>(
	input: {
		userId: string;
		organizationId?: string;
		nativeTestBoundary?: NativeTestBoundary;
	},
	run: (
		configuration?: Awaited<ReturnType<typeof loadAgentTestScope>>,
	) => Promise<T>,
): Promise<T> {
	const configuration = await assertNativeAgentTestBoundary(input);
	const result = await run(configuration);
	await assertNativeAgentTestBoundary(input);
	return result;
}
