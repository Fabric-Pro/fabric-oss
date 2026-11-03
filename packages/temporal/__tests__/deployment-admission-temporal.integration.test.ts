import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ServiceError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ client: vi.fn(), attach: vi.fn() }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: h.client }));
vi.mock("@repo/database", () => ({
	getAgentTemplateInstanceForExecution: async () => ({
		instance: { customInstructions: {} },
	}),
	readAgentExecutionAdmission: () => ({
		receiptOwner: "workflow",
		requestHash: "a".repeat(64),
		dispatch: {
			instanceId: "example-instance",
			workflowType: "nativeDeploymentExecutionWorkflow",
		},
		imageRefs: [],
	}),
	attachAgentExecutionReceipt: h.attach,
	getProjectAccessContext: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
}));
vi.mock("../../api/lib/temporal-correlation", () => ({
	withCorrelationMemo: (x: unknown) => x,
}));

import { dispatchAdmittedAgentExecution } from "../../api/modules/agent-deployments/lib/dispatch-execution";

const address = process.env.TEMPORAL_ADMISSION_TEST_ADDRESS;
describe.skipIf(!address)(
	"saved-instance admission on a real loopback Temporal service",
	() => {
		it("recovers a lost start acknowledgement after completion without creating another run", async () => {
			if (!address || !/^(127\.0\.0\.1|localhost):\d+$/.test(address)) {
				throw new Error(
					"Only an explicit loopback Temporal service may run this test",
				);
			}
			const env = await TestWorkflowEnvironment.createFromExistingServer({
				address,
				namespace: "default",
			});
			const taskQueue = `example-admission-${randomUUID()}`;
			const row = {
				id: `example-execution-${randomUUID()}`,
				executionId: "example-channel",
				deploymentId: "example-deployment",
				userId: "example-user",
				organizationId: "example-org",
				input: {},
				metadata: {},
				workflowId: `example-workflow-${randomUUID()}`,
				runId: null,
				status: "PENDING",
				output: null,
			};
			let started:
				| Awaited<ReturnType<typeof env.client.workflow.start>>
				| undefined;
			let loseAcknowledgement = true;
			const bundle = await bundleWorkflowCode({
				workflowsPath: resolve(
					import.meta.dirname,
					"fixtures/deployment-admission-workflow.ts",
				),
			});
			const worker = await Worker.create({
				connection: env.nativeConnection,
				taskQueue,
				workflowBundle: bundle,
			});
			const start = vi.fn(
				async (
					type: string,
					options: Parameters<typeof env.client.workflow.start>[1],
				) => {
					const handle = await env.client.workflow.start(type, {
						...options,
						taskQueue,
					});
					started = handle;
					if (loseAcknowledgement) {
						loseAcknowledgement = false;
						throw new ServiceError(
							"Synthetic lost acknowledgement",
							{
								cause: Object.assign(new Error("UNAVAILABLE"), {
									code: 14,
									details: "status",
									metadata: {},
								}),
							},
						);
					}
					return handle;
				},
			);
			h.client.mockResolvedValue({
				connection: env.client.connection,
				workflow: {
					start,
					getHandle: env.client.workflow.getHandle.bind(
						env.client.workflow,
					),
				},
			});
			try {
				expect(await dispatchAdmittedAgentExecution(row)).toMatchObject(
					{ confirmed: true },
				);
				expect(started).toBeDefined();
				if (!started) {
					throw new Error(
						"Temporal did not return a workflow handle",
					);
				}
				const original = started;
				await expect(
					worker.runUntil(original.result()),
				).resolves.toEqual({ verified: true });
				h.attach.mockImplementation(async (receipt) => ({
					...row,
					runId: receipt.runId,
					status: "COMPLETED",
				}));
				const recovered = await dispatchAdmittedAgentExecution(row);
				expect(recovered).toMatchObject({
					confirmed: true,
					execution: {
						status: "PENDING",
						runId: original.firstExecutionRunId,
					},
				});
				expect(start).toHaveBeenCalledTimes(2);
				expect(h.attach).not.toHaveBeenCalled();
				const description = await env.client.workflow
					.getHandle(row.workflowId)
					.describe();
				expect(description.runId).toBe(original.firstExecutionRunId);
				expect(description.status.name).toBe("COMPLETED");
			} finally {
				await env.teardown();
			}
		}, 60000);
	},
);
