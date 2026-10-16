/**
 * The ChatGPT-plan work notices (CHATGPT_PLAN_WORK_PAUSED / _STOPPED, Fizzy
 * #3050) are written by `@repo/database` helpers that cannot import this
 * validator. This keeps the shapes they emit and the schemas registered here
 * in lock-step.
 */

import {
	NotificationType,
	type PlanWorkPausedPayload,
	type PlanWorkStoppedPayload,
} from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const PAUSED: PlanWorkPausedPayload = {
	work: "PROJECT_SCAN",
	runId: "scan-1",
	projectId: "proj-1",
	projectName: "Example project",
	resumesAt: "2026-10-15T14:00:00.000Z",
};

const STOPPED: PlanWorkStoppedPayload = {
	work: "DAILY_BRIEF",
	runId: "wf-1:run-1",
	reason: "PLAN_SPENT",
};

describe("ChatGPT plan work payload schemas", () => {
	it("accepts the paused shape", () => {
		expect(
			validatePayload(NotificationType.CHATGPT_PLAN_WORK_PAUSED, PAUSED),
		).toMatchObject(PAUSED);
	});

	it("accepts the stopped shape, with or without a project", () => {
		expect(
			validatePayload(
				NotificationType.CHATGPT_PLAN_WORK_STOPPED,
				STOPPED,
			),
		).toMatchObject(STOPPED);
		expect(() =>
			validatePayload(NotificationType.CHATGPT_PLAN_WORK_STOPPED, {
				...STOPPED,
				projectId: "proj-1",
				projectName: "Example project",
				reason: "RESUME_LOST",
			}),
		).not.toThrow();
	});

	it("rejects a paused notice with no resume time, and an unknown reason", () => {
		const { resumesAt: _omit, ...withoutResume } = PAUSED;
		expect(() =>
			validatePayload(
				NotificationType.CHATGPT_PLAN_WORK_PAUSED,
				withoutResume,
			),
		).toThrow();
		expect(() =>
			validatePayload(NotificationType.CHATGPT_PLAN_WORK_STOPPED, {
				...STOPPED,
				reason: "CANCELLED",
			}),
		).toThrow();
	});
});
