/**
 * Unit tests for `callPmToolWithFallback` — the REST-only dispatcher
 * that routes a logical PM tool call to the GitLab REST adapter when
 * PMSource.kind is "rest-gitlab".
 *
 * The MCP path is handled directly inside each activity (each one knows
 * its own MCP tool name), so this dispatcher only has a REST branch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	listGitLabIssuesForPM,
	getGitLabIssueForPM,
	createGitLabIssueFromStory,
	updateGitLabIssueFromStory,
} = vi.hoisted(() => ({
	listGitLabIssuesForPM: vi.fn(),
	getGitLabIssueForPM: vi.fn(),
	createGitLabIssueFromStory: vi.fn(),
	updateGitLabIssueFromStory: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab/pm-adapter", () => ({
	listGitLabIssuesForPM,
	getGitLabIssueForPM,
	createGitLabIssueFromStory,
	updateGitLabIssueFromStory,
}));

import type { PMSource } from "../pm-source";
import {
	callPmToolWithFallback,
	GITLAB_REST_CAPABILITIES,
} from "../pm-tool-fallback";

const REST_SOURCE: Extract<PMSource, { kind: "rest-gitlab" }> = {
	kind: "rest-gitlab",
	token: "TOK",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: "100",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("callPmToolWithFallback — REST GitLab path", () => {
	it("routes listWorkItems to listGitLabIssuesForPM with gitlab REST source", async () => {
		listGitLabIssuesForPM.mockResolvedValue({ items: [] });

		await callPmToolWithFallback({
			source: REST_SOURCE,
			call: { tool: "listWorkItems", filters: { page: 2 } },
			userId: "u",
			organizationId: null,
		});

		expect(listGitLabIssuesForPM).toHaveBeenCalledTimes(1);
		const arg = listGitLabIssuesForPM.mock.calls[0]![0];
		expect(arg.gitlabProjectId).toBe("100");
		expect(arg.userId).toBe("u");
		expect(arg.organizationId).toBeNull();
		expect(arg.source.kind).toBe("rest-adapter");
		expect(arg.source.token).toBe("TOK");
	});

	it("routes fetchItem to getGitLabIssueForPM", async () => {
		getGitLabIssueForPM.mockResolvedValue({ id: "1", title: "T" });

		await callPmToolWithFallback({
			source: REST_SOURCE,
			call: { tool: "fetchItem", externalId: "42" },
			userId: "u",
			organizationId: null,
		});

		expect(getGitLabIssueForPM).toHaveBeenCalledTimes(1);
		expect(getGitLabIssueForPM.mock.calls[0]![0]).toMatchObject({
			gitlabProjectId: "100",
			externalId: "42",
			userId: "u",
			organizationId: null,
		});
	});

	it("routes createItem to createGitLabIssueFromStory", async () => {
		createGitLabIssueFromStory.mockResolvedValue({
			externalId: "9",
			externalUrl: "https://gitlab.com/g/p/-/issues/9",
			title: "New",
		});

		const result = await callPmToolWithFallback({
			source: REST_SOURCE,
			call: { tool: "createItem", payload: { title: "New" } },
			userId: "u",
			organizationId: null,
		});

		expect(createGitLabIssueFromStory).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ externalId: "9", title: "New" });
	});

	it("routes updateItem to updateGitLabIssueFromStory", async () => {
		updateGitLabIssueFromStory.mockResolvedValue({
			externalId: "9",
			externalUrl: "https://gitlab.com/g/p/-/issues/9",
			title: "Updated",
		});

		await callPmToolWithFallback({
			source: REST_SOURCE,
			call: {
				tool: "updateItem",
				externalId: "9",
				payload: { title: "Updated" },
			},
			userId: "u",
			organizationId: null,
		});

		expect(updateGitLabIssueFromStory).toHaveBeenCalledTimes(1);
		expect(updateGitLabIssueFromStory.mock.calls[0]![0]).toMatchObject({
			gitlabProjectId: "100",
			externalId: "9",
		});
	});

	it("returns GITLAB_REST_CAPABILITIES for discoverCapabilities", async () => {
		const result = await callPmToolWithFallback({
			source: REST_SOURCE,
			call: { tool: "discoverCapabilities" },
			userId: "u",
			organizationId: null,
		});

		expect(result).toMatchObject({
			canList: true,
			canFetch: true,
			canCreate: true,
			canUpdate: true,
		});
		expect(GITLAB_REST_CAPABILITIES).toMatchObject({
			canList: true,
			canFetch: true,
			canCreate: true,
			canUpdate: true,
		});
	});
});

describe("callPmToolWithFallback — unknown tool", () => {
	it("throws when given an unknown tool key on REST source", async () => {
		await expect(
			callPmToolWithFallback({
				source: REST_SOURCE,
				// @ts-expect-error invalid tool
				call: { tool: "nonsense" },
				userId: "u",
				organizationId: null,
			}),
		).rejects.toThrow(/unknown.*tool|nonsense/i);
	});
});
