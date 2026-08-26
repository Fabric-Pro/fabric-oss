import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted to avoid reference errors)
// ---------------------------------------------------------------------------

const { mockFindFirst, mockFetch } = vi.hoisted(() => ({
	mockFindFirst: vi.fn(),
	mockFetch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: mockFindFirst,
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
}));

import { executeSlackTool } from "../../src/slack/index";

function slackFilesListResponse(files: unknown[]) {
	return {
		ok: true,
		json: async () => ({ ok: true, files }),
	};
}

describe("list_huddle_canvases (is_huddle_canvas filter + field passthrough)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindFirst.mockResolvedValue({
			id: "int-1",
			credentials: JSON.stringify({ access_token: "xoxb-test" }),
		});
		// @ts-expect-error - assigning a mock to the global fetch
		global.fetch = mockFetch;
	});

	it("passes huddle fields through and lets the caller distinguish huddle vs non-huddle files", async () => {
		mockFetch.mockResolvedValueOnce(
			slackFilesListResponse([
				{
					id: "F_HUDDLE",
					title: "Huddle notes",
					mimetype: "application/vnd.slack-docs",
					filetype: "quip",
					created: 1_700_000_000,
					url_private: "https://files.slack.com/F_HUDDLE",
					is_huddle_canvas: true,
					huddle_transcript_file_id: "F_TRANSCRIPT",
					huddle_summary_id: "S_1",
					huddle_date_start: 1_700_000_100,
					huddle_date_end: 1_700_000_900,
				},
				{
					id: "F_REGULAR",
					title: "A shared design doc",
					filetype: "quip",
					is_huddle_canvas: false,
				},
				{
					id: "F_IMAGE",
					filetype: "png",
				},
			]),
		);

		const result = (await executeSlackTool(
			"list_huddle_canvases",
			{ channelId: "C123", tsFrom: 1_699_000_000 },
			"user-1",
		)) as {
			files: Array<{
				id: string;
				isHuddleCanvas: boolean;
				huddleTranscriptFileId?: string;
				huddleSummaryId?: string;
				urlPrivate?: string;
				channelId: string;
			}>;
		};

		const huddles = result.files.filter((f) => f.isHuddleCanvas);
		expect(huddles).toHaveLength(1);
		const huddle = huddles[0];
		expect(huddle.id).toBe("F_HUDDLE");
		expect(huddle.huddleTranscriptFileId).toBe("F_TRANSCRIPT");
		expect(huddle.huddleSummaryId).toBe("S_1");
		expect(huddle.urlPrivate).toBe("https://files.slack.com/F_HUDDLE");
		expect(huddle.channelId).toBe("C123");

		// Non-huddle files are present but flagged false (caller filters them out).
		expect(
			result.files.find((f) => f.id === "F_REGULAR")?.isHuddleCanvas,
		).toBe(false);
		expect(
			result.files.find((f) => f.id === "F_IMAGE")?.isHuddleCanvas,
		).toBe(false);
	});

	it("forwards ts_from as the forward-only lower bound", async () => {
		mockFetch.mockResolvedValueOnce(slackFilesListResponse([]));

		await executeSlackTool(
			"list_huddle_canvases",
			{ channelId: "C123", tsFrom: 1_699_999_999 },
			"user-1",
		);

		const body = mockFetch.mock.calls[0][1].body as string;
		expect(body).toContain("ts_from=1699999999");
		expect(body).toContain("channel=C123");
	});
});
