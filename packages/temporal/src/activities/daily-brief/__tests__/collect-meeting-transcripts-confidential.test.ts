import { describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return { ...actual, db: { projectMeetingTranscript: { findMany } } };
});

import { collectMeetingTranscripts } from "../collect-meeting-transcripts";

describe("collectMeetingTranscripts", () => {
	it("leaves a confidential series' transcripts out of the brief", async () => {
		findMany.mockResolvedValue([]);

		await collectMeetingTranscripts({
			projectId: "project-1",
			organizationId: "example-org",
			timeWindowStart: "2026-11-01T00:00:00.000Z",
			timeWindowEnd: "2026-11-02T00:00:00.000Z",
		});

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "project-1",
					project: { organizationId: "example-org" },
					linkedMeeting: { confidential: false },
				}),
			}),
		);
	});
});
