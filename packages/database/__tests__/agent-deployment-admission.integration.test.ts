import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	admitAgentDeploymentExecution,
	attachAgentExecutionReceipt,
	normalizeAgentExecutionRequest,
} from "../prisma/queries/agent-deployments/admission";
import {
	claimAgentExecutionReceiptObservation,
	listAgentExecutionReceiptCandidates,
} from "../prisma/queries/agent-deployments/receipt-recovery";

const prefix = `example-admission-${randomUUID()}`;
const org = `${prefix}-org`;
const user = `${prefix}-user`;
const template = `${prefix}-template`;
const instance = `${prefix}-instance`;
const deployment = `${prefix}-deployment`;
let guarded = false;
describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"saved-agent admission on guarded PostgreSQL",
	() => {
		beforeAll(async () => {
			const url = new URL(process.env.DATABASE_URL ?? "");
			if (
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
				!/^\/example_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error(
					"A guarded loopback example_* database is required",
				);
			}
			guarded = true;
			await db.organization.create({
				data: {
					id: org,
					slug: org,
					name: "Example admission team",
					createdAt: new Date(),
				},
			});
			await db.user.create({
				data: {
					id: user,
					email: `${user}@example.com`,
					name: "Example admission actor",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await db.organizationDeploymentQuota.create({
				data: {
					organizationId: org,
					dailyExecutionLimit: 1000,
					monthlyExecutionLimit: 20000,
				},
			});
			await db.agentTemplate.create({
				data: {
					id: template,
					slug: template,
					name: "Example",
					displayName: "Example",
					description: "Synthetic admission fixture",
					instructions: "Use only permitted context",
					category: "GENERAL",
					scope: "ORGANIZATION",
					organizationId: org,
					userId: user,
				},
			});
			await db.agentTemplateInstance.create({
				data: {
					id: instance,
					name: "Example",
					templateId: template,
					userId: user,
					organizationId: org,
				},
			});
			await db.agentDeployment.create({
				data: {
					id: deployment,
					instanceId: instance,
					userId: user,
					organizationId: org,
					name: "Example",
					slug: deployment,
					status: "ACTIVE",
				},
			});
		}, 30000);
		it("rotates observed rows fairly and preserves concurrent worker completion on PostgreSQL", async () => {
			const first = `${prefix}-observation-a`;
			const second = `${prefix}-observation-b`;
			for (const [index, id] of [first, second].entries()) {
				await db.agentDeploymentExecution.create({
					data: {
						id,
						executionId: randomUUID(),
						deploymentId: deployment,
						userId: user,
						organizationId: org,
						triggerType: "API",
						status: "PENDING",
						workflowId: `example-workflow-${id}`,
						metadata: {
							fabricAdmission: { version: 1 },
							retained: "example-value",
						},
						updatedAt: new Date(`2001-01-0${index + 1}T00:00:00Z`),
					},
				});
			}
			const bounds = {
				limit: 1,
				before: new Date("2002-01-01T00:00:00Z"),
			};
			const [a] = await listAgentExecutionReceiptCandidates(bounds);
			if (!a) {
				throw new Error("Missing first observation candidate");
			}
			expect(a.id).toBe(first);
			expect(
				await claimAgentExecutionReceiptObservation(a, new Date()),
			).toBe(true);
			const [b] = await listAgentExecutionReceiptCandidates(bounds);
			if (!b) {
				throw new Error("Missing second observation candidate");
			}
			expect(b.id).toBe(second);
			expect(
				(
					await db.agentDeploymentExecution.findUniqueOrThrow({
						where: { id: first },
					})
				).metadata,
			).toMatchObject({
				retained: "example-value",
				fabricReceiptRecovery: { observedAt: expect.any(String) },
			});
			await db.agentDeploymentExecution.update({
				where: { id: second },
				data: {
					status: "COMPLETED",
					output: { preserved: true },
					metadata: { workerCompletion: true },
				},
			});
			expect(
				await claimAgentExecutionReceiptObservation(b, new Date()),
			).toBe(false);
			expect(
				await db.agentDeploymentExecution.findUniqueOrThrow({
					where: { id: second },
				}),
			).toMatchObject({
				status: "COMPLETED",
				output: { preserved: true },
				metadata: { workerCompletion: true },
			});
			await db.agentDeploymentExecution.deleteMany({
				where: {
					id: { in: [first, second] },
					deploymentId: deployment,
					organizationId: org,
				},
			});
		});
		afterAll(async () => {
			if (!guarded) {
				return;
			}
			await db.organization.deleteMany({ where: { id: org } });
			await db.user.deleteMany({ where: { id: user } });
			await db.$disconnect();
		});
		it("concurrent identical callers create one durable intent and one audit row; terminal receipt attachment preserves status", async () => {
			const input = {
				organizationId: org,
				userId: user,
				deploymentId: deployment,
				idempotencyKey: "same-request",
				request: normalizeAgentExecutionRequest({
					input: { message: "Example" },
					priority: 5,
				}),
				dispatch: {
					instanceId: instance,
					workflowType: "nativeDeploymentExecutionWorkflow" as const,
				},
			};
			const results = await Promise.all(
				Array.from({ length: 12 }, () =>
					admitAgentDeploymentExecution(input),
				),
			);
			expect(new Set(results.map((x) => x.execution.id)).size).toBe(1);
			const row = results[0].execution;
			expect(
				await db.agentDeploymentExecution.count({
					where: { deploymentId: deployment },
				}),
			).toBe(1);
			expect(
				await db.auditLog.count({
					where: {
						organizationId: org,
						action: "org.agent_execution.admitted",
					},
				}),
			).toBe(1);
			await expect(
				admitAgentDeploymentExecution({
					...input,
					request: normalizeAgentExecutionRequest({
						input: { message: "Changed" },
						priority: 5,
					}),
				}),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
			await db.agentDeploymentExecution.update({
				where: { id: row.id },
				data: { status: "COMPLETED", output: { verified: true } },
			});
			if (!row.workflowId) {
				throw new Error("Admission omitted workflow identity");
			}
			const receipt = await attachAgentExecutionReceipt({
				id: row.id,
				userId: user,
				organizationId: org,
				workflowId: row.workflowId,
				runId: "example-run",
			});
			expect(receipt.status).toBe("COMPLETED");
			expect(receipt.output).toEqual({ verified: true });
			const charged =
				await db.organizationDeploymentQuota.findUniqueOrThrow({
					where: { organizationId: org },
				});
			expect(charged.dailyExecutionCount).toBe(1);
			expect(charged.monthlyExecutionCount).toBe(1);
			await db.organizationDeploymentQuota.update({
				where: { organizationId: org },
				data: { dailyExecutionLimit: 2 },
			});
			const contenders = await Promise.allSettled(
				Array.from({ length: 8 }, (_, index) =>
					admitAgentDeploymentExecution({
						...input,
						idempotencyKey: `remaining-${index}`,
					}),
				),
			);
			expect(
				contenders.filter((item) => item.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				contenders
					.filter((item) => item.status === "rejected")
					.every(
						(item) =>
							item.status === "rejected" &&
							item.reason.code === "EXECUTION_QUOTA_EXCEEDED",
					),
			).toBe(true);
			expect(
				await db.agentDeploymentExecution.count({
					where: { deploymentId: deployment },
				}),
			).toBe(2);
			expect(
				await db.auditLog.count({
					where: {
						organizationId: org,
						action: "org.agent_execution.admitted",
					},
				}),
			).toBe(2);
		}, 30000);
	},
);
