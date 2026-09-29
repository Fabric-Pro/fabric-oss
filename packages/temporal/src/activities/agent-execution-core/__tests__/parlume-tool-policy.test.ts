import { describe, expect, it } from "vitest";
import { isParlumeMeetingToolAllowed } from "../parlume-tool-policy";

describe("isParlumeMeetingToolAllowed", () => {
	it.each([
		"create_view",
		"fabric_create_frame",
		"get_or_create_issue",
		"run_agent",
		"unclassified_capability",
	])("denies %s", (toolName) => {
		expect(isParlumeMeetingToolAllowed(toolName)).toBe(false);
	});

	it.each([
		"project_search",
		"github_list_pull_requests",
		"slack_read_thread",
	])(
		"denies apparent reads without a meeting-scoped capability contract: %s",
		(toolName) => {
			expect(isParlumeMeetingToolAllowed(toolName)).toBe(false);
		},
	);
});
