import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getProjectRepositoryBranch: vi.fn() }));

vi.mock("@repo/database", () => ({
	getProjectRepositoryBranch: m.getProjectRepositoryBranch,
}));

import { resolveRunTargetBranch } from "../target-branch";

beforeEach(() => {
	vi.clearAllMocks();
	m.getProjectRepositoryBranch.mockResolvedValue(null);
});

describe("resolveRunTargetBranch", () => {
	it("keeps the run's own target branch, reading nothing", async () => {
		await expect(
			resolveRunTargetBranch({
				projectId: "proj-1",
				targetBranch: "release/2.0",
				projectDefaultBranch: "develop",
			}),
		).resolves.toBe("release/2.0");
		expect(m.getProjectRepositoryBranch).not.toHaveBeenCalled();
	});

	it("uses the named repository's connected branch over the project's", async () => {
		m.getProjectRepositoryBranch.mockResolvedValue("master");

		await expect(
			resolveRunTargetBranch({
				projectId: "proj-1",
				repositoryOwner: "example-org",
				repositoryName: "rules",
				projectDefaultBranch: "main",
			}),
		).resolves.toBe("master");
		expect(m.getProjectRepositoryBranch).toHaveBeenCalledWith("proj-1", {
			owner: "example-org",
			name: "rules",
		});
	});

	it("falls back to the project's stored branch, then its first repository's", async () => {
		await expect(
			resolveRunTargetBranch({
				projectId: "proj-1",
				projectDefaultBranch: "develop",
			}),
		).resolves.toBe("develop");

		m.getProjectRepositoryBranch.mockResolvedValue("trunk");
		await expect(
			resolveRunTargetBranch({ projectId: "proj-1" }),
		).resolves.toBe("trunk");
		expect(m.getProjectRepositoryBranch).toHaveBeenCalledWith("proj-1");
	});

	it("answers main only when nothing is known", async () => {
		await expect(
			resolveRunTargetBranch({ projectId: "proj-1" }),
		).resolves.toBe("main");
	});
});
