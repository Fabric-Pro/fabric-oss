import { describe, expect, it } from "vitest";
import {
	validateBacklogAnalysisOptions,
	validateBacklogAnalysisSources,
} from "../backlog-analysis-sources";

describe("validateBacklogAnalysisSources", () => {
	it.each([
		undefined,
		null,
		{},
		"invalid",
		[{}],
		[
			null,
			1,
			"invalid",
			{},
			{ joinUrl: "" },
			{ joinUrl: "   " },
			{ joinUrl: 1 },
		],
	])("filters invalid meetings: %j", (selectedMeetings) => {
		expect(
			validateBacklogAnalysisSources({ selectedMeetings })
				.selectedMeetings,
		).toEqual([]);
	});
	it("preserves valid meetings and only string start times", () => {
		expect(
			validateBacklogAnalysisSources({
				selectedMeetings: [
					{
						joinUrl: "https://example.com/one",
						startTime: "2026-10-20T10:00:00Z",
						extra: true,
					},
					{ joinUrl: "https://example.com/two", startTime: 42 },
					{ joinUrl: "https://example.com/three" },
				],
			}).selectedMeetings,
		).toEqual([
			{
				joinUrl: "https://example.com/one",
				startTime: "2026-10-20T10:00:00Z",
			},
			{ joinUrl: "https://example.com/two" },
			{ joinUrl: "https://example.com/three" },
		]);
	});
	it.each([
		undefined,
		null,
		{},
		"invalid",
		[{}],
		[
			null,
			{},
			{ projectContextId: "" },
			{ projectContextId: "  " },
			{ projectContextId: 1 },
		],
	])("filters invalid channels: %j", (selectedChannels) => {
		expect(
			validateBacklogAnalysisSources({ selectedChannels })
				.selectedChannels,
		).toEqual([]);
	});
	it("preserves valid channel IDs", () => {
		expect(
			validateBacklogAnalysisSources({
				selectedChannels: [
					{ projectContextId: "example-channel", extra: true },
				],
			}).selectedChannels,
		).toEqual([{ projectContextId: "example-channel" }]);
	});
});

describe("analysis date range", () => {
	it.each([7, 14, 30, 60, 90])(
		"preserves allowed daysBack %s",
		(daysBack) => {
			expect(validateBacklogAnalysisSources({ daysBack }).daysBack).toBe(
				daysBack,
			);
		},
	);
	it.each([undefined, null, "30", 0, 1, -7, 15, 91, Number.NaN, {}, []])(
		"drops invalid daysBack %j",
		(daysBack) => {
			expect(
				validateBacklogAnalysisSources({ daysBack }).daysBack,
			).toBeUndefined();
		},
	);
});

describe("validateBacklogAnalysisOptions", () => {
	it.each([undefined, null, {}, 42, "", "   "])(
		"drops invalid prompt %j",
		(userPrompt) => {
			expect(
				validateBacklogAnalysisOptions({ userPrompt }).userPrompt,
			).toBeUndefined();
		},
	);
	it.each([undefined, null, {}, 1, "false"])(
		"drops non-boolean Slack flag %j",
		(fetchSlackMessages) => {
			expect(
				validateBacklogAnalysisOptions({ fetchSlackMessages })
					.fetchSlackMessages,
			).toBeUndefined();
		},
	);
	it.each([true, false])(
		"preserves boolean Slack flag %s",
		(fetchSlackMessages) => {
			expect(
				validateBacklogAnalysisOptions({ fetchSlackMessages })
					.fetchSlackMessages,
			).toBe(fetchSlackMessages);
		},
	);
	it("preserves valid options and filters invalid Notion page IDs", () => {
		expect(
			validateBacklogAnalysisOptions({
				userPrompt: " Review context ",
				fetchSlackMessages: false,
				notionPageIds: [null, {}, 2, "", "  ", "example-page"],
				notionMcpConfigId: "example-config",
			}),
		).toEqual({
			userPrompt: " Review context ",
			fetchSlackMessages: false,
			notionPageIds: ["example-page"],
			notionMcpConfigId: "example-config",
		});
	});
	it.each([undefined, null, {}, "invalid", 1])(
		"drops non-array Notion pages %j",
		(notionPageIds) => {
			expect(
				validateBacklogAnalysisOptions({ notionPageIds }).notionPageIds,
			).toEqual([]);
		},
	);
	it.each([undefined, null, {}, 1])(
		"drops non-string Notion config %j",
		(notionMcpConfigId) => {
			expect(
				validateBacklogAnalysisOptions({ notionMcpConfigId })
					.notionMcpConfigId,
			).toBeUndefined();
		},
	);
});
