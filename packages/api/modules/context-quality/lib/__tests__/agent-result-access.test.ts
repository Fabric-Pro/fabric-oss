import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedEvaluationError } from "../../saved-contracts";

const m = vi.hoisted(() => ({
	row: vi.fn(),
	admission: vi.fn(),
	run: vi.fn(),
	projectAccess: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { agentDeploymentExecution: { findFirst: m.row } },
	readAgentExecutionAdmission: m.admission,
}));
vi.mock("../../../agent-deployments/lib/run-commands", () => ({
	getAgentRunCommand: m.run,
}));
vi.mock("../saved-access", () => ({
	requireSavedEvaluationAccess: m.projectAccess,
}));

import { agentResultCommands } from "../agent-result";

const actor = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
};
const executionId = "example-execution";
const dispatch = {
	instanceId: "example-instance",
	projectId: actor.projectId,
	workflowType: "nativeDeploymentExecutionWorkflow",
};
const row = {
	metadata: { fabricAdmission: { dispatch } },
	deployment: { instanceId: dispatch.instanceId },
};
const run = {
	executionId,
	workflowId: "example-workflow",
	runId: "example-native-run",
	status: "COMPLETED",
	nativeStateAvailable: true,
	completedAt: new Date("2026-11-03T12:00:00.000Z"),
	output: { response: "Example actual completed result." },
};
async function inspect() {
	return (await agentResultCommands()).inspect(actor, { executionId });
}
beforeEach(() => {
	vi.resetAllMocks();
	m.projectAccess.mockResolvedValue({ canWrite: false, canConfigure: false });
	m.row.mockResolvedValue(row);
	m.admission.mockImplementation(
		(value) => value.metadata?.fabricAdmission ?? null,
	);
	m.run.mockResolvedValue(run);
});
describe("recorded agent-result production admission", () => {
	it("resolves current project access, exact creator/organization row and the existing owner-aware native reader", async () => {
		expect(await inspect()).toMatchObject({
			recordedAnswer: run.output.response,
			executionStateSource: "temporal",
			instanceId: dispatch.instanceId,
		});
		expect(m.row).toHaveBeenCalledTimes(2);
		for (const [input] of m.row.mock.calls) {
			expect(input.where).toEqual({
				id: executionId,
				organizationId: actor.organizationId,
				userId: actor.userId,
			});
		}
		expect(m.run).toHaveBeenCalledExactlyOnceWith(actor, { executionId });
		expect(m.projectAccess).toHaveBeenCalledTimes(2);
	});
	it("retains the archived source label instead of claiming live Temporal evidence", async () => {
		m.run.mockResolvedValue({ ...run, nativeStateAvailable: false });
		expect(await inspect()).toMatchObject({
			executionStateSource: "database",
		});
	});
	it("refuses project permission before looking up run data", async () => {
		m.projectAccess.mockRejectedValueOnce(
			new SavedEvaluationError(
				"FORBIDDEN",
				"Current project access required.",
			),
		);
		await expect(inspect()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.row).not.toHaveBeenCalled();
		expect(m.run).not.toHaveBeenCalled();
	});
	it("refuses foreign owner, tenant or missing execution without native access", async () => {
		m.row.mockResolvedValue(null);
		await expect(inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.run).not.toHaveBeenCalled();
	});
	it.each([null, { dispatch: { instanceId: dispatch.instanceId } }])(
		"does not infer a legacy run project from the current editable agent binding",
		async (admission) => {
			m.admission.mockReturnValue(admission);
			await expect(inspect()).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			expect(m.run).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ ...dispatch, projectId: "example-other-project" },
		{ ...dispatch, instanceId: "example-other-instance" },
	])("refuses admitted project or instance mismatch", async (changed) => {
		m.admission.mockReturnValue({ dispatch: changed });
		await expect(inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.run).not.toHaveBeenCalled();
	});
	it.each(["FORBIDDEN", "NOT_FOUND"])(
		"preserves current owner-aware reader refusal %s",
		async (code) => {
			m.run.mockRejectedValueOnce({
				code,
				message: "example private implementation detail",
			});
			await expect(inspect()).rejects.toMatchObject({
				code,
				message: "Current access to this agent result is required.",
			});
		},
	);
	it("returns an unavailable error without leaking native/provider errors", async () => {
		m.run.mockRejectedValueOnce(
			new Error("example private provider diagnostic"),
		);
		await expect(inspect()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: "The agent result could not be verified. Try again.",
		});
	});
	it.each([
		null,
		{ ...row, deployment: { instanceId: "example-replacement-instance" } },
		{
			...row,
			metadata: {
				fabricAdmission: {
					dispatch: {
						...dispatch,
						projectId: "example-other-project",
					},
				},
			},
		},
	])(
		"refuses a removed or rebound execution after native result loading",
		async (changed) => {
			m.row.mockResolvedValueOnce(row).mockResolvedValueOnce(changed);
			await expect(inspect()).rejects.toMatchObject({ code: "CONFLICT" });
		},
	);
	it("rechecks current project permission before returning loaded output", async () => {
		m.projectAccess
			.mockResolvedValueOnce({})
			.mockRejectedValueOnce(
				new SavedEvaluationError("FORBIDDEN", "Access revoked."),
			);
		await expect(inspect()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.run).toHaveBeenCalledOnce();
	});
});
