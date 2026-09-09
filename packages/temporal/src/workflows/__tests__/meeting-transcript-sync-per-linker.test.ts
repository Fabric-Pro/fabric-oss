/**
 * A project reads one calendar per linker, not one per project (Fizzy #2354).
 *
 * Before this, the account that switched sync on was frozen into the workflow's
 * arguments and every linked meeting was looked for in THAT person's calendar.
 * A meeting somebody else linked was simply never there — and Microsoft answers
 * an unmatched calendar query with "no meetings" rather than an error, so
 * nothing threw, nothing was logged, the run stamped a clean last-run, and the
 * settings panel went on reporting a healthy sync while collecting only what
 * one person could see. Confirmed on staging: of three linked meetings, the two
 * linked by the bound account kept collecting and the third captured one
 * transcript, at the moment its linker pressed Sync now, and never again.
 *
 * The workflow is driven directly in one-shot mode, which runs exactly one
 * cycle and returns — so these assertions are about the real loop, not a
 * re-implementation of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	acts: {} as Record<string, ReturnType<typeof vi.fn>>,
	perLinker: true,
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		// `defineSignal` / `defineQuery` run at module scope and stay real.
		proxyActivities: () =>
			new Proxy(
				{},
				{
					get: (_target, name: string) => captured.acts[name],
				},
			),
		setHandler: () => undefined,
		patched: () => captured.perLinker,
		condition: async () => false,
		workflowInfo: () => ({
			historyLength: 1,
			continueAsNewSuggested: false,
		}),
		continueAsNew: async () => undefined,
	};
});

import { meetingTranscriptSyncWorkflow } from "../meeting-transcript-sync";

const INPUT = {
	projectId: "proj_1",
	// Whoever last enabled the sync. Since #2354 it is only the fallback.
	userId: "user_enabler",
	organizationId: "org_1",
	intervalMinutes: 0,
};

const MEETINGS = [
	{
		id: "lm_1",
		joinUrl: "https://teams.example/one",
		subject: "Weekly sync",
		userId: "user_enabler",
	},
	{
		id: "lm_2",
		joinUrl: "https://teams.example/two",
		subject: "Client call",
		userId: "user_other",
	},
	{
		id: "lm_3",
		joinUrl: "https://teams.example/three",
		subject: "Design review",
		userId: "user_other",
	},
];

/** The calls each account's calendar read answered with. */
function calendarCalls() {
	return captured.acts.listRecentMeetingInstancesForLinkedUrls.mock.calls.map(
		(call) => call[0] as Record<string, unknown>,
	);
}

beforeEach(() => {
	captured.perLinker = true;
	captured.acts = {
		getLinkedMeetingJoinUrlsActivity: vi.fn(async () => MEETINGS),
		listRecentMeetingInstancesForLinkedUrls: vi.fn(async () => []),
		fetchAndStoreMeetingTranscript: vi.fn(async () => ({
			success: true,
			wasSummarized: false,
			transcriptsFetched: 1,
		})),
		updateMeetingTranscriptSyncLastRunActivity: vi.fn(
			async () => undefined,
		),
	};
});

describe("meetingTranscriptSyncWorkflow — one calendar per linker", () => {
	it("reads each account's calendar once, for only that account's meetings", async () => {
		await meetingTranscriptSyncWorkflow(INPUT);

		const calls = calendarCalls();
		expect(calls).toHaveLength(2);

		expect(calls[0]).toMatchObject({
			userId: "user_enabler",
			linkedJoinUrls: ["https://teams.example/one"],
			linkedMeetingIds: ["lm_1"],
		});
		expect(calls[1]).toMatchObject({
			userId: "user_other",
			linkedJoinUrls: [
				"https://teams.example/two",
				"https://teams.example/three",
			],
			linkedMeetingIds: ["lm_2", "lm_3"],
		});
	});

	it("names the meetings each read answers for, so failure state lands on those rows only", async () => {
		// Without this scoping the activity stamps or clears the whole project:
		// one dead connection would blame everyone else's meetings, and then
		// the next healthy account's pass would clear the dead one's failures.
		await meetingTranscriptSyncWorkflow(INPUT);

		for (const call of calendarCalls()) {
			expect(call.linkedMeetingIds).toBeDefined();
			expect((call.linkedMeetingIds as string[]).length).toBeGreaterThan(
				0,
			);
		}
	});

	it("reads a meeting with no linker under the account the sync was enabled with", async () => {
		// Rows predating the column. They are exactly the ones the old
		// project-wide account was already reading, so nothing moves.
		captured.acts.getLinkedMeetingJoinUrlsActivity = vi.fn(async () => [
			{ ...MEETINGS[0], userId: null },
			MEETINGS[1],
		]);

		await meetingTranscriptSyncWorkflow(INPUT);

		const calls = calendarCalls();
		expect(calls.map((c) => c.userId)).toEqual([
			"user_enabler",
			"user_other",
		]);
	});

	it("fetches each transcript under the account that linked the meeting", async () => {
		// The whole point: the calendar match is only half of it. Graph grants
		// transcript access per person too, so a fetch under the wrong account
		// resolves nothing.
		captured.acts.listRecentMeetingInstancesForLinkedUrls = vi.fn(
			async (input: { linkedJoinUrls: string[] }) =>
				input.linkedJoinUrls.map((joinUrl) => ({
					id: `occ-${joinUrl}`,
					subject: "Occurrence",
					startTime: "2026-09-08T10:00:00.000Z",
					joinUrl,
					organizer: "someone",
				})),
		);

		await meetingTranscriptSyncWorkflow(INPUT);

		const fetches =
			captured.acts.fetchAndStoreMeetingTranscript.mock.calls.map(
				(call) =>
					call[0] as { linkedMeetingId: string; userId: string },
			);
		expect(fetches.map((f) => [f.linkedMeetingId, f.userId])).toEqual([
			["lm_1", "user_enabler"],
			["lm_2", "user_other"],
			["lm_3", "user_other"],
		]);
	});

	it("keeps syncing the other accounts when one calendar cannot be read", async () => {
		captured.acts.listRecentMeetingInstancesForLinkedUrls = vi.fn(
			async (input: { userId: string }) => {
				if (input.userId === "user_other") {
					throw new Error("503 Service Unavailable");
				}
				return [];
			},
		);

		await meetingTranscriptSyncWorkflow({
			...INPUT,
			intervalMinutes: 0,
		});

		// One person's dead connection used to be indistinguishable from a
		// quiet project. It must not also stop everybody else's meetings.
		expect(calendarCalls()).toHaveLength(2);
		expect(
			captured.acts.updateMeetingTranscriptSyncLastRunActivity,
		).toHaveBeenCalled();
	});

	it("fails a one-shot only when no account at all could be read", async () => {
		captured.acts.listRecentMeetingInstancesForLinkedUrls = vi.fn(
			async () => {
				throw new Error("503 Service Unavailable");
			},
		);

		await expect(meetingTranscriptSyncWorkflow(INPUT)).rejects.toThrow(
			"503 Service Unavailable",
		);

		// A cycle that saw nothing must not report itself as a completed sync —
		// the stale last-run is the only thing that shows the outage.
		expect(
			captured.acts.updateMeetingTranscriptSyncLastRunActivity,
		).not.toHaveBeenCalled();
	});

	it("leaves a pre-#2354 execution reading one calendar, exactly as its history recorded", async () => {
		// `patched()` is false while an execution started before this shipped
		// replays. Its history has ONE calendar read per cycle, under the
		// frozen account; producing two would be a non-determinism error.
		captured.perLinker = false;

		await meetingTranscriptSyncWorkflow(INPUT);

		const calls = calendarCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			userId: "user_enabler",
			linkedJoinUrls: MEETINGS.map((m) => m.joinUrl),
		});
		// And no argument the old activity never received.
		expect(calls[0].linkedMeetingIds).toBeUndefined();
	});
});
