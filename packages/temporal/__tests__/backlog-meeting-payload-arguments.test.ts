import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	parallel: true,
	fetchMeetingTranscript: vi.fn(),
	analyzeContextAndPropose: vi.fn(),
}));

// Exercise argument construction in the real workflow without starting a server.
// This proves the handoff; recorded-history replay remains a separate check.
vi.mock("@temporalio/workflow", async () => ({
	ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
	CancellationScope: {
		nonCancellable: async (fn: () => Promise<unknown>) => fn(),
	},
	defineQuery: (name: string) => name,
	defineSignal: (name: string) => name,
	setHandler: vi.fn(),
	workflowInfo: () => ({ workflowId: "example-workflow" }),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	patched: (id: string) =>
		id === "backlog-parallel-meeting-transcripts" && mocks.parallel,
	proxyActivities: () => ({
		fetchMeetingTranscript: mocks.fetchMeetingTranscript,
		analyzeContextAndPropose: mocks.analyzeContextAndPropose,
		retrieveProjectRagContext: async () => ({ success: false }),
		fetchBacklogSnapshot: async () => ({
			epics: [],
			orphanFeatures: [],
			orphanStories: [],
		}),
	}),
}));

import { backlogContextAnalysisWorkflow } from "../src/workflows/backlog-context-analysis-workflow";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.fetchMeetingTranscript.mockImplementation(
		async (input: { joinUrl: string }) => ({
			success: true,
			transcript: input.joinUrl,
		}),
	);
	mocks.analyzeContextAndPropose.mockResolvedValue({
		changes: [],
		summary: "Analyzed",
		contextSummary: "Meetings",
	});
});

it.each([true, false])(
	"passes the complete selection count in the parallel=%s fetch path",
	async (parallel) => {
		mocks.parallel = parallel;
		const selectedMeetings = Array.from({ length: 13 }, (_, i) => ({
			joinUrl: `https://example.com/meeting/${i}`,
		}));
		const result = await backlogContextAnalysisWorkflow({
			projectId: "example-project",
			userId: "example-user",
			organizationId: "example-org",
			contextSources: { fetchTeamsMessages: false, selectedMeetings },
			userPrompt: "Analyze the meetings",
		});
		expect(result.success).toBe(true);
		expect(mocks.fetchMeetingTranscript).toHaveBeenCalledTimes(13);
		for (const [input] of mocks.fetchMeetingTranscript.mock.calls) {
			expect(input).toMatchObject({ selectedMeetingCount: 13 });
		}
		expect(mocks.analyzeContextAndPropose).toHaveBeenCalledWith(
			expect.objectContaining({
				fetchedContext: {
					meetingTranscripts: selectedMeetings.map(
						(meeting) => meeting.joinUrl,
					),
				},
			}),
		);
	},
);
