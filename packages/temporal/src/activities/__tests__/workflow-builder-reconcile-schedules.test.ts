/**
 * Schedule sync is best-effort — it never throws, so a publish is not held
 * hostage to Temporal being reachable. The cost is that a workflow deleted or
 * unpublished during an outage keeps a schedule that fires against nothing.
 * This sweep is what closes that gap.
 *
 * The risk to guard is over-deletion: this removes live schedules, so anything
 * it does not positively recognise as an orphan must be left alone.
 */

import { describe, expect, it, vi } from "vitest";
import {
	classifyScheduleOrphan,
	reconcileWorkflowSchedules,
} from "../workflow-builder-reconcile-schedules";

const scheduleTrigger = [
	{
		id: "n1",
		type: "trigger",
		data: {
			config: { triggerType: "schedule", scheduleCron: "0 9 * * *" },
		},
	},
];

const manualTrigger = [
	{ id: "n1", type: "trigger", data: { config: { triggerType: "manual" } } },
];

function summaries(...ids: string[]) {
	return async function* () {
		for (const scheduleId of ids) {
			yield { scheduleId } as never;
		}
	};
}

describe("classifyScheduleOrphan", () => {
	it("keeps a published workflow with a schedule trigger", () => {
		expect(
			classifyScheduleOrphan({
				status: "PUBLISHED",
				nodes: scheduleTrigger,
			}),
		).toBeNull();
	});

	it("keeps an ACTIVE workflow too", () => {
		expect(
			classifyScheduleOrphan({
				status: "ACTIVE",
				nodes: scheduleTrigger,
			}),
		).toBeNull();
	});

	it("flags a deleted workflow", () => {
		expect(classifyScheduleOrphan(null)).toBe("workflow-deleted");
	});

	it("flags a workflow reverted to draft", () => {
		expect(
			classifyScheduleOrphan({ status: "DRAFT", nodes: scheduleTrigger }),
		).toBe("workflow-not-published");
	});

	it("flags a trigger switched away from Schedule", () => {
		expect(
			classifyScheduleOrphan({
				status: "PUBLISHED",
				nodes: manualTrigger,
			}),
		).toBe("trigger-no-longer-scheduled");
	});
});

describe("reconcileWorkflowSchedules", () => {
	const live = { status: "PUBLISHED", nodes: scheduleTrigger };

	it("deletes an orphan and leaves a live schedule alone", async () => {
		const deleteSchedule = vi.fn().mockResolvedValue(undefined);

		const result = await reconcileWorkflowSchedules({
			listSchedules: summaries(
				"workflow-builder-alive",
				"workflow-builder-gone",
			),
			deleteSchedule,
			fetchWorkflow: async (id) => (id === "alive" ? live : null),
			dryRun: false,
		});

		expect(result).toMatchObject({
			scanned: 2,
			orphansDeleted: 1,
			reasons: { "workflow-deleted": 1 },
		});
		expect(deleteSchedule).toHaveBeenCalledExactlyOnceWith("gone");
	});

	it("ignores schedules it does not own", async () => {
		const deleteSchedule = vi.fn();

		const result = await reconcileWorkflowSchedules({
			listSchedules: summaries(
				"url-source-abc",
				"context-summarization",
				"workflow-builder-alive",
			),
			deleteSchedule,
			fetchWorkflow: async () => live,
			dryRun: false,
		});

		// Only the workflow-builder one is even counted.
		expect(result.scanned).toBe(1);
		expect(deleteSchedule).not.toHaveBeenCalled();
	});

	it("changes nothing on a dry run but still reports", async () => {
		const deleteSchedule = vi.fn();

		const result = await reconcileWorkflowSchedules({
			listSchedules: summaries("workflow-builder-gone"),
			deleteSchedule,
			fetchWorkflow: async () => null,
			dryRun: true,
		});

		expect(result).toMatchObject({ orphansDeleted: 1, dryRun: true });
		expect(deleteSchedule).not.toHaveBeenCalled();
	});

	it("tallies why each schedule was removed", async () => {
		const result = await reconcileWorkflowSchedules({
			listSchedules: summaries(
				"workflow-builder-a",
				"workflow-builder-b",
				"workflow-builder-c",
			),
			deleteSchedule: vi.fn().mockResolvedValue(undefined),
			fetchWorkflow: async (id) => {
				if (id === "a") {
					return null;
				}
				if (id === "b") {
					return { status: "DRAFT", nodes: scheduleTrigger };
				}
				return { status: "PUBLISHED", nodes: manualTrigger };
			},
			dryRun: false,
		});

		expect(result.reasons).toEqual({
			"workflow-deleted": 1,
			"workflow-not-published": 1,
			"trigger-no-longer-scheduled": 1,
		});
	});

	it("reports progress so a long sweep does not look wedged", async () => {
		const heartbeat = vi.fn();

		await reconcileWorkflowSchedules({
			listSchedules: summaries(
				"workflow-builder-a",
				"workflow-builder-b",
			),
			deleteSchedule: vi.fn(),
			fetchWorkflow: async () => live,
			dryRun: false,
			heartbeat,
		});

		expect(heartbeat).toHaveBeenCalledTimes(2);
	});
});
