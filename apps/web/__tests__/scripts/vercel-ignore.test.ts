/**
 * The Vercel Ignored Build Step decides, per deployment, whether to spend a
 * full turbopack build. Its ref rules are the cheap half of that decision and
 * the half that fails silently: a ref that stops matching does not error, it
 * just starts building, and the only evidence is a deployment nobody looks at.
 *
 * That is exactly how `changesets-ghcommit-temp/changeset-release/master` went
 * unnoticed — the Changesets CLI v3 / action v2 migration moved the Version PR
 * commit onto the GitHub API, which stages it on that prefix before updating
 * `changeset-release/master`, and Vercel built every one of those orphan
 * pushes. So pin the ref ladder rather than trusting the patterns by reading.
 *
 * Only the rules that terminate BEFORE the script shells out are covered here:
 * everything past the ref ladder runs `git diff` and `npx turbo-ignore`, which
 * a unit test has no business doing. Leaving VERCEL_GIT_PREVIOUS_SHA unset is
 * what keeps a fall-through case cheap — it exits at the first-deployment rule.
 *
 * Exit semantics are Vercel's and are inverted from the usual shell reading:
 * 0 = SKIP the build, 1 = BUILD.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/vercel-ignore.sh");

const SKIP = 0;
const BUILD = 1;

/**
 * Run the script with a given ref. The environment is inherited, but the script
 * reads only the two VERCEL_* variables set here, so a real Vercel-like
 * environment cannot change the outcome. The empty VERCEL_GIT_PREVIOUS_SHA is
 * deliberate: any ref that falls through the ref ladder then exits at the
 * first-deployment rule, so no case here can reach the git or network paths.
 */
function runWithRef(ref: string): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("sh", [SCRIPT], {
			env: {
				...process.env,
				VERCEL_GIT_COMMIT_REF: ref,
				VERCEL_GIT_PREVIOUS_SHA: "",
			},
			stdio: "ignore",
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise(code ?? -1));
	});
}

describe("vercel-ignore.sh ref ladder", () => {
	it("skips the legacy `production` ref", async () => {
		await expect(runWithRef("production")).resolves.toBe(SKIP);
	});

	it("always builds master, so the reconciler has a promotable deployment", async () => {
		await expect(runWithRef("master")).resolves.toBe(BUILD);
	});

	it("skips the Version PR branch", async () => {
		await expect(runWithRef("changeset-release/master")).resolves.toBe(
			SKIP,
		);
	});

	// The regression this file exists for: the ref @changesets/ghcommit stages
	// the Version PR commit on before it updates changeset-release/*. Same sha,
	// no githubPrId, ref deleted seconds later — a build nothing consumes.
	it("skips the changesets ghcommit staging ref", async () => {
		await expect(
			runWithRef("changesets-ghcommit-temp/changeset-release/master"),
		).resolves.toBe(SKIP);
	});

	it("skips a ghcommit staging ref for any target branch", async () => {
		await expect(
			runWithRef("changesets-ghcommit-temp/anything"),
		).resolves.toBe(SKIP);
	});

	it.each([
		"feature/some-work",
		"relay/staging-pr-210-d4a23eeb3f24-82be1b3e96ab",
		"changeset-release-not-really",
	])("does not skip %s on its first deployment", async (ref) => {
		await expect(runWithRef(ref)).resolves.toBe(BUILD);
	});
});
