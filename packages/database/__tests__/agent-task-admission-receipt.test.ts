import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ update: vi.fn(), updateMany: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { agentTask: { update: h.update, updateMany: h.updateMany } },
}));

import {
	markAgentTaskAdmissionUnresolved,
	updateAgentTaskWorkflow,
} from "../prisma/queries/agent-tasks";

beforeEach(() => vi.clearAllMocks());
describe("durable generic agent admission uncertainty", () => {
	it("records uncertainty alongside identity before dispatch so a later database outage cannot hide it", async () => {
		await updateAgentTaskWorkflow({
			id: "example-task",
			workflowId: "example-workflow",
			runId: "",
		});
		expect(h.update).toHaveBeenCalledWith({
			where: { id: "example-task" },
			data: {
				workflowId: "example-workflow",
				runId: "",
				state: {
					admission: {
						status: "UNRESOLVED",
						workflowId: "example-workflow",
					},
				},
			},
		});
	});
	it("does not overwrite execution state when attaching a confirmed Temporal receipt", async () => {
		await updateAgentTaskWorkflow({
			id: "example-task",
			workflowId: "example-workflow",
			runId: "example-run",
		});
		expect(h.update.mock.calls[0][0].data).not.toHaveProperty("state");
	});
	it("does not overwrite an already running or completed task on ambiguous admission", async () => {
		await markAgentTaskAdmissionUnresolved({
			id: "example-task",
			userId: "example-user",
			organizationId: "example-org",
			workflowId: "example-workflow",
		});
		expect(h.updateMany.mock.calls[0][0].where).toEqual({
			id: "example-task",
			userId: "example-user",
			organizationId: "example-org",
			status: "PENDING",
		});
	});
});
