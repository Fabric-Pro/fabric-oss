import { describe, expect, it } from "vitest";
import { countPendingPublishes } from "../instructions-pending-publishes";

const NOW = new Date("2026-10-01T12:00:00.000Z").getTime();
const recent = new Date(NOW - 60_000);

describe("countPendingPublishes", () => {
	it("counts the checks still running that will publish themselves", () => {
		expect(
			countPendingPublishes({
				snapshots: [
					{ status: "VALIDATING", createdAt: recent },
					{ status: "RECEIVING", createdAt: recent },
					{ status: "READY", createdAt: recent },
					{ status: "FAILED", createdAt: recent },
				],
				syncRunPending: false,
				now: NOW,
			}),
		).toBe(2);
	});

	it("leaves out a check that will not publish on its own", () => {
		expect(
			countPendingPublishes({
				snapshots: [
					{
						status: "VALIDATING",
						createdAt: recent,
						publishOnReady: false,
					},
					{
						status: "VALIDATING",
						createdAt: recent,
						proposalStatus: "PENDING",
					},
				],
				syncRunPending: false,
				now: NOW,
			}),
		).toBe(0);
	});

	it("leaves out an upload nobody finished: its row is abandoned, not being checked", () => {
		const longAgo = new Date(NOW - 7 * 24 * 60 * 60 * 1000);

		expect(
			countPendingPublishes({
				snapshots: [{ status: "RECEIVING", createdAt: longAgo }],
				syncRunPending: false,
				now: NOW,
			}),
		).toBe(0);
	});

	it("counts a repository sync run that has not staged its snapshot yet", () => {
		expect(
			countPendingPublishes({
				snapshots: [{ status: "VALIDATING", createdAt: recent }],
				syncRunPending: true,
				now: NOW,
			}),
		).toBe(2);
	});
});
