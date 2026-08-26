/**
 * Verifies the Zod schema for the report-run notification types
 * (REPORT_COMPLETED, REPORT_FAILED) accepts the exact payload shape the helper
 * emits and rejects malformed inputs.
 *
 * Keep in lock-step with the helper in
 * packages/database/prisma/queries/report-execution-notification.ts — it inserts
 * rows whose payload field is validated against this schema (see
 * notification-service.ts validatePayload). Fizzy #1692.
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

// The exact shape emitted by emitReportExecutionNotification — no raw `error`.
const VALID = {
	executionId: "exec-1",
	instanceId: "inst-1",
	instanceName: "Weekly Sales",
	status: "COMPLETED",
} as const;

describe("report execution payload schema", () => {
	it("accepts the helper's emitted shape for REPORT_COMPLETED", () => {
		expect(
			validatePayload(NotificationType.REPORT_COMPLETED, VALID),
		).toMatchObject(VALID);
	});

	it("accepts the helper's emitted shape for REPORT_FAILED", () => {
		const failed = { ...VALID, status: "FAILED" } as const;
		expect(
			validatePayload(NotificationType.REPORT_FAILED, failed),
		).toMatchObject(failed);
	});

	it("rejects a non-terminal status", () => {
		expect(() =>
			validatePayload(NotificationType.REPORT_COMPLETED, {
				...VALID,
				status: "RUNNING",
			}),
		).toThrow();
	});

	it("rejects payloads missing required fields", () => {
		const { executionId: _omit, ...partial } = VALID;
		expect(() =>
			validatePayload(
				NotificationType.REPORT_FAILED,
				partial as typeof VALID,
			),
		).toThrow();
	});

	it("strips a stray raw error key (no raw-error leak survives validation)", () => {
		const result = validatePayload(NotificationType.REPORT_FAILED, {
			...VALID,
			status: "FAILED",
			error: "Error: at /srv/app/workflow.js:42 activity FetchData failed (id abc123)",
		});
		expect(result).not.toHaveProperty("error");
	});
});
