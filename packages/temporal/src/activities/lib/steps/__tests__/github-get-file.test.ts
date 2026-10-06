/**
 * The GitHub get-file step reads the repository's default branch when the
 * node has no ref, rather than assuming `main`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: vi.fn(async () => ({ GITHUB_TOKEN: "tok" })),
}));

import { executeGithubGetFileStep } from "../github-get-file";

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue({
		ok: true,
		json: async () => ({
			content: Buffer.from("hello").toString("base64"),
			sha: "abc",
			path: "README.md",
			size: 5,
			encoding: "base64",
		}),
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function run(config: Record<string, unknown>) {
	return executeGithubGetFileStep({
		nodeConfig: {
			owner: "example-org",
			repo: "app",
			filePath: "README.md",
			...config,
		},
		inputs: {},
		userId: "u1",
		organizationId: "org-1",
	});
}

describe("github-get-file ref", () => {
	it("omits ref when none is configured, so GitHub reads the default branch", async () => {
		const result = await run({});

		expect(result.success).toBe(true);
		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.searchParams.has("ref")).toBe(false);
	});

	it("omits ref when the configured ref is blank", async () => {
		await run({ ref: "  " });

		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.searchParams.has("ref")).toBe(false);
	});

	it("passes a configured ref through, encoded", async () => {
		// `+` and `&` would corrupt an unencoded query string.
		await run({ ref: "fix/a+b&c" });

		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.searchParams.get("ref")).toBe("fix/a+b&c");
	});
});
