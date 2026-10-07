import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";

const REFRESH_WORKFLOW_TYPE = "projectInstructionProposalBranchRefreshWorkflow";
const REFRESH_WAIT_MS = 25_000;
const PENDING = Symbol("pending proposal branch refresh");

export type ProposalBranchRefreshAnswer =
	| { kind: "observed"; state: string | null }
	| { kind: "pending" };

function isPending(value: unknown): value is { kind: "pending" } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "pending"
	);
}

function isObserved(value: unknown): value is { state: string | null } {
	return (
		typeof value === "object" &&
		value !== null &&
		"state" in value &&
		(typeof value.state === "string" || value.state === null)
	);
}

async function beforeDeadline<T>(
	promise: Promise<T>,
	deadline: number,
): Promise<T | typeof PENDING> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		return PENDING;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<typeof PENDING>((resolve) => {
				timer = setTimeout(() => resolve(PENDING), remaining);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Starts one coalesced observation and only waits for a bounded request window. */
export async function runProposalBranchRefreshWorkflow(input: {
	branchId: string;
	projectId: string;
	organizationId: string;
	expectedAttempt: number;
}): Promise<ProposalBranchRefreshAnswer> {
	const deadline = Date.now() + REFRESH_WAIT_MS;
	const client = await beforeDeadline(
		getTemporalClient(),
		Math.min(deadline, Date.now() + 10_000),
	);
	if (client === PENDING) {
		throw new Error(
			"Fabric could not connect to start the pull-request refresh",
		);
	}
	const handle = await beforeDeadline(
		client.connection.withDeadline(
			Math.min(deadline, Date.now() + 10_000),
			() =>
				client.workflow.start(
					REFRESH_WORKFLOW_TYPE,
					withCorrelationMemo({
						taskQueue: "project-instructions",
						workflowId: `project-instruction-proposal-branch-refresh-${input.branchId}-${input.expectedAttempt}`,
						workflowIdReusePolicy: "ALLOW_DUPLICATE",
						workflowIdConflictPolicy: "USE_EXISTING",
						workflowExecutionTimeout: "75 seconds",
						args: [input],
					}),
				),
		),
		deadline,
	);
	if (handle === PENDING) {
		throw new Error("Fabric could not start the pull-request refresh");
	}
	const result = await beforeDeadline(handle.result(), deadline);
	if (result === PENDING || isPending(result)) {
		return { kind: "pending" };
	}
	if (isObserved(result)) {
		return { kind: "observed", state: result.state };
	}
	throw new Error("Proposal branch refresh returned an invalid result");
}
