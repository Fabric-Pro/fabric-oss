/**
 * The scheduled-workflow notifications (WORKFLOW_RUN_COMPLETED,
 * WORKFLOW_RUN_FAILED) are written by `recordScheduledRunOutcome` in
 * `@repo/temporal`, which cannot import this validator. This keeps the shape it
 * emits and the schema registered here in lock-step.
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const COMPLETED = {
	workflowId: "wf-1",
	workflowName: "Weekly status",
	executionId: "exec-1",
	status: "COMPLETED",
	frameId: "frame-1",
} as const;

const FAILED = {
	workflowId: "wf-1",
	workflowName: "Weekly status",
	executionId: "exec-2",
	status: "FAILED",
	paused: true,
} as const;

describe("workflow run payload schema", () => {
	it("accepts the shape emitted for a first success", () => {
		expect(
			validatePayload(NotificationType.WORKFLOW_RUN_COMPLETED, COMPLETED),
		).toMatchObject(COMPLETED);
	});

	it("accepts a first success that published no frame", () => {
		const { frameId: _omit, ...withoutFrame } = COMPLETED;

		expect(() =>
			validatePayload(
				NotificationType.WORKFLOW_RUN_COMPLETED,
				withoutFrame,
			),
		).not.toThrow();
	});

	it("accepts the shape emitted for a failure, paused or not", () => {
		expect(
			validatePayload(NotificationType.WORKFLOW_RUN_FAILED, FAILED),
		).toMatchObject(FAILED);
		expect(() =>
			validatePayload(NotificationType.WORKFLOW_RUN_FAILED, {
				...FAILED,
				paused: false,
			}),
		).not.toThrow();
	});

	it("rejects a non-terminal status", () => {
		expect(() =>
			validatePayload(NotificationType.WORKFLOW_RUN_FAILED, {
				...FAILED,
				status: "RUNNING",
			}),
		).toThrow();
	});

	it("rejects a payload without the execution it reports", () => {
		const { executionId: _omit, ...partial } = FAILED;

		expect(() =>
			validatePayload(NotificationType.WORKFLOW_RUN_FAILED, partial),
		).toThrow();
	});

	it("strips a stray raw error, so none survives validation", () => {
		const result = validatePayload(NotificationType.WORKFLOW_RUN_FAILED, {
			...FAILED,
			error: "Error: connect ECONNREFUSED 10.0.0.1",
		});

		expect(result).not.toHaveProperty("error");
	});
});
