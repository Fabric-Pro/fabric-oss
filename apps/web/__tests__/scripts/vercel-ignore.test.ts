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
 * Ref-ladder cases leave VERCEL_GIT_PREVIOUS_SHA unset. Exact-deployment
 * regressions use a disposable Git repository with a CI-only diff and a
 * previous deployment SHA; these cases never reach network-backed turbo-ignore.
 *
 * Exit semantics are Vercel's and are inverted from the usual shell reading:
 * 0 = SKIP the build, 1 = BUILD.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/vercel-ignore.sh");

const SKIP = 0;
const BUILD = 1;

/**
 * Run the script with a given ref. The environment is inherited, but the script
 * has its source/build-marker variables reset here. An empty previous SHA is
 * the default: ref-ladder cases exit at the first-deployment rule. Inert-diff
 * cases supply a disposable repository and its previous revision.
 */
function runWithRef(
	ref: string,
	previousSha = "",
	cwd?: string,
	marker = "",
	sha = "",
): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("sh", [SCRIPT], {
			env: {
				...process.env,
				VERCEL_GIT_COMMIT_REF: ref,
				VERCEL_GIT_PREVIOUS_SHA: previousSha,
				VERCEL_GIT_COMMIT_SHA: sha,
				FABRIC_PRIVATE_PROMOTION_BUILD_SHA: marker,
			},
			cwd,
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

describe("private promotion build admission", () => {
	const sha = "a".repeat(40);
	it("skips automatic raw and versioned promotion previews", async () => {
		await expect(runWithRef("promotion/example-cycle")).resolves.toBe(SKIP);
		await expect(
			runWithRef("promotion/example-cycle", "", undefined, "", sha),
		).resolves.toBe(SKIP);
	});
	it("builds a trusted request bound to the exact full SHA", async () => {
		await expect(
			runWithRef("promotion/example-cycle", "", undefined, sha, sha),
		).resolves.toBe(BUILD);
	});
	it.each(["a".repeat(39), "A".repeat(40), "g".repeat(40), "b".repeat(40)])(
		"skips malformed or mismatched marker %s",
		async (marker) => {
			await expect(
				runWithRef(
					"promotion/example-cycle",
					"",
					undefined,
					marker,
					sha,
				),
			).resolves.toBe(SKIP);
		},
	);
	it("skips a marker without Vercel Git SHA evidence", async () => {
		await expect(
			runWithRef("promotion/example-cycle", "", undefined, sha),
		).resolves.toBe(SKIP);
	});
});

describe("exact deployment refs with an inert CI-only delta", () => {
	let repo: string;
	let previousSha: string;

	beforeAll(() => {
		repo = mkdtempSync(resolve(tmpdir(), "vercel-ignore-test-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, ...args], {
				encoding: "utf8",
			}).trim();
		git("init", "-q");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.test");
		writeFileSync(resolve(repo, "base.txt"), "base\n");
		git("add", ".");
		git("commit", "-q", "-m", "base");
		previousSha = git("rev-parse", "HEAD");
		mkdirSync(resolve(repo, ".github"));
		writeFileSync(resolve(repo, ".github", "ci.yml"), "name: example\n");
		git("add", ".");
		git("commit", "-q", "-m", "CI-only change");
	});

	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	it.each(["master", "staging"])(
		"builds %s despite a previous deployment and only CI changes",
		async (ref) => {
			await expect(runWithRef(ref, previousSha, repo)).resolves.toBe(
				BUILD,
			);
		},
	);

	it.each(["feature/example", "staging-example", "promotion-example"])(
		"preserves the inert-diff optimization for %s",
		async (ref) => {
			await expect(runWithRef(ref, previousSha, repo)).resolves.toBe(
				SKIP,
			);
		},
	);
});
