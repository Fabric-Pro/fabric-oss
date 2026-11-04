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
	"__fixtures__/managed-agent-schedule-histories",
);
const entrySchema = z.object({
	workflowType: z.enum([
		"scheduleTriggerWorkflow",
		"managedAgentRunScheduleWorkflow",
	]),
	workflowId: z.string().startsWith("example-schedule-"),
	firstExecutionRunId: z.string().uuid(),
	eventCount: z.number().int().positive(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	activityAttempts: z.number().int().min(2),
	legacyHandlerCalls: z.literal(0).optional(),
	managedHandlerCalls: z.literal(1).optional(),
	observedUnregisteredActivity: z.literal(true).optional(),
	baselineSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
	recordedSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
let manifest: Record<string, z.infer<typeof entrySchema>>;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
function decodePayload(data: Uint8Array | null | undefined): unknown {
	if (!data) {
		throw Error("Missing synthetic history payload");
	}
	return JSON.parse(Buffer.from(data).toString("utf8"));
}
beforeAll(async () => {
	manifest = z
		.record(z.string(), entrySchema)
		.parse(
			JSON.parse(
				await readFile(resolve(directory, "manifest.json"), "utf8"),
			),
		);
	bundle = await bundleWorkflowCode(
		buildWorkflowBundleOptions(
			resolve(
				import.meta.dirname,
				"../src/workflows/schedule-trigger.ts",
			),
		),
	);
}, 60_000);

describe("managed agent schedule genuine history compatibility", () => {
	// Recorded by real SDK workers on isolated loopback queues. The admission
	// Activity is a controlled synthetic response; this proves workflow replay,
	// retry and argument identity, not database admission or schedule clock behavior.
	it.each(["legacy", "managed", "managed-fenced"])(
		"replays %s history without a service and preserves its occurrence contract",
		async (kind) => {
			const entry = manifest[kind];
			const serialized = await readFile(
				resolve(directory, `${kind}.json`),
				"utf8",
			);
			expect(createHash("sha256").update(serialized).digest("hex")).toBe(
				entry.sha256,
			);
			const history = historyFromJSON(JSON.parse(serialized));
			expect(history.events).toHaveLength(entry.eventCount);
			expect(
				history.events?.[0]?.workflowExecutionStartedEventAttributes
					?.workflowType?.name,
			).toBe(
				kind === "legacy"
					? "scheduleTriggerWorkflow"
					: "managedAgentRunScheduleWorkflow",
			);
			const scheduled = (history.events ?? []).flatMap((event) =>
				event.activityTaskScheduledEventAttributes
					? [event.activityTaskScheduledEventAttributes]
					: [],
			);
			expect(scheduled).toHaveLength(1);
			expect(scheduled[0].activityType?.name).toBe(
				kind === "managed-fenced"
					? "dispatchManagedAgentScheduledExecution"
					: "signalSupervisorForScheduledExecution",
			);
			expect(scheduled[0].retryPolicy?.maximumAttempts ?? 0).toBe(
				kind === "managed-fenced" ? 0 : 3,
			);
			if (kind === "managed-fenced") {
				expect(entry.legacyHandlerCalls).toBe(0);
				expect(entry.managedHandlerCalls).toBe(1);
				expect(entry.observedUnregisteredActivity).toBe(true);
				expect(
					history.events?.some((event) =>
						event.activityTaskStartedEventAttributes?.lastFailure?.message?.includes(
							"not registered",
						),
					),
				).toBe(true);
			}
			expect(
				history.events?.some(
					(event) =>
						event.activityTaskStartedEventAttributes?.attempt ===
						entry.activityAttempts,
				),
			).toBe(true);
			const args = decodePayload(scheduled[0].input?.payloads?.[0]?.data);
			const common = {
				supervisorWorkflowId:
					kind === "legacy" ? "example-supervisor" : "",
				deploymentId: "example-deployment",
				triggerId: "fabric-run-schedule-example-deployment",
				triggerType: "SCHEDULE",
			};
			if (kind === "legacy") {
				expect(args).toEqual(common);
			} else {
				expect(args).toEqual({
					...common,
					managedRunSchedule: 1,
					userId: "example-user",
					organizationId: "example-org",
					occurrenceWorkflowId: entry.workflowId,
					occurrenceFirstRunId: entry.firstExecutionRunId,
				});
				// The request included untrusted occurrence fields; native workflow
				// identity, rather than those values, must reach the admission Activity.
				expect(
					decodePayload(
						history.events?.[0]
							?.workflowExecutionStartedEventAttributes?.input
							?.payloads?.[0]?.data,
					),
				).toMatchObject({
					occurrenceWorkflowId: "example-untrusted-occurrence",
					occurrenceFirstRunId: "example-untrusted-first-run",
				});
			}
			expect(
				decodePayload(
					history.events?.at(-1)
						?.workflowExecutionCompletedEventAttributes?.result
						?.payloads?.[0]?.data,
				),
			).toEqual({ success: true, executionId: "example-execution-row" });
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
