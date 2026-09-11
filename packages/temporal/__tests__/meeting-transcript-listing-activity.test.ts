/**
 * Fizzy #2473 — the contract the iterative agent depends on.
 *
 * The whole point of this tool is that "there were no meetings on that date" and
 * "the lookup did not work" must never reach the model as the same sentence. The
 * bug it replaces was exactly that conflation: a retrieval miss rendered as a
 * confident statement of absence. So the failure path is the interesting one and
 * is pinned here, alongside the access gate and the phrasing of a genuinely
 * empty range.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hasProjectAccess = vi.fn();
const listMeetingTranscriptsByDate = vi.fn();

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => hasProjectAccess(...args),
	listMeetingTranscriptsByDate: (...args: unknown[]) =>
		listMeetingTranscriptsByDate(...args),
}));

vi.mock("@temporalio/activity", () => ({
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { listMeetingTranscriptsActivity } from "../src/activities/project-metadata";

const BASE = {
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	hasProjectAccess.mockResolvedValue(true);
});

describe("listMeetingTranscriptsActivity", () => {
	it("propagates a lookup failure instead of reporting an empty result", async () => {
		// If this ever returns {transcriptCount: 0} on error, the model is told
		// the meetings do not exist when in fact the query broke — which is the
		// original bug wearing a new hat.
		listMeetingTranscriptsByDate.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			listMeetingTranscriptsActivity({ ...BASE }),
		).rejects.toThrow("connection reset");
	});

	it("refuses when the caller has no access to the project", async () => {
		hasProjectAccess.mockResolvedValue(false);

		const result = await listMeetingTranscriptsActivity({ ...BASE });

		expect(result.transcriptCount).toBe(0);
		expect(result.response).toContain("don't have access");
		expect(listMeetingTranscriptsByDate).not.toHaveBeenCalled();
	});

	it("passes a single-day range through as the WHOLE day", async () => {
		// The reported meeting was at 16:01. A `to` of midnight matches nothing.
		listMeetingTranscriptsByDate.mockResolvedValue({ items: [], total: 0 });

		await listMeetingTranscriptsActivity({
			...BASE,
			from: "2026-09-10",
			to: "2026-09-10",
		});

		const args = listMeetingTranscriptsByDate.mock.calls[0][0] as {
			from: Date;
			to: Date;
		};
		expect(args.from.toISOString()).toBe("2026-09-10T00:00:00.000Z");
		expect(args.to.toISOString()).toBe("2026-09-10T23:59:59.999Z");
	});

	it("says what it searched when a range is genuinely empty", async () => {
		listMeetingTranscriptsByDate.mockResolvedValue({ items: [], total: 0 });

		const result = await listMeetingTranscriptsActivity({
			...BASE,
			from: "2026-09-10",
			to: "2026-09-10",
		});

		expect(result.response).toContain("on 2026-09-10");
		expect(result.response).toContain("direct lookup");
		expect(result.transcriptCount).toBe(0);
	});

	it("returns the meeting's own date and the total for a hit", async () => {
		listMeetingTranscriptsByDate.mockResolvedValue({
			items: [
				{
					meetingSubject: "Fabric DSU",
					meetingDate: new Date("2026-09-10T16:01:34.000Z"),
					speakerNames: ["Ada Lovelace"],
					summary: null,
					wasSummarized: false,
				},
			],
			total: 157,
		});

		const result = await listMeetingTranscriptsActivity({ ...BASE });

		expect(result.transcriptCount).toBe(1);
		expect(result.total).toBe(157);
		expect(result.response).toContain("2026-09-10 — Fabric DSU");
		expect(result.response).toContain("showing the 1 most recent");
	});
});
