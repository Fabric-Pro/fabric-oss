import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGitLabTool } from "../../src/gitlab/index";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown) {
	globalThis.fetch = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		headers: new Headers({ "Content-Type": "application/json" }),
		json: async () => body,
	}) as unknown as typeof fetch;
}

describe("executeGitLabTool list_issue_notes", () => {
	it("fetches issue notes via the project-access-token path", async () => {
		mockFetchOnce([
			{
				id: 1,
				body: "human note",
				system: false,
				created_at: "2026-05-01T00:00:00Z",
			},
			{
				id: 2,
				body: "changed status",
				system: true,
				created_at: "2026-05-02T00:00:00Z",
			},
		]);

		const result = (await executeGitLabTool(
			"list_issue_notes",
			{ project_id: "group/proj", issue_iid: 7 },
			"user-1",
			undefined,
			"pat-token",
		)) as Array<{ id: number }>;

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(2);
		const calledUrl = vi.mocked(globalThis.fetch).mock
			.calls[0][0] as string;
		expect(calledUrl).toContain("/issues/7/notes");
	});

	it("throws on an unknown tool name", async () => {
		await expect(
			executeGitLabTool("not_a_tool", {}, "user-1", undefined, "pat"),
		).rejects.toThrow(/Unknown GitLab tool/);
	});
});
