import { describe, expect, it } from "vitest";
import {
	githubPermissionsInWords,
	InstructionPullRequestError,
	refusalReason,
	repositoryLogFields,
} from "../../src/instruction-pull-requests";

describe("refusal reporting", () => {
	it("names GitHub permissions in words", () => {
		expect(githubPermissionsInWords("pull_requests=write")).toBe(
			"Pull requests (write)",
		);
		expect(
			githubPermissionsInWords(
				"pull_requests=write, contents=read; issues=write",
			),
		).toBe("Pull requests (write) and Contents (read) or Issues (write)");
	});

	it("states the provider, status and message", () => {
		const error = new InstructionPullRequestError({
			code: "PR_CREATION_REFUSED",
			retryable: false,
			cause: "conflict",
			providerStatus: 422,
			providerMessage: "Validation Failed — base: invalid",
		});
		expect(refusalReason("GITHUB", error)).toBe(
			"GitHub 422: Validation Failed — base: invalid",
		);
		expect(
			refusalReason(
				"GITLAB",
				new InstructionPullRequestError({
					code: "CREATE_OUTCOME_UNKNOWN",
					retryable: true,
					cause: "transient",
				}),
			),
		).toBeUndefined();
	});

	it("names a GitLab subgroup project by owner path and name", () => {
		expect(
			repositoryLogFields({
				provider: "GITLAB",
				projectPath: "example-org/sub/example-repo",
			}),
		).toEqual({
			provider: "GITLAB",
			owner: "example-org/sub",
			name: "example-repo",
		});
	});
});
