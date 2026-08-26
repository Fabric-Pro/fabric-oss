import { beforeEach, describe, expect, it, vi } from "vitest";

const { callMcpWithRestFallback } = vi.hoisted(() => ({
	callMcpWithRestFallback: vi.fn(),
}));

vi.mock("../../src/gitlab/source", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/gitlab/source")
	>("../../src/gitlab/source");
	return {
		...actual,
		callMcpWithRestFallback,
	};
});

// Stub out @repo/database and @repo/utils which pm-adapter imports at the
// module level (they are not needed for the write-side dispatch tests, which
// run with a pre-built GitLabSource fixture).
vi.mock("@repo/database", () => ({
	db: {},
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => s,
}));

import {
	createGitLabIssueFromStory,
	getGitLabIssueForPM,
	updateGitLabIssueFromStory,
} from "../../src/gitlab/pm-adapter";
import type { GitLabSource } from "../../src/gitlab/source";

const REST_SOURCE: GitLabSource = {
	kind: "rest-adapter",
	token: "tok",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createGitLabIssueFromStory", () => {
	it("dispatches via callMcpWithRestFallback with create_issue method and project_id", async () => {
		callMcpWithRestFallback.mockResolvedValue({
			iid: 42,
			title: "New",
			web_url: "https://gitlab.com/g/p/-/issues/42",
		});

		const result = await createGitLabIssueFromStory({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			payload: { title: "New", description: "Body", labels: ["bug"] },
			userId: "u1",
			organizationId: null,
		});

		expect(callMcpWithRestFallback).toHaveBeenCalledOnce();
		const call = callMcpWithRestFallback.mock.calls[0]![0];
		expect(call).toMatchObject({
			method: "create_issue",
			args: expect.objectContaining({
				project_id: "100",
				title: "New",
				description: "Body",
			}),
		});

		expect(result).toMatchObject({
			externalId: "42",
			externalUrl: "https://gitlab.com/g/p/-/issues/42",
			title: "New",
		});
	});

	it("omits null/undefined payload fields from args", async () => {
		callMcpWithRestFallback.mockResolvedValue({ iid: 1, title: "T" });

		await createGitLabIssueFromStory({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			payload: { title: "T" },
			userId: "u1",
			organizationId: null,
		});

		const args = callMcpWithRestFallback.mock.calls[0]![0].args;
		expect(args).not.toHaveProperty("description");
		expect(args).not.toHaveProperty("labels");
	});
});

describe("updateGitLabIssueFromStory", () => {
	it("dispatches via callMcpWithRestFallback with update_issue method and issue_iid", async () => {
		callMcpWithRestFallback.mockResolvedValue({
			iid: 7,
			title: "Updated",
			web_url: "https://gitlab.com/g/p/-/issues/7",
		});

		const result = await updateGitLabIssueFromStory({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			externalId: "7",
			payload: { title: "Updated", stateEvent: "close" },
			userId: "u1",
			organizationId: null,
		});

		expect(callMcpWithRestFallback).toHaveBeenCalledOnce();
		const call = callMcpWithRestFallback.mock.calls[0]![0];
		expect(call).toMatchObject({
			method: "update_issue",
			args: expect.objectContaining({
				project_id: "100",
				issue_iid: 7,
				title: "Updated",
				state_event: "close",
			}),
		});

		expect(result).toMatchObject({
			externalId: "7",
			externalUrl: "https://gitlab.com/g/p/-/issues/7",
			title: "Updated",
		});
	});

	it("passes addLabels/removeLabels through to MCP args as comma-separated strings", async () => {
		callMcpWithRestFallback.mockResolvedValue({
			iid: 7,
			title: "Done",
			web_url: "https://gitlab.com/g/p/-/issues/7",
		});

		await updateGitLabIssueFromStory({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			externalId: "7",
			payload: {
				title: "Done",
				addLabels: ["status:done"],
				removeLabels: ["status:in-progress"],
			},
			userId: "u1",
			organizationId: null,
		});

		expect(callMcpWithRestFallback).toHaveBeenCalledOnce();
		const call = callMcpWithRestFallback.mock.calls[0]![0];
		expect(call).toMatchObject({
			method: "update_issue",
			args: expect.objectContaining({
				add_labels: "status:done",
				remove_labels: "status:in-progress",
			}),
		});
		// Must NOT also emit a full-replace labels key when using delta semantics
		expect(
			(call as { args: Record<string, unknown> }).args.labels,
		).toBeUndefined();
	});

	it("omits add_labels/remove_labels when arrays are empty or undefined", async () => {
		callMcpWithRestFallback.mockResolvedValue({
			iid: 7,
			title: "Updated",
			web_url: "https://gitlab.com/g/p/-/issues/7",
		});

		await updateGitLabIssueFromStory({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			externalId: "7",
			payload: { title: "Updated", addLabels: [], removeLabels: [] },
			userId: "u1",
			organizationId: null,
		});

		const call = callMcpWithRestFallback.mock.calls[0]![0] as {
			args: Record<string, unknown>;
		};
		expect(call.args.add_labels).toBeUndefined();
		expect(call.args.remove_labels).toBeUndefined();
	});
});

describe("getGitLabIssueForPM — surfaces state and updatedAt", () => {
	it("maps state and updated_at from the raw issue (Phase B)", async () => {
		callMcpWithRestFallback.mockResolvedValue({
			iid: 7,
			title: "Closed issue",
			description: "done",
			web_url: "https://gitlab.com/g/p/-/issues/7",
			state: "closed",
			updated_at: "2026-05-30T10:00:00Z",
			labels: ["Done", "backend"],
		});

		const result = await getGitLabIssueForPM({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			externalId: "7",
			userId: "u1",
			organizationId: null,
		});

		expect(result).toMatchObject({
			title: "Closed issue",
			description: "done",
			externalUrl: "https://gitlab.com/g/p/-/issues/7",
			labels: ["Done", "backend"],
			state: "closed",
			updatedAt: "2026-05-30T10:00:00Z",
		});
	});

	it("leaves state/updatedAt undefined when the raw issue omits them", async () => {
		callMcpWithRestFallback.mockResolvedValue({
			iid: 8,
			title: "Open issue",
		});

		const result = await getGitLabIssueForPM({
			source: REST_SOURCE,
			gitlabProjectId: "100",
			externalId: "8",
			userId: "u1",
			organizationId: null,
		});

		expect(result.state).toBeUndefined();
		expect(result.updatedAt).toBeUndefined();
	});
});
