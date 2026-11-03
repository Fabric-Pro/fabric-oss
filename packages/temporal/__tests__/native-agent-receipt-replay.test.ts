import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";

const directory = resolve(
	import.meta.dirname,
	"__fixtures__/native-agent-histories",
);
const entrySchema = z.object({
	workflowType: z.string(),
	workflowId: z.string().startsWith("example-native-"),
	eventCount: z.number().int(),
	sha256: z.string(),
	status: z.enum(["COMPLETED", "FAILED"]),
	receiptAttempts: z.number(),
	modelCalls: z.number(),
	terminalAttempts: z.number().optional(),
	toolCalls: z.number().optional(),
	baselineSourceHash: z.string(),
});
let manifest: Record<string, z.infer<typeof entrySchema>>;
const bundles = new Map<
	string,
	Awaited<ReturnType<typeof bundleWorkflowCode>>
>();
beforeAll(async () => {
	manifest = z
		.record(z.string(), entrySchema)
		.parse(
			JSON.parse(
				await readFile(resolve(directory, "manifest.json"), "utf8"),
			),
		);
	for (const kind of ["deployment", "goal"]) {
		bundles.set(
			kind,
			await bundleWorkflowCode(
				buildWorkflowBundleOptions(
					resolve(
						import.meta.dirname,
						kind === "deployment"
							? "../src/workflows/deployment-execution.ts"
							: "../src/workflows/goal-oriented-agent/index.ts",
					),
				),
			),
		);
	}
}, 60_000);
describe("native saved-agent receipt history compatibility", () => {
	it.each([
		"deployment-legacy",
		"goal-legacy",
		"deployment-native",
		"goal-native",
		"deployment-refusal",
		"goal-refusal",
		"deployment-durable",
		"goal-durable",
	])(
		"replays genuine synthetic SDK history %s without services",
		async (name) => {
			const entry = manifest[name];
			const serialized = await readFile(
				resolve(directory, `${name}.json`),
				"utf8",
			);
			expect(createHash("sha256").update(serialized).digest("hex")).toBe(
				entry.sha256,
			);
			const history = historyFromJSON(JSON.parse(serialized));
			expect(history.events).toHaveLength(entry.eventCount);
			const scheduled = (history.events ?? []).flatMap(
				(e) =>
					e.activityTaskScheduledEventAttributes?.activityType
						?.name ?? [],
			);
			if (name.endsWith("-legacy")) {
				expect(scheduled).not.toContain(
					"registerNativeAgentExecutionReceipt",
				);
				expect(entry.modelCalls).toBe(1);
			} else {
				expect(scheduled[0]).toBe(
					"registerNativeAgentExecutionReceipt",
				);
			}
			if (name.endsWith("-native")) {
				expect(entry.receiptAttempts).toBe(2);
				expect(
					(history.events ?? []).some(
						(e) =>
							e.activityTaskStartedEventAttributes?.attempt === 2,
					),
				).toBe(true);
				expect(
					scheduled.indexOf("registerNativeAgentExecutionReceipt"),
				).toBeLessThan(
					scheduled.indexOf("loadDeploymentConfiguration"),
				);
			}
			if (name.endsWith("-durable")) {
				expect(entry.receiptAttempts).toBe(3);
				expect(entry.terminalAttempts).toBe(2);
				expect(entry.modelCalls).toBe(2);
				expect(entry.toolCalls).toBe(1);
				expect(
					scheduled.filter(
						(type) => type === "executeSavedAgentModelStep",
					),
				).toHaveLength(2);
				expect(
					scheduled.filter(
						(type) => type === "executeSavedAgentToolStep",
					),
				).toHaveLength(1);
				expect(
					scheduled.filter(
						(type) => type === "completeNativeAgentExecution",
					),
				).toHaveLength(1);
				for (const legacy of [
					"invokeDeploymentAgent",
					"executeGoalStep",
					"attemptStepRecovery",
				]) {
					expect(scheduled).not.toContain(legacy);
				}
				const attempts = (history.events ?? []).flatMap(
					(event) =>
						event.activityTaskStartedEventAttributes?.attempt ?? [],
				);
				expect(attempts).toContain(3);
				expect(attempts).toContain(2);
			}
			if (name.endsWith("-refusal")) {
				expect(scheduled).not.toContain("loadDeploymentConfiguration");
				expect(scheduled).not.toContain("completeExecution");
				expect(scheduled).not.toContain("completeGoalExecution");
				expect(entry.modelCalls).toBe(0);
				expect(
					history.events?.at(-1)
						?.workflowExecutionFailedEventAttributes,
				).toBeDefined();
			}
			const bundle = bundles.get(
				name.startsWith("deployment") ? "deployment" : "goal",
			);
			if (!bundle) {
				throw Error("Missing current workflow bundle");
			}
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle: bundle },
					history,
					entry.workflowId,
				),
			).resolves.toBeUndefined();
		},
		30_000,
	);
});
