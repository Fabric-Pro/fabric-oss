import type { ProjectRepositoryRole } from "@repo/database";
import { describe, expect, it } from "vitest";
import { formatRepositoryRoleMap } from "../../src/lib/repository-role-formatter";

describe("formatRepositoryRoleMap", () => {
	it("returns empty string when repos list is empty", () => {
		expect(formatRepositoryRoleMap([])).toBe("");
	});

	it("renders 1 untagged repo with Repositories: prefix", () => {
		const repos: ProjectRepositoryRole[] = [
			{
				url: "https://github.com/example-org/repo-main",
				provider: "GITHUB",
				roleTag: null,
			},
		];
		expect(formatRepositoryRoleMap(repos)).toBe(
			"Repositories: https://github.com/example-org/repo-main",
		);
	});

	it("renders multiple untagged repos with comma separation", () => {
		const repos: ProjectRepositoryRole[] = [
			{
				url: "https://github.com/example-org/repo1",
				provider: "GITHUB",
				roleTag: null,
			},
			{
				url: "https://github.com/example-org/repo2",
				provider: "GITHUB",
				roleTag: null,
			},
		];
		expect(formatRepositoryRoleMap(repos)).toBe(
			"Repositories: https://github.com/example-org/repo1, https://github.com/example-org/repo2",
		);
	});

	it("renders 2 tagged repos with [Role: <Tag>] suffixes", () => {
		const repos: ProjectRepositoryRole[] = [
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
		];
		expect(formatRepositoryRoleMap(repos)).toBe(
			"Repositories:\n- https://github.com/example-org/legacy-app [Role: Legacy]\n- https://github.com/example-org/new-app [Role: New]",
		);
	});

	it("renders mixed tagged and untagged repos correctly", () => {
		const repos: ProjectRepositoryRole[] = [
			{
				url: "https://github.com/example-org/legacy-auth",
				provider: "GITHUB",
				roleTag: "Legacy Auth",
			},
			{
				url: "https://github.com/example-org/docs",
				provider: "GITHUB",
				roleTag: null,
			},
		];
		expect(formatRepositoryRoleMap(repos)).toBe(
			"Repositories:\n- https://github.com/example-org/legacy-auth [Role: Legacy Auth]\n- https://github.com/example-org/docs",
		);
	});
});
