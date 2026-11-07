import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import {
	historyFromJSON,
	historyToJSON,
} from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";

let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let env: TestWorkflowEnvironment;
beforeAll(async () => {
	bundle = await bundleWorkflowCode(
		buildWorkflowBundleOptions(
			resolve(import.meta.dirname, "helpers/run-quality-workflows.ts"),
		),
	);
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => {
	await env?.teardown();
});
describe("recorded quality observer native durability", () => {
	it("replays the genuine pre-quality visual workflow history without a new activity or child", async () => {
		const directory = resolve(
			import.meta.dirname,
			"__fixtures__/run-quality-histories",
		);
		const manifest = JSON.parse(
			await readFile(resolve(directory, "manifest.json"), "utf8"),
		);
		const text = await readFile(
			resolve(directory, "builder-before-quality.json"),
			"utf8",
		);
		expect(createHash("sha256").update(text).digest("hex")).toBe(
			manifest.sha256,
		);
		const history = historyFromJSON(JSON.parse(text));
		expect(history.events).toHaveLength(manifest.eventCount);
		expect(text).not.toContain("admitRecordedRunQuality");
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: bundle },
				history,
				manifest.workflowId,
			),
		).resolves.toBeUndefined();
	}, 30_000);
	it("starts one abandoned observer and retries its checks without rerunning business nodes", async () => {
		const taskQueue = "example-quality-durability",
			workflowId = "example-quality-parent",
			observerId = "example-quality-observer";
		let businessCalls = 0,
			checkCalls = 0;
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: bundle,
			activities: {
				getWorkflowDefinition: async (input: {
					override?: { nodes: unknown[]; edges: unknown[] };
				}) => ({ ...input.override, projectId: null, variables: null }),
				updateWorkflowExecutionStatus: async () => {},
				createWorkflowExecutionLog: async () => {},
				executeWorkflowNode: async () => {
					businessCalls++;
					return { success: true, output: { text: "Ready" } };
				},
				admitRecordedRunQuality: async () => ({
					assessmentId: "example-assessment",
					workflowId: observerId,
					userId: "example-user",
					organizationId: "example-org",
				}),
				assessRecordedRunQuality: async () => {
					if (++checkCalls === 1)
						throw Error("Example transient check outage");
					return { status: "COMPLETED" };
				},
				failRecordedRunQuality: async () => {
					throw Error("Unexpected assessment failure");
				},
			},
		});
		const handle = await env.client.workflow.start(
			"workflowBuilderExecutionWorkflow",
			{
				workflowId,
				taskQueue,
				args: [
					{
						workflowId: "example-workflow",
						executionId: "example-execution",
						userId: "example-user",
						organizationId: "example-org",
						skipPreflightValidation: true,
						nodes: [
							{
								id: "answer",
								type: "ai-generate-text",
								data: { config: {} },
								position: { x: 0, y: 0 },
							},
						],
						edges: [],
					},
				],
			},
		);
		await worker.runUntil(async () => {
			expect((await handle.result()).status).toBe("COMPLETED");
			expect(
				await env.client.workflow.getHandle(observerId).result(),
			).toEqual({ status: "COMPLETED" });
		});
		expect(businessCalls).toBe(1);
		expect(checkCalls).toBe(2);
		const history = await handle.fetchHistory();
		const serialized = historyToJSON(history);
		expect(
			JSON.parse(serialized).events.some(
				(event: {
					startChildWorkflowExecutionInitiatedEventAttributes?: {
						parentClosePolicy?: string;
					};
				}) =>
					event.startChildWorkflowExecutionInitiatedEventAttributes
						?.parentClosePolicy === "PARENT_CLOSE_POLICY_ABANDON",
			),
		).toBe(true);
		expect(serialized).toContain("fabricRunQuality");
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: bundle },
				history,
				workflowId,
			),
		).resolves.toBeUndefined();
	}, 60_000);
	it("starts an independent observer when the parent is cancelled during admission", async () => {
		let entered = () => {};
		const admissionEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let businessCalls = 0,
			checks = 0;
		const taskQueue = "example-quality-cancel-admission",
			observerId = "example-quality-cancel-observer";
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: bundle,
			activities: {
				getWorkflowDefinition: async (input: {
					override?: { nodes: unknown[]; edges: unknown[] };
				}) => ({ ...input.override, projectId: null, variables: null }),
				updateWorkflowExecutionStatus: async () => {},
				createWorkflowExecutionLog: async () => {},
				executeWorkflowNode: async () => {
					businessCalls++;
					return { success: true, output: "Ready" };
				},
				admitRecordedRunQuality: async () => {
					entered();
					await released;
					return {
						assessmentId: "example-cancel-assessment",
						workflowId: observerId,
						userId: "example-user",
						organizationId: "example-org",
					};
				},
				assessRecordedRunQuality: async () => {
					checks++;
					return { status: "COMPLETED" };
				},
				failRecordedRunQuality: async () => ({ status: "COMPLETED" }),
				failRunQualityAdmission: async () => {
					throw Error("Unexpected observer admission failure");
				},
			},
		});
		const handle = await env.client.workflow.start(
			"workflowBuilderExecutionWorkflow",
			{
				workflowId: "example-quality-cancel-parent",
				taskQueue,
				args: [
					{
						workflowId: "example-workflow",
						executionId: "example-execution",
						userId: "example-user",
						organizationId: "example-org",
						skipPreflightValidation: true,
						nodes: [
							{
								id: "answer",
								type: "ai-generate-text",
								data: { config: {} },
								position: { x: 0, y: 0 },
							},
						],
						edges: [],
					},
				],
			},
		);
		await worker.runUntil(async () => {
			await admissionEntered;
			await handle.cancel();
			release();
			expect((await handle.result()).status).toBe("CANCELLED");
			expect(
				await env.client.workflow.getHandle(observerId).result(),
			).toEqual({ status: "COMPLETED" });
		});
		expect(businessCalls).toBe(0);
		expect(checks).toBe(1);
	}, 60_000);
	it("does not fail business work when optional quality admission refuses", async () => {
		let businessCalls = 0,
			admissions = 0;
		const taskQueue = "example-quality-admission-refusal";
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: bundle,
			activities: {
				getWorkflowDefinition: async (input: {
					override?: { nodes: unknown[]; edges: unknown[] };
				}) => ({ ...input.override, projectId: null, variables: null }),
				updateWorkflowExecutionStatus: async () => {},
				createWorkflowExecutionLog: async () => {},
				executeWorkflowNode: async () => {
					businessCalls++;
					return { success: true, output: "Ready" };
				},
				admitRecordedRunQuality: async () => {
					admissions++;
					throw ApplicationFailure.nonRetryable(
						"Example unavailable quality admission",
					);
				},
				settleUnconfirmedRunQualityAdmission: async () => ({
					status: "NO_RECORDED_ADMISSION",
				}),
			},
		});
		const handle = await env.client.workflow.start(
			"workflowBuilderExecutionWorkflow",
			{
				workflowId: "example-quality-refused-parent",
				taskQueue,
				args: [
					{
						workflowId: "example-workflow",
						executionId: "example-execution",
						userId: "example-user",
						organizationId: "example-org",
						skipPreflightValidation: true,
						nodes: [
							{
								id: "answer",
								type: "ai-generate-text",
								data: { config: {} },
								position: { x: 0, y: 0 },
							},
						],
						edges: [],
					},
				],
			},
		);
		expect((await worker.runUntil(handle.result())).status).toBe(
			"COMPLETED",
		);
		expect(businessCalls).toBe(1);
		expect(admissions).toBe(1);
	}, 60_000);

	it("settles an admission whose database commit acknowledgement was lost without replaying business", async () => {
		let businessCalls = 0,
			committed = false,
			recovered = 0;
		const taskQueue = "example-quality-lost-admission",
			workflowId = "example-quality-lost-parent";
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle: bundle,
			activities: {
				getWorkflowDefinition: async (input: {
					override?: { nodes: unknown[]; edges: unknown[] };
				}) => ({ ...input.override, projectId: null, variables: null }),
				updateWorkflowExecutionStatus: async () => {},
				createWorkflowExecutionLog: async () => {},
				executeWorkflowNode: async () => {
					businessCalls++;
					return { success: true, output: "Ready" };
				},
				admitRecordedRunQuality: async () => {
					committed = true;
					throw ApplicationFailure.nonRetryable(
						"Example lost commit acknowledgement",
					);
				},
				settleUnconfirmedRunQualityAdmission: async (input: {
					executionId: string;
					nativeWorkflowId: string;
				}) => {
					expect(committed).toBe(true);
					expect(input.executionId).toBe("example-execution");
					expect(input.nativeWorkflowId).toBe(workflowId);
					recovered++;
					return { status: "COMPLETED" };
				},
			},
		});
		const handle = await env.client.workflow.start(
			"workflowBuilderExecutionWorkflow",
			{
				workflowId,
				taskQueue,
				args: [
					{
						workflowId: "example-workflow",
						executionId: "example-execution",
						userId: "example-user",
						organizationId: "example-org",
						skipPreflightValidation: true,
						nodes: [
							{
								id: "answer",
								type: "ai-generate-text",
								data: { config: {} },
								position: { x: 0, y: 0 },
							},
						],
						edges: [],
					},
				],
			},
		);
		await worker.runUntil(async () => {
			expect((await handle.result()).status).toBe("COMPLETED");
			const description = await handle.describe();
			expect(
				await env.client.workflow
					.getHandle(`run-quality-recovery-${description.runId}`)
					.result(),
			).toEqual({ status: "COMPLETED" });
		});
		expect(recovered).toBe(1);
		expect(businessCalls).toBe(1);
	}, 60_000);
});
