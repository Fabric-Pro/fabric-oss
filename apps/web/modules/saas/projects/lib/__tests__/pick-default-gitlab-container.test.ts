import { describe, expect, it } from "vitest";
import {
	buildGitLabRestContainerOptions,
	pickDefaultGitLabContainer,
} from "../pick-default-gitlab-container";

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

describe("buildGitLabRestContainerOptions (spec D1.1b, Fizzy #2304)", () => {
	const listed = [
		{ fullName: "myorg/repo-a", numericId: 11111 },
		{ fullName: "myorg/repo-b", numericId: 12345 },
	];

	it("keeps a saved numeric container on the repo with that numericId", () => {
		expect(
			buildGitLabRestContainerOptions({
				repos: listed,
				savedContainerId: "12345",
				savedContainerName: "myorg/repo-b",
				keepSavedContainer: true,
			}),
		).toEqual({
			options: [
				{ id: "myorg/repo-a", name: "myorg/repo-a" },
				{ id: "12345", name: "myorg/repo-b" },
			],
			savedOptionId: "12345",
		});
	});

	it("offers a saved numeric container missing from the list as the current project", () => {
		expect(
			buildGitLabRestContainerOptions({
				repos: listed,
				savedContainerId: "99999",
				savedContainerName: "legacy-group/legacy-project",
				keepSavedContainer: true,
			}),
		).toEqual({
			options: [
				{
					id: "99999",
					name: "legacy-group/legacy-project",
					label: "Current project (legacy-group/legacy-project)",
				},
				{ id: "myorg/repo-a", name: "myorg/repo-a" },
				{ id: "myorg/repo-b", name: "myorg/repo-b" },
			],
			savedOptionId: "99999",
		});
	});

	it("names a missing numeric container by its id when no name was saved", () => {
		const { options } = buildGitLabRestContainerOptions({
			repos: listed,
			savedContainerId: "99999",
			savedContainerName: null,
			keepSavedContainer: true,
		});
		expect(options[0]).toEqual({
			id: "99999",
			name: "99999",
			label: "Current project (GitLab project 99999)",
		});
	});

	it("keeps a saved path container on its repo without an extra option", () => {
		expect(
			buildGitLabRestContainerOptions({
				repos: listed,
				savedContainerId: "myorg/repo-b",
				savedContainerName: "myorg/repo-b",
				keepSavedContainer: true,
			}),
		).toEqual({
			options: [
				{ id: "myorg/repo-a", name: "myorg/repo-a" },
				{ id: "myorg/repo-b", name: "myorg/repo-b" },
			],
			savedOptionId: "myorg/repo-b",
		});
	});

	it("ignores the saved container on a re-pick, where it may belong to the previous tool", () => {
		// Positive control: the same saved id IS kept on the initial load.
		expect(
			buildGitLabRestContainerOptions({
				repos: listed,
				savedContainerId: "12345",
				savedContainerName: null,
				keepSavedContainer: true,
			}).savedOptionId,
		).toBe("12345");

		expect(
			buildGitLabRestContainerOptions({
				repos: listed,
				savedContainerId: "12345",
				savedContainerName: null,
				keepSavedContainer: false,
			}),
		).toEqual({
			options: [
				{ id: "myorg/repo-a", name: "myorg/repo-a" },
				{ id: "myorg/repo-b", name: "myorg/repo-b" },
			],
			savedOptionId: null,
		});
	});
});
