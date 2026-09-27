/**
 * Member proposal branches as the API starts and wakes them (Fizzy #2738
 * spec §5 "After commit", §6 "Identity" and "Start"; plan Decision 12).
 *
 * The branch workflow does not exist yet, so the Temporal client is a mock:
 * what is pinned is the call the API makes. `startAdmittedProposalPullRequest`
 * keeps its signature and dispatches on the row's `pullRequestContext.v`: a
 * v2 row joins its member's branch and wakes it, a v1 row starts the #2563
 * operation workflow exactly as before (Review Focus 4).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	signal: vi.fn(),
	getHandle: vi.fn(),
	signalWithStart: vi.fn(),
	joinProposalBranch: vi.fn(),
	getProposalOperation: vi.fn(),
	correlationId: null as string | null,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: m.getHandle,
			signalWithStart: m.signalWithStart,
		},
	}),
}));
vi.mock("@repo/database", () => ({
	joinProposalBranch: (...a: unknown[]) => m.joinProposalBranch(...a),
	getProposalOperation: (...a: unknown[]) => m.getProposalOperation(...a),
}));
vi.mock("../../../../../lib/correlation-id", () => ({
	getCorrelationIdFromContext: () => m.correlationId,
}));

import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
import {
	repositoryIdentity,
	repositoryKey,
} from "@repo/integrations/instruction-pull-requests";
import { repositoryDestination } from "../proposal-admission";
import {
	PROPOSAL_WORKFLOW_TASK_QUEUE,
	proposalBranchNaming,
	startAdmittedBranchProposal,
	wakeProposalBranchWorkflow,
} from "../proposal-branch";
import { startAdmittedProposalPullRequest } from "../proposal-pull-request";

const IDS = {
	branchId: "branch_1",
	projectId: "proj_1",
	organizationId: "org_1",
};
const WORKFLOW_ID = "project-instruction-proposal-branch-branch_1";
const PROPOSAL = {
	snapshotId: "snap_1",
	projectId: "proj_1",
	organizationId: "org_1",
};

function notFound(): Error {
	const error = new Error("workflow not found");
	error.name = "WorkflowNotFoundError";
	return error;
}

beforeEach(() => {
	for (const fn of [
		m.start,
		m.signal,
		m.getHandle,
		m.signalWithStart,
		m.joinProposalBranch,
		m.getProposalOperation,
	]) {
		fn.mockReset();
	}
	m.correlationId = "corr_1";
	m.getHandle.mockImplementation(() => ({ signal: m.signal }));
	m.signal.mockResolvedValue(undefined);
	m.signalWithStart.mockResolvedValue({ workflowId: WORKFLOW_ID });
	m.start.mockResolvedValue({ workflowId: "wf" });
});

describe("wakeProposalBranchWorkflow", () => {
	it("signals wake to the branch's open run, by its exact id", async () => {
		expect(
			await wakeProposalBranchWorkflow({ ...IDS, correlation: true }),
		).toBe("signaled");

		expect(m.getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
		expect(m.signal).toHaveBeenCalledWith("wake");
		expect(m.signalWithStart).not.toHaveBeenCalled();
	});

	it("signal-starts the branch workflow when no run is open, on the #2563 queue with the request's correlation memo", async () => {
		m.signal.mockRejectedValue(notFound());

		expect(
			await wakeProposalBranchWorkflow({ ...IDS, correlation: true }),
		).toBe("started");

		expect(m.signalWithStart).toHaveBeenCalledWith(
			"projectInstructionProposalBranchWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: WORKFLOW_ID,
				args: [IDS],
				signal: "wake",
				signalArgs: [],
				memo: { correlationId: "corr_1" },
			},
		);
		expect(PROPOSAL_WORKFLOW_TASK_QUEUE).toBe("project-instructions");
	});

	it("carries no memo for a wake that does not originate in a request", async () => {
		m.signal.mockRejectedValue(notFound());

		await wakeProposalBranchWorkflow({ ...IDS, correlation: false });

		expect(m.signalWithStart.mock.calls[0]![1]).not.toHaveProperty("memo");
	});

	it("carries no memo when the request has no correlation id", async () => {
		m.signal.mockRejectedValue(notFound());
		m.correlationId = null;

		await wakeProposalBranchWorkflow({ ...IDS, correlation: true });

		expect(m.signalWithStart.mock.calls[0]![1]).not.toHaveProperty("memo");
	});

	it("passes ids only to the workflow", async () => {
		m.signal.mockRejectedValue(notFound());

		await wakeProposalBranchWorkflow({
			...IDS,
			correlation: true,
			extra: "never in history",
		} as Parameters<typeof wakeProposalBranchWorkflow>[0]);

		expect(m.signalWithStart.mock.calls[0]![1].args).toEqual([IDS]);
	});

	it("throws any other signal failure without starting", async () => {
		m.signal.mockRejectedValue(new Error("unreachable"));

		await expect(
			wakeProposalBranchWorkflow({ ...IDS, correlation: true }),
		).rejects.toThrow("unreachable");
		expect(m.signalWithStart).not.toHaveBeenCalled();
	});

	it("throws a failed signal-start", async () => {
		m.signal.mockRejectedValue(notFound());
		m.signalWithStart.mockRejectedValue(new Error("unreachable"));

		await expect(
			wakeProposalBranchWorkflow({ ...IDS, correlation: true }),
		).rejects.toThrow("unreachable");
	});
});

describe("startAdmittedBranchProposal", () => {
	it("joins with the canonical naming port, then wakes the joined branch with the request's memo", async () => {
		m.joinProposalBranch.mockResolvedValue({
			kind: "joined",
			branchId: "branch_1",
			sequence: 1,
			assignment: 1,
		});
		m.signal.mockRejectedValue(notFound());

		await startAdmittedBranchProposal(PROPOSAL);

		expect(m.joinProposalBranch).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			organizationId: "org_1",
			naming: proposalBranchNaming,
		});
		expect(proposalBranchNaming).toEqual({
			memberBranchRef,
			repositoryIdentity,
			repositoryKey,
		});
		expect(m.signalWithStart).toHaveBeenCalledWith(
			"projectInstructionProposalBranchWorkflow",
			expect.objectContaining({
				workflowId: WORKFLOW_ID,
				args: [IDS],
				memo: { correlationId: "corr_1" },
			}),
		);
	});

	it("wakes the branch a repeated join reports", async () => {
		m.joinProposalBranch.mockResolvedValue({
			kind: "already",
			branchId: "branch_1",
			sequence: 2,
			assignment: 1,
		});

		await startAdmittedBranchProposal(PROPOSAL);

		expect(m.getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
		expect(m.signal).toHaveBeenCalledWith("wake");
	});

	it.each([{ kind: "not_joinable" }, { kind: "configuration_changed" }])(
		"wakes nothing for $kind",
		async (result) => {
			m.joinProposalBranch.mockResolvedValue(result);

			await startAdmittedBranchProposal(PROPOSAL);

			expect(m.getHandle).not.toHaveBeenCalled();
			expect(m.signalWithStart).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"the join",
			() => m.joinProposalBranch.mockRejectedValue(new Error("db down")),
		],
		[
			"the wake",
			() => {
				m.joinProposalBranch.mockResolvedValue({
					kind: "joined",
					branchId: "branch_1",
					sequence: 1,
					assignment: 1,
				});
				m.signal.mockRejectedValue(new Error("temporal down"));
			},
		],
	])(
		"logs a failure of %s and leaves the proposal to the sweeper's Attach",
		async (_, arrange) => {
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			arrange();

			await expect(startAdmittedBranchProposal(PROPOSAL)).resolves.toBe(
				undefined,
			);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("sweeper"),
				{ snapshotId: "snap_1" },
				expect.any(Error),
			);
			log.mockRestore();
		},
	);
});

describe("startAdmittedProposalPullRequest dispatches on pullRequestContext.v", () => {
	const INPUT = { ...PROPOSAL, operationId: "op_1" };

	it("joins and wakes the member's branch for a v2 row, starting no #2563 workflow", async () => {
		m.getProposalOperation.mockResolvedValue({
			pullRequestContext: { v: 2 },
		});
		m.joinProposalBranch.mockResolvedValue({
			kind: "joined",
			branchId: "branch_1",
			sequence: 1,
			assignment: 1,
		});

		await startAdmittedProposalPullRequest(INPUT);

		expect(m.getProposalOperation).toHaveBeenCalledWith(PROPOSAL);
		expect(m.joinProposalBranch).toHaveBeenCalledTimes(1);
		expect(m.signal).toHaveBeenCalledWith("wake");
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts the #2563 operation workflow for a v1 row admitted before, unchanged", async () => {
		m.getProposalOperation.mockResolvedValue({
			pullRequestContext: { v: 1 },
		});

		await startAdmittedProposalPullRequest(INPUT);

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionProposalPullRequestWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: "project-instruction-proposal-pull-request-op_1",
				workflowIdConflictPolicy: "FAIL",
				args: [INPUT],
				memo: { correlationId: "corr_1" },
			},
		);
		expect(m.joinProposalBranch).not.toHaveBeenCalled();
		expect(m.signalWithStart).not.toHaveBeenCalled();
	});

	it("starts the #2563 workflow for a row with no readable version, as before", async () => {
		m.getProposalOperation.mockResolvedValue(null);

		await startAdmittedProposalPullRequest(INPUT);

		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.joinProposalBranch).not.toHaveBeenCalled();
	});

	it("starts neither when the row cannot be read, leaving it to the sweeper", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.getProposalOperation.mockRejectedValue(new Error("db down"));

		await expect(startAdmittedProposalPullRequest(INPUT)).resolves.toBe(
			undefined,
		);
		expect(m.start).not.toHaveBeenCalled();
		expect(m.joinProposalBranch).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("sweeper"),
			{ snapshotId: "snap_1", operationId: "op_1" },
			expect.any(Error),
		);
		log.mockRestore();
	});
});

describe("repositoryDestination", () => {
	const audit = {
		actor: { type: "user" as const, userId: "user_1" },
		organizationId: "org_1",
		projectId: "proj_1",
		metadata: {
			mode: "proposal" as const,
			baseSnapshotId: "snap_base",
			baseVersion: 7,
			putCount: 1,
			deleteCount: 0,
		},
	};
	const shared = {
		integrationId: "int_1",
		syncId: "sync_1",
		syncGeneration: 4,
		provider: "GITHUB" as const,
		targetRef: "main",
		rootPath: "instructions",
		baseCommitSha: "a".repeat(40),
		repository: {
			provider: "GITHUB" as const,
			owner: "example-org",
			repo: "example-repo",
		},
		author: { name: "Pat Example", email: "dev@example.com" },
		committer: { name: "Fabric", email: "dev@example.com" },
		message: "Update coding instructions (1 file)",
		committedAt: "2026-09-27T00:00:00Z",
	};

	it("gives a member branch proposal (v2) no per-proposal ref", () => {
		const destination = repositoryDestination(
			{
				destination: "REPOSITORY",
				note: null,
				operationId: "op_1",
				context: { v: 2, ...shared },
				syncId: "sync_1",
				syncGeneration: 4,
			},
			audit,
		);
		expect(destination).not.toHaveProperty("branch");
		expect(destination.context).toMatchObject({ v: 2 });
	});

	it("keeps a v1 context's branch as the row's ref", () => {
		const destination = repositoryDestination(
			{
				destination: "REPOSITORY",
				note: null,
				operationId: "op_1",
				context: {
					v: 1,
					...shared,
					branch: "fabric/instructions/op_1",
					title: "t",
					body: "b",
				},
				syncId: "sync_1",
				syncGeneration: 4,
			},
			audit,
		);
		expect(destination.branch).toBe("fabric/instructions/op_1");
	});
});
