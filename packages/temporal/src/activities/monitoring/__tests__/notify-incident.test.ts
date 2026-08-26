/**
 * Tests for the `notifyIncident` activity — now an inert no-op.
 *
 * In-app incident notifications were removed; incidents live in the admin
 * monitoring "Incident history" timeline instead. The activity is retained so
 * the incident-lifecycle workflow replays deterministically, but it must NOT
 * write any Notification rows. These tests pin that contract: the DB helper is
 * never invoked, and the activity always returns a `skipped` result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const helperSpy = vi.fn();

vi.mock("@repo/database/prisma/queries/incident-notifications", () => ({
	createIncidentNotification: (input: unknown) => helperSpy(input),
}));

import { notifyIncident } from "../notify-incident";

beforeEach(() => {
	helperSpy.mockReset();
});

describe("notifyIncident (no-op)", () => {
	it("never writes notification rows — the DB helper is not invoked", async () => {
		await notifyIncident({
			source: "integration",
			incidentId: "inc-123",
			severity: "SEV1",
			providerKey: "openai",
			title: "SEV-1: OpenAI degraded",
			summary: "All chat completions failing",
			link: "/app/admin/monitoring?incident=inc-123",
			startedAtIso: new Date(0).toISOString(),
		});
		expect(helperSpy).not.toHaveBeenCalled();
	});

	it("returns a skipped result on the fire path", async () => {
		const result = await notifyIncident({
			source: "errorRate",
			incidentId: "inc-2",
			severity: "SEV2",
			title: "x",
			summary: "y",
			link: "/x",
			startedAtIso: new Date().toISOString(),
		});
		expect(result).toEqual({
			adminRowsWritten: 0,
			perOrgRowsWritten: 0,
			skipped: true,
			skipReason: "in-app-incident-notifications-removed",
		});
	});

	it("returns a skipped result on the recovery path too", async () => {
		const result = await notifyIncident({
			source: "integration",
			incidentId: "inc-XYZ",
			severity: "SEV2",
			providerKey: "stripe",
			title: "Resolved: Stripe",
			summary: "back to operational",
			link: "/x",
			startedAtIso: new Date().toISOString(),
			isRecovery: true,
		});
		expect(result.skipped).toBe(true);
		expect(result.adminRowsWritten).toBe(0);
		expect(result.perOrgRowsWritten).toBe(0);
		expect(helperSpy).not.toHaveBeenCalled();
	});
});
