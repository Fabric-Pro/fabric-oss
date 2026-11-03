import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@repo/database";
import { Context } from "@temporalio/activity";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	completeNativeAgentExecution,
	registerNativeAgentExecutionReceipt,
} from "../src/activities/agent-execution-native-receipt";
import {
	finishDeploymentAgentTurn,
	prepareDeploymentAgentTurn,
} from "../src/activities/deployment-execution";
import {
	finishGoalStep,
	prepareGoalStep,
} from "../src/activities/goal-oriented-agent";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";

const enabled =
	process.env.RUN_DB_INTEGRATION === "1" &&
	process.env.RUN_TEMPORAL_INTEGRATION === "1";
const prefix = `example-native-${randomUUID()}`;
const org = `${prefix}-org`;
const user = `${prefix}-user`;
const project = `${prefix}-project`;
const template = `${prefix}-template`;
const instance = `${prefix}-instance`;
const deployment = `${prefix}-deployment`;
let env: TestWorkflowEnvironment | undefined;
let guarded = false;
describe.skipIf(!enabled)(
	"native receipt and terminal projection against loopback Temporal/Postgres",
	() => {
		beforeAll(async () => {
			const url = new URL(process.env.DATABASE_URL ?? "");
			if (
				!["localhost", "127.0.0.1"].includes(url.hostname) ||
				url.port !== "55463" ||
				!/^\/example_[a-z0-9_]+$/.test(url.pathname) ||
				!/^127\.0\.0\.1:\d+$/.test(process.env.TEMPORAL_ADDRESS ?? "")
			) {
				throw Error(
					"Only explicitly configured loopback example_* services may run this fixture",
				);
			}
			guarded = true;
			await db.organization.create({
				data: {
					id: org,
					slug: org,
					name: "Example native receipt team",
					createdAt: new Date(),
				},
			});
			await db.user.create({
				data: {
					id: user,
					email: `${user}@example.com`,
					name: "Example native actor",
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await db.member.create({
				data: {
					organizationId: org,
					userId: user,
					role: "owner",
					createdAt: new Date(),
				},
			});
			await db.project.create({
				data: {
					id: project,
					organizationId: org,
					userId: user,
					name: "Example native project",
					status: "ACTIVE",
					techStack: [],
					features: [],
					tags: [],
				},
			});
			await db.agentTemplate.create({
				data: {
					id: template,
					slug: template,
					userId: user,
					organizationId: org,
					scope: "ORGANIZATION",
					name: "Example native agent",
					displayName: "Example native agent",
					description: "Synthetic receipt retry fixture",
					instructions: "Produce an example answer",
					category: "GENERAL",
					isPublished: true,
				},
			});
			await db.agentTemplateInstance.create({
				data: {
					id: instance,
					templateId: template,
					userId: user,
					organizationId: org,
					name: "Example native instance",
					status: "ACTIVE",
					customInstructions: { projectId: project },
					toolConnections: {},
					triggers: [],
				},
			});
			await db.agentDeployment.create({
				data: {
					id: deployment,
					instanceId: instance,
					userId: user,
					organizationId: org,
					name: "Example native deployment",
					slug: deployment,
					status: "ACTIVE",
				},
			});
			env = await TestWorkflowEnvironment.createFromExistingServer({
				address: process.env.TEMPORAL_ADDRESS,
				namespace: "default",
				client: { identity: "example-client" },
			});
		}, 60_000);
		afterAll(async () => {
			await env?.teardown();
			if (guarded) {
				await db.agentTemplate.deleteMany({
					where: { id: template, userId: user, organizationId: org },
				});
				await db.project.deleteMany({
					where: { id: project, userId: user, organizationId: org },
				});
				await db.organization.deleteMany({ where: { id: org } });
				await db.user.deleteMany({ where: { id: user } });
			}
		});
		it.each(["deployment", "goal"])(
			"%s retries a real failed receipt write and lost acknowledgements before/after one turn",
			async (kind) => {
				if (!env) {
					throw Error("Missing isolated test connections");
				}
				const suffix = randomUUID();
				const workflowId = `${prefix}-${kind}-${suffix}`;
				const executionId = `${prefix}-execution-${suffix}`;
				const rowId = `${prefix}-row-${suffix}`;
				const requestHash = "a".repeat(64);
				const workflowType =
					kind === "deployment"
						? "nativeDeploymentExecutionWorkflow"
						: "nativeGoalOrientedAgentWorkflow";
				await db.agentDeploymentExecution.create({
					data: {
						id: rowId,
						executionId,
						deploymentId: deployment,
						userId: user,
						organizationId: org,
						triggerType: "API",
						status: "PENDING",
						workflowId,
						input: { message: "Example native proof" },
						metadata: {
							fabricAdmission: {
								version: 1,
								receiptOwner: "workflow",
								requestHash,
								dispatch: {
									workflowType,
									instanceId: instance,
									projectId: project,
									...(kind === "goal"
										? {
												goal: "Produce answer",
												maxIterations: 1,
											}
										: {}),
								},
								imageRefs: [],
							},
						},
					},
				});
				let receiptAttempts = 0;
				let terminalAttempts = 0;
				let modelCalls = 0;
				let toolCalls = 0;
				const context = {
					agentInstanceId: instance,
					projectId: project,
					systemPrompt: "Example instructions",
					model: "example-model",
					tools: [],
					knowledgeSources: [],
					workspaceIds: [],
					mcpConfigIds: [],
					builtInToolNames: [],
					integrationConfigurations: [],
				};
				const bundle = await bundleWorkflowCode(
					buildWorkflowBundleOptions(
						resolve(
							import.meta.dirname,
							kind === "deployment"
								? "../src/workflows/deployment-execution.ts"
								: "../src/workflows/goal-oriented-agent/index.ts",
						),
					),
				);
				const worker = await Worker.create({
					connection: env.nativeConnection,
					namespace: "default",
					identity: "example-worker",
					taskQueue: workflowId,
					workflowBundle: bundle,
					activities: {
						registerNativeAgentExecutionReceipt: async (
							input: Parameters<
								typeof registerNativeAgentExecutionReceipt
							>[0],
						) => {
							receiptAttempts++;
							if (receiptAttempts === 1) {
								// Real Postgres rejects this owned-row receipt mutation; no schema/trigger or mocked DB.
								await db.$executeRaw`UPDATE agent_deployment_execution SET "runId" = (1 / 0)::text WHERE id = ${rowId}`;
							}
							await registerNativeAgentExecutionReceipt(input);
							if (receiptAttempts === 2) {
								// Receipt committed, but the activity acknowledgement is lost to a real DB error.
								await db.$queryRaw`SELECT 1 / 0`;
							}
						},
						completeNativeAgentExecution: async (
							input: Parameters<
								typeof completeNativeAgentExecution
							>[0],
						) => {
							terminalAttempts++;
							await completeNativeAgentExecution(input);
							if (terminalAttempts === 1) {
								await db.$queryRaw`SELECT 1 / 0`;
							}
						},
						loadDeploymentConfiguration: async () => ({
							template: {
								name: "Example agent",
								displayName: "Example agent",
							},
							instance: { name: "Example instance" },
							integrationConfigurations: [],
							toolConnections: {},
							workspaceIds: [],
						}),
						buildExecutionContext: async () => context,
						prepareDeploymentAgentTurn,
						finishDeploymentAgentTurn,
						prepareGoalStep,
						finishGoalStep,
						createGoalOrientedPlan: async () => ({
							plan: {
								strategy: "sequential",
								steps: [
									{
										id: "example-step",
										description: "Produce answer",
										type: "task",
										inputs: {},
									},
								],
							},
							routingDecision: {},
						}),
						verifyGoalAchievement: async () => ({
							achieved: true,
							confidence: 1,
							reasoning: "Example proof",
						}),
						executeSavedAgentModelStep: async () => {
							const row =
								await db.agentDeploymentExecution.findUniqueOrThrow(
									{ where: { id: rowId } },
								);
							expect(row.runId).toBe(
								Context.current().info.workflowExecution?.runId,
							);
							expect(receiptAttempts).toBe(3);
							expect(row.status).toBe("RUNNING");
							modelCalls++;
							return {
								success: true,
								response:
									modelCalls === 1
										? ""
										: "Example verified result",
								toolCalls: [],
								tokenUsage: { inputTokens: 1, outputTokens: 1 },
								modelStep: {
									messages: [],
									toolCalls:
										modelCalls === 1
											? [
													{
														id: "example-call",
														name: "example_read",
														args: {},
													},
												]
											: [],
								},
							};
						},
						executeSavedAgentToolStep: async () => {
							toolCalls++;
							return {
								id: "example-call",
								name: "example_read",
								args: {},
								status: "success",
								result: { value: "Example evidence" },
								durationMs: 1,
							};
						},
					},
				});
				const handle = await env.client.workflow.start(workflowType, {
					workflowId,
					taskQueue: workflowId,
					memo: {
						fabricAgentAdmission: {
							version: 1,
							executionId: rowId,
							requestHash,
							userId: user,
							organizationId: org,
						},
					},
					args: [
						{
							executionId,
							deploymentId: deployment,
							instanceId: instance,
							userId: user,
							organizationId: org,
							input: { message: "Example native proof" },
							goal: "Produce answer",
							maxIterations: 1,
							supervisorWorkflowId:
								kind === "deployment"
									? `${workflowId}-absent-parent`
									: undefined,
							triggerType: "API",
							timeoutMs: 300000,
							nativeAdmission: {
								version: 1,
								executionRowId: rowId,
								requestHash,
							},
						},
					],
				});
				const result = await worker.runUntil(handle.result());
				expect(result.status).toBe("COMPLETED");
				expect(receiptAttempts).toBe(3);
				expect(terminalAttempts).toBe(2);
				expect(modelCalls).toBe(2);
				expect(toolCalls).toBe(1);
				const row = await db.agentDeploymentExecution.findUniqueOrThrow(
					{ where: { id: rowId } },
				);
				expect(row.runId).toBe(handle.firstExecutionRunId);
				expect(row.status).toBe("COMPLETED");
				expect(JSON.stringify(row.output)).toContain(
					"Example verified result",
				);
				const history = await handle.fetchHistory();
				const scheduled = (history.events ?? []).flatMap(
					(e) =>
						e.activityTaskScheduledEventAttributes?.activityType
							?.name ?? [],
				);
				expect(scheduled[0]).toBe(
					"registerNativeAgentExecutionReceipt",
				);
				expect(
					scheduled.filter((n) => n === "executeSavedAgentToolStep"),
				).toHaveLength(1);
				expect(scheduled).not.toContain("invokeDeploymentAgent");
				expect(scheduled).not.toContain("executeGoalStep");
				expect(scheduled).not.toContain("attemptStepRecovery");
				if (kind === "deployment") {
					expect(scheduled).not.toContain(
						"signalSupervisorCompletion",
					);
					expect(
						history.events?.some(
							(event) =>
								event
									.signalExternalWorkflowExecutionInitiatedEventAttributes
									?.signalName === "executionCompleted",
						),
					).toBe(true);
					expect(
						history.events?.some(
							(event) =>
								event.signalExternalWorkflowExecutionFailedEventAttributes,
						),
					).toBe(true);
				}

				await Worker.runReplayHistory(
					{ workflowBundle: bundle },
					history,
					workflowId,
				);
				if (process.env.NATIVE_AGENT_HISTORY_DIR) {
					await mkdir(process.env.NATIVE_AGENT_HISTORY_DIR, {
						recursive: true,
					});
					await writeFile(
						resolve(
							process.env.NATIVE_AGENT_HISTORY_DIR,
							`${kind}-durable.json`,
						),
						JSON.stringify(
							{
								workflowId,
								workflowType,
								receiptAttempts,
								terminalAttempts,
								modelCalls,
								toolCalls,
								history: JSON.parse(historyToJSON(history)),
							},
							null,
							2,
						),
					);
				}
			},
			60_000,
		);
	},
);
