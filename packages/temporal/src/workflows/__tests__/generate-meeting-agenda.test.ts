import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	generateAgendaActivity: vi.fn(),
	markAgendaFailedActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generateMeetingAgendaWorkflow } from "../generate-meeting-agenda";

const INPUT = {
	agendaId: "ag_1",
	projectId: "p1",
	organizationId: "org1",
	userId: "u1",
	linkedMeetingId: "lm_1",
};

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.generateAgendaActivity.mockResolvedValue({ status: "READY" });
	activityStubs.markAgendaFailedActivity.mockResolvedValue(undefined);
});

describe("generateMeetingAgendaWorkflow", () => {
	it("returns READY on the happy path", async () => {
		const result = await generateMeetingAgendaWorkflow(INPUT);

		expect(result).toEqual({ status: "READY" });
		expect(activityStubs.markAgendaFailedActivity).not.toHaveBeenCalled();
	});

	it("never throws to the fire-and-forget caller; flips the row FAILED instead", async () => {
		activityStubs.generateAgendaActivity.mockRejectedValue(
			new Error("model timeout"),
		);

		const result = await generateMeetingAgendaWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED" });
		expect(activityStubs.markAgendaFailedActivity).toHaveBeenCalledWith({
			agendaId: "ag_1",
			message: "model timeout",
		});
	});

	it("still returns FAILED when the failure marker itself fails", async () => {
		activityStubs.generateAgendaActivity.mockRejectedValue(
			new Error("boom"),
		);
		activityStubs.markAgendaFailedActivity.mockRejectedValue(
			new Error("db down"),
		);

		await expect(generateMeetingAgendaWorkflow(INPUT)).resolves.toEqual({
			status: "FAILED",
		});
	});
});
