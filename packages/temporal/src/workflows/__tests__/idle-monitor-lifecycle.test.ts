/**
 * A polling monitor with nothing linked must not grow one history forever.
 *
 * An empty tick returned to the loop before the `continueAsNew` check at the end
 * of a working tick, so the check was unreachable. On a staging worker one such
 * run reached 43,722 events, its replay outlasted the workflow task timeout, and
 * its project no longer existed. These tests drive the real loops.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	acts: {} as Record<string, ReturnType<typeof vi.fn>>,
	patchedResult: true,
	suggested: false,
	/** Interval waits that time out into a tick before the mock cancels. */
	ticksAllowed: 2,
	continueAsNew: vi.fn(),
}));

class ContinuedAsNew extends Error {}

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
					get: (_target, name: string) => state.acts[name],
				},
			),
		setHandler: () => undefined,
		log: { info: () => undefined, warn: () => undefined },
		patched: () => state.patchedResult,
		condition: async () => {
			if (state.ticksAllowed === 0) {
				return true;
			}
			state.ticksAllowed -= 1;
			return false;
		},
		workflowInfo: () => ({
			historyLength: 1,
			continueAsNewSuggested: state.suggested,
		}),
		continueAsNew: async (input: unknown) => {
			state.continueAsNew(input);
			throw new ContinuedAsNew();
		},
	};
});

import { CancelledFailure } from "@temporalio/workflow";
import { meetingTranscriptSyncWorkflow } from "../meeting-transcript-sync";
import { slackHuddleIngestWorkflow } from "../slack-huddle-ingest";
import { teamsChannelMonitorWorkflow } from "../teams-channel-monitor";
import { teamsChatMonitorWorkflow } from "../teams-chat-monitor";

interface MonitorInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	intervalMinutes: number;
}

const MONITORS: {
	name: string;
	run: (input: MonitorInput) => Promise<void>;
	linkedActivity: string;
}[] = [
	{
		name: "teamsChannelMonitorWorkflow",
		run: teamsChannelMonitorWorkflow,
		linkedActivity: "getLinkedChannelsForMonitorActivity",
	},
	{
		name: "teamsChatMonitorWorkflow",
		run: teamsChatMonitorWorkflow,
		linkedActivity: "getLinkedChatsForMonitorActivity",
	},
	{
		name: "slackHuddleIngestWorkflow",
		run: slackHuddleIngestWorkflow,
		linkedActivity: "getLinkedHuddleChannelsActivity",
	},
	{
		name: "meetingTranscriptSyncWorkflow",
		run: meetingTranscriptSyncWorkflow,
		linkedActivity: "getLinkedMeetingJoinUrlsActivity",
	},
];

const INPUT: MonitorInput = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	intervalMinutes: 60,
};

const projectExists = () => state.acts.monitoredProjectExistsActivity;

beforeEach(() => {
	state.patchedResult = true;
	state.suggested = false;
	state.ticksAllowed = 2;
	state.continueAsNew.mockReset();
	state.acts = {
		monitoredProjectExistsActivity: vi.fn(async () => true),
	};
	for (const monitor of MONITORS) {
		state.acts[monitor.linkedActivity] = vi.fn(async () => []);
	}
});

describe.each(MONITORS)("$name with nothing linked", (monitor) => {
	const linked = () => state.acts[monitor.linkedActivity];

	it("continues as new when the server suggests it", async () => {
		state.suggested = true;

		await expect(monitor.run(INPUT)).rejects.toBeInstanceOf(ContinuedAsNew);

		expect(state.continueAsNew).toHaveBeenCalledWith(INPUT);
		expect(linked()).toHaveBeenCalledTimes(1);
	});

	it("keeps polling a live project while the history is small", async () => {
		await monitor.run(INPUT);

		expect(linked()).toHaveBeenCalledTimes(2);
		expect(projectExists()).toHaveBeenCalledTimes(2);
		expect(projectExists()).toHaveBeenCalledWith({ projectId: "proj_1" });
		expect(state.continueAsNew).not.toHaveBeenCalled();
	});

	it("ends when the project no longer exists, rather than continuing as new", async () => {
		state.suggested = true;
		state.ticksAllowed = 5;
		projectExists().mockResolvedValue(false);

		await monitor.run(INPUT);

		expect(linked()).toHaveBeenCalledTimes(1);
		expect(state.continueAsNew).not.toHaveBeenCalled();
	});

	it("keeps a monitor running when the project check fails", async () => {
		// A database outage also empties the linked list, so this is the case
		// that must never read as a deleted project.
		projectExists().mockRejectedValue(new Error("connection refused"));

		await monitor.run(INPUT);

		expect(linked()).toHaveBeenCalledTimes(2);
		expect(state.continueAsNew).not.toHaveBeenCalled();
	});

	it("still bounds the history when the project check fails", async () => {
		state.suggested = true;
		projectExists().mockRejectedValue(new Error("connection refused"));

		await expect(monitor.run(INPUT)).rejects.toBeInstanceOf(ContinuedAsNew);
	});

	it("does not swallow a workflow cancellation during the check", async () => {
		projectExists().mockRejectedValue(new CancelledFailure("cancelled"));

		await expect(monitor.run(INPUT)).rejects.toBeInstanceOf(
			CancelledFailure,
		);
	});

	it("schedules nothing new while replaying a history from before the patch", async () => {
		// `patched()` is false for these ticks. Their history holds only the
		// linked read and the next timer, so any new command is non-determinism.
		state.patchedResult = false;
		state.suggested = true;

		await monitor.run(INPUT);

		expect(linked()).toHaveBeenCalledTimes(2);
		expect(projectExists()).not.toHaveBeenCalled();
		expect(state.continueAsNew).not.toHaveBeenCalled();
	});

	it("ends a one-shot run without checking the project", async () => {
		await monitor.run({ ...INPUT, intervalMinutes: 0 });

		expect(linked()).toHaveBeenCalledTimes(1);
		expect(projectExists()).not.toHaveBeenCalled();
	});
});

describe("meetingTranscriptSyncWorkflow one-shot before the patch", () => {
	it("replays its unpaused polling as recorded", async () => {
		state.patchedResult = false;
		const stop = new Error("second poll");
		state.acts.getLinkedMeetingJoinUrlsActivity = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(stop);

		await expect(
			meetingTranscriptSyncWorkflow({ ...INPUT, intervalMinutes: 0 }),
		).rejects.toBe(stop);
	});
});

describe("a monitor tick with something linked", () => {
	beforeEach(() => {
		state.ticksAllowed = 1;
		state.acts.getLinkedChannelsForMonitorActivity = vi.fn(async () => [
			{
				id: "link_1",
				teamId: "team_1",
				channelId: "channel_1",
				teamName: "Team",
				channelName: "Channel",
				channelWebUrl: null,
				lastMessageCreatedAt: null,
				lastMessageId: null,
				scanPageToken: null,
			},
		]);
		state.acts.fetchNewChannelThreadsActivity = vi.fn(async () => ({
			success: true,
			threads: [],
			updatedScanPageToken: null,
			fetchedAllPages: true,
		}));
		state.acts.setTeamsChannelScanPageTokenActivity = vi.fn(
			async () => undefined,
		);
		state.acts.clearTeamsChannelFailureActivity = vi.fn(
			async () => undefined,
		);
		state.acts.updateTeamsChannelMonitorLastRunActivity = vi.fn(
			async () => undefined,
		);
	});

	it("does not spend an activity asking whether the project exists", async () => {
		await teamsChannelMonitorWorkflow(INPUT);

		expect(projectExists()).not.toHaveBeenCalled();
	});

	it("keeps its existing continue-as-new", async () => {
		state.suggested = true;

		await expect(teamsChannelMonitorWorkflow(INPUT)).rejects.toBeInstanceOf(
			ContinuedAsNew,
		);
		expect(state.continueAsNew).toHaveBeenCalledWith(INPUT);
	});
});
