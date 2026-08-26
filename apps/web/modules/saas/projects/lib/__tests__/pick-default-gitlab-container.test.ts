import { describe, expect, it } from "vitest";
import { pickDefaultGitLabContainer } from "../pick-default-gitlab-container";

const repos = [
	{ fullName: "myorg/repo-a", name: "myorg/repo-a" },
	{ fullName: "myorg/repo-b", name: "myorg/repo-b" },
];

describe("pickDefaultGitLabContainer", () => {
	it("returns the saved container id when it matches a fetched repo", () => {
		expect(
			pickDefaultGitLabContainer(repos, "myorg/repo-b", "myorg/repo-a"),
		).toBe("myorg/repo-b");
	});

	it("falls back to the codebase repo when the saved id is numeric (no direct match)", () => {
		expect(pickDefaultGitLabContainer(repos, "12345", "myorg/repo-a")).toBe(
			"myorg/repo-a",
		);
	});

	it("returns null when neither saved id nor codebase repo match the fetched list", () => {
		expect(
			pickDefaultGitLabContainer(repos, "12345", "other-org/missing"),
		).toBeNull();
	});

	it("uses the codebase repo when no saved id is present", () => {
		expect(pickDefaultGitLabContainer(repos, null, "myorg/repo-a")).toBe(
			"myorg/repo-a",
		);
	});

	it("returns null when saved id is null and codebase repo is null", () => {
		expect(pickDefaultGitLabContainer(repos, null, null)).toBeNull();
	});

	it("respects the user's explicit choice over the codebase repo", () => {
		expect(
			pickDefaultGitLabContainer(repos, "myorg/repo-b", "myorg/repo-a"),
		).toBe("myorg/repo-b");
	});

	it("returns null when the container list is empty", () => {
		expect(
			pickDefaultGitLabContainer([], "myorg/repo-a", "myorg/repo-a"),
		).toBeNull();
	});
});
