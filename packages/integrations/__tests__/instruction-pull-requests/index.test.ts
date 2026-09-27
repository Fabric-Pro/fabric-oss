import { describe, expect, it } from "vitest";
import {
	azureDevOps,
	github,
	gitlab,
	sourceHeadEvidence,
} from "../../src/instruction-pull-requests";

const SHA = "a".repeat(40);

describe("sourceHeadEvidence", () => {
	it("names the ref and the expected SHA for GitHub", () => {
		expect(sourceHeadEvidence(github, "42", SHA)).toEqual({
			ref: "refs/pull/42/head",
			expectSha: SHA,
		});
	});

	it("names the ref and the expected SHA for GitLab", () => {
		expect(sourceHeadEvidence(gitlab, "42", SHA)).toEqual({
			ref: "refs/merge-requests/42/head",
			expectSha: SHA,
		});
	});

	it("is unavailable for Azure DevOps, which has no fetchable source-head ref", () => {
		expect(sourceHeadEvidence(azureDevOps, "42", SHA)).toEqual({
			kind: "unavailable",
		});
	});

	it.each(["0", "-1", "1.5", "abc", ""])(
		"is unavailable for a non-numeric externalId (%j), never interpolated into a ref",
		(externalId) => {
			expect(sourceHeadEvidence(github, externalId, SHA)).toEqual({
				kind: "unavailable",
			});
			expect(sourceHeadEvidence(gitlab, externalId, SHA)).toEqual({
				kind: "unavailable",
			});
		},
	);
});
