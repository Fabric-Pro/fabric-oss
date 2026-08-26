import { beforeEach, describe, expect, it, vi } from "vitest";

const { callMcpWithRestFallback } = vi.hoisted(() => ({
	callMcpWithRestFallback: vi.fn(),
}));

vi.mock("../../src/gitlab/source", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/gitlab/source")
	>("../../src/gitlab/source");
	return { ...actual, callMcpWithRestFallback };
});

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/utils", () => ({ decryptApiKey: (s: string) => s }));

import { getGitLabIssueNotesForPM } from "../../src/gitlab/pm-adapter";
import type { GitLabSource } from "../../src/gitlab/source";

const REST_SOURCE: GitLabSource = { kind: "rest-adapter", token: "tok" };

beforeEach(() => vi.clearAllMocks());

describe("getGitLabIssueNotesForPM", () => {
	it("maps notes to PmComment shape and drops system notes", async () => {
		callMcpWithRestFallback.mockResolvedValueOnce([
			{
				id: 1,
				body: "real comment",
				system: false,
				created_at: "2026-05-01T00:00:00Z",
				author: { name: "Pat Roe" },
			},
			{
				id: 2,
				body: "changed the status",
				system: true,
				created_at: "2026-05-02T00:00:00Z",
			},
		]);

		const result = await getGitLabIssueNotesForPM({
			source: REST_SOURCE,
			gitlabProjectId: "group/proj",
			externalId: "7",
			userId: "user-1",
			organizationId: null,
		});

		expect(result).toEqual([
			{
				author: "Pat Roe",
				createdAt: "2026-05-01T00:00:00.000Z",
				body: "real comment",
			},
		]);
	});

	it("rejects a non-numeric issue IID", async () => {
		await expect(
			getGitLabIssueNotesForPM({
				source: REST_SOURCE,
				gitlabProjectId: "group/proj",
				externalId: "abc",
				userId: "user-1",
				organizationId: null,
			}),
		).rejects.toThrow(/Invalid GitLab issue IID/);
	});
});
