import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `createSandboxActivity`'s `parseRepoUrl` used to decide "is this GitHub?" by
 * substring-testing the whole URL for `github.com`, which also matches a URL
 * whose real host is somewhere else (`https://example.com/github.com/o/r`).
 * It now defers that decision to `repoForgeFromUrl`, which parses the URL's
 * `hostname` the same way the API-side gate in `start-execution.ts` does.
 */

const createSession = vi.fn();
const cancelSession = vi.fn();

vi.mock("../src/activities/weave/get-background-provider", () => ({
	getBackgroundAgentsProvider: () => ({ createSession, cancelSession }),
}));

import { createSandboxActivity } from "../src/activities/weave/sandbox";

beforeEach(() => {
	createSession.mockReset();
	createSession.mockResolvedValue({ sessionId: "sess-1" });
});

describe("createSandboxActivity repo URL parsing", () => {
	it("accepts a real https GitHub URL", async () => {
		await createSandboxActivity({
			userId: "user-1",
			organizationId: null,
			repoUrl: "https://github.com/acme/widgets.git",
			branch: "main",
		});

		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({ repoOwner: "acme", repoName: "widgets" }),
		);
	});

	it("accepts an scp-style GitHub URL", async () => {
		await createSandboxActivity({
			userId: "user-1",
			organizationId: null,
			repoUrl: "git@github.com:acme/widgets.git",
			branch: "main",
		});

		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({ repoOwner: "acme", repoName: "widgets" }),
		);
	});

	it("rejects a lookalike host that only names github.com in the path", async () => {
		await expect(
			createSandboxActivity({
				userId: "user-1",
				organizationId: null,
				repoUrl: "https://example.com/github.com/acme/widgets",
				branch: "main",
			}),
		).rejects.toThrow(/Cannot parse repository URL/);

		expect(createSession).not.toHaveBeenCalled();
	});
});
