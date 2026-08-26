import { describe, expect, it } from "vitest";
import { buildPrAuthorGithubIdByPr } from "../src/workflows/publishing-suggestion-pr-authors";

describe("buildPrAuthorGithubIdByPr", () => {
	it("credits a single GitHub PR that emits multiple items sharing one author id", () => {
		// One PR, two kinds (pr_opened + pr_merged), SAME authorGithubId → not a
		// collision; the coordinate is credited.
		const map = buildPrAuthorGithubIdByPr([
			{ repoFullName: "o/r", prNumber: 1, authorGithubId: "id" },
			{ repoFullName: "o/r", prNumber: 1, authorGithubId: "id" },
		]);
		expect(map).toEqual({ "o/r#1": "id" });
	});

	it("fails closed when a GitHub item and an id-less (non-GitHub) item share a coordinate", () => {
		// GitLab/ADO PR carries no authorGithubId; it collides with the GitHub
		// PR on repoFullName#prNumber → credit nobody for the coordinate.
		const map = buildPrAuthorGithubIdByPr([
			{ repoFullName: "o/r", prNumber: 1, authorGithubId: "id" },
			{ repoFullName: "o/r", prNumber: 1 },
		]);
		expect(map).toEqual({});
	});

	it("fails closed when two distinct author ids share a coordinate", () => {
		const map = buildPrAuthorGithubIdByPr([
			{ repoFullName: "o/r", prNumber: 1, authorGithubId: "a" },
			{ repoFullName: "o/r", prNumber: 1, authorGithubId: "b" },
		]);
		expect(map).toEqual({});
	});

	it("credits two distinct single-id coordinates", () => {
		const map = buildPrAuthorGithubIdByPr([
			{ repoFullName: "o/r", prNumber: 1, authorGithubId: "a" },
			{ repoFullName: "o/r", prNumber: 2, authorGithubId: "b" },
		]);
		expect(map).toEqual({ "o/r#1": "a", "o/r#2": "b" });
	});

	it("omits a coordinate whose only item has no author id", () => {
		const map = buildPrAuthorGithubIdByPr([
			{ repoFullName: "o/r", prNumber: 1 },
		]);
		expect(map).toEqual({});
	});
});
