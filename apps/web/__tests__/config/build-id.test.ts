import { describe, expect, it } from "vitest";
import { createBuildId, resolveCommitSha } from "../../lib/build-id";

const sha = "a".repeat(40);

describe("Next build ID", () => {
	it("uses the Vercel commit before local git", () => {
		expect(
			resolveCommitSha({ VERCEL_GIT_COMMIT_SHA: ` ${sha} ` }, () =>
				"b".repeat(40),
			),
		).toBe(sha);
	});

	it("falls back to local git", () => {
		expect(resolveCommitSha({}, () => sha)).toBe(sha);
	});

	it("returns null when no commit resolves, even with an explicit app version", () => {
		const env = { NEXT_PUBLIC_APP_VERSION: "1.2.3" };
		const commit = resolveCommitSha(env, () => {
			throw new Error("no git");
		});
		expect(createBuildId(commit, env)).toBeNull();
	});

	it("uses sorted public name=value pairs and ignores server-only variables", () => {
		const first = createBuildId(sha, {
			NEXT_PUBLIC_B: "2",
			NEXT_PUBLIC_A: "1",
			SECRET: "x",
		});
		expect(first).toMatch(new RegExp(`^${sha}-[a-f0-9]{12}$`));
		expect(first).toBe(
			createBuildId(sha, {
				NEXT_PUBLIC_A: "1",
				SECRET: "y",
				NEXT_PUBLIC_B: "2",
			}),
		);
		expect(first).not.toBe(
			createBuildId(sha, { NEXT_PUBLIC_A: "1", NEXT_PUBLIC_B: "3" }),
		);
	});
});
