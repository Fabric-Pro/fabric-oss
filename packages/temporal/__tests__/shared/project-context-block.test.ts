/**
 * Tests for the conditional tool-guidance line in the `<project_context>`
 * block. The block is shared across direct-chat and the trigger-system
 * runtime, so we only want to mention live-integration search tools
 * (search_slack_messages, search_teams_messages) when the project actually
 * has the corresponding integration linked — otherwise we'd nudge the LLM
 * toward calling a tool with nothing to find.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted to the top of the file, so any
// references to module-scope variables must come from `vi.hoisted`.
const { getProjectMetadataActivityMock } = vi.hoisted(() => ({
	getProjectMetadataActivityMock: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	log: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	// `formatContextAvailabilityText` is exercised for real elsewhere; the
	// block under test only forwards its output as text, so a deterministic
	// stub keeps assertions focused on the tool-guidance line.
	formatContextAvailabilityText: () => "AVAILABILITY_STUB",
}));

vi.mock("../../src/activities/project-metadata", () => ({
	getProjectMetadataActivity: getProjectMetadataActivityMock,
}));

import { buildProjectContextBlock } from "../../src/activities/shared/project-context-block";

const BASE_META = {
	name: "Acme Project",
	description: null,
	goals: null,
	techStack: [],
	features: [],
	repositoryUrls: [],
	repositoryUrl: null,
	contextCount: 5,
	documentCount: 2,
	hasCodeAnalysis: false,
	transcriptCount: 0,
	fileCount: 0,
	integrationCount: 0,
	teamsCount: 0,
	slackCount: 0,
	websiteSources: [],
};

describe("buildProjectContextBlock — tool-guidance line", () => {
	beforeEach(() => {
		getProjectMetadataActivityMock.mockReset();
	});

	it("mentions only project_rag_query when no Slack or Teams integration is linked", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce({ ...BASE_META });

		const block = await buildProjectContextBlock("project-1", {
			userId: "user-1",
		});

		expect(block).toContain("Use project_rag_query");
		expect(block).not.toContain("search_slack_messages");
		expect(block).not.toContain("search_teams_messages");
	});

	it("adds search_slack_messages guidance when slackCount > 0", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce({
			...BASE_META,
			slackCount: 2,
		});

		const block = await buildProjectContextBlock("project-1", {
			userId: "user-1",
		});

		expect(block).toContain("Use project_rag_query");
		expect(block).toContain("search_slack_messages");
		expect(block).not.toContain("search_teams_messages");
	});

	it("adds search_teams_messages guidance when teamsCount > 0", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce({
			...BASE_META,
			teamsCount: 3,
		});

		const block = await buildProjectContextBlock("project-1", {
			userId: "user-1",
		});

		expect(block).toContain("Use project_rag_query");
		expect(block).toContain("search_teams_messages");
		expect(block).not.toContain("search_slack_messages");
	});

	it("mentions both tools when both integrations are linked", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce({
			...BASE_META,
			slackCount: 1,
			teamsCount: 4,
		});

		const block = await buildProjectContextBlock("project-1", {
			userId: "user-1",
		});

		expect(block).toContain("search_slack_messages");
		expect(block).toContain("search_teams_messages");
	});

	it("returns null when project metadata cannot be loaded", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce(null);

		const block = await buildProjectContextBlock("missing-project", {
			userId: "user-1",
		});

		expect(block).toBeNull();
	});

	it("renders single untagged integration with Repositories: prefix", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce({
			...BASE_META,
			repositoryRoles: [
				{
					url: "https://github.com/example-org/single-repo",
					provider: "GITHUB",
					roleTag: null,
				},
			],
		});

		const block = await buildProjectContextBlock("project-1", {
			userId: "user-1",
		});

		expect(block).toContain(
			"Repositories: https://github.com/example-org/single-repo",
		);
	});

	it("renders tagged and untagged repositories in <project_context>", async () => {
		getProjectMetadataActivityMock.mockResolvedValueOnce({
			...BASE_META,
			repositoryRoles: [
				{
					url: "https://github.com/example-org/legacy-app",
					provider: "GITHUB",
					roleTag: "Legacy",
				},
				{
					url: "https://github.com/example-org/new-app",
					provider: "GITHUB",
					roleTag: "New",
				},
			],
		});

		const block = await buildProjectContextBlock("project-1", {
			userId: "user-1",
		});

		expect(block).toContain(
			"Repositories:\n- https://github.com/example-org/legacy-app [Role: Legacy]\n- https://github.com/example-org/new-app [Role: New]",
		);
	});
});
