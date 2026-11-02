/**
 * The Vercel Ignored Build Step decides, per deployment, whether to spend a
 * full Turbopack build. A ref rule that stops matching does not error; it
 * just starts or stops building, and the only evidence is a deployment nobody
 * looks at (or a reconciler with nothing to promote). So pin the ref ladder
 * rather than trusting the patterns by reading.
 *
 * Only `master`, `staging` and trusted `promotion/*` requests build. Every
 * other ref, branch previews included, skips.
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
 * Run the script with a given ref. The environment is inherited, but the
 * script's source/build-marker variables are reset here.
 */
function runWithRef(
	ref: string,
	{ previousSha = "", marker = "", sha = "" } = {},
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
			stdio: "ignore",
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise(code ?? -1));
	});
}

describe("vercel-ignore.sh deployed refs", () => {
	it.each(["master", "staging"])(
		"always builds %s, so the reconciler has a deployment of every revision",
		async (ref) => {
			await expect(runWithRef(ref)).resolves.toBe(BUILD);
			await expect(
				runWithRef(ref, { previousSha: "b".repeat(40) }),
			).resolves.toBe(BUILD);
		},
	);
});

describe("vercel-ignore.sh branch previews", () => {
	it.each([
		"feature/some-work",
		"fix/some-bug",
		"dependabot/npm_and_yarn/example-1.2.3",
		"relay/staging-pr-210-d4a23eeb3f24-82be1b3e96ab",
		"changeset-release/master",
		"changesets-ghcommit-temp/changeset-release/master",
		"production",
		"staging-example",
		"master-example",
		"preview/staging",
	])("skips %s", async (ref) => {
		await expect(runWithRef(ref)).resolves.toBe(SKIP);
		await expect(
			runWithRef(ref, { previousSha: "b".repeat(40) }),
		).resolves.toBe(SKIP);
	});
});

describe("private promotion build admission", () => {
	const sha = "a".repeat(40);
	it("skips automatic raw and versioned promotion previews", async () => {
		await expect(runWithRef("promotion/example-cycle")).resolves.toBe(SKIP);
		await expect(
			runWithRef("promotion/example-cycle", { sha }),
		).resolves.toBe(SKIP);
	});
	it("builds a trusted request bound to the exact full SHA", async () => {
		await expect(
			runWithRef("promotion/example-cycle", { marker: sha, sha }),
		).resolves.toBe(BUILD);
	});
	it.each(["a".repeat(39), "A".repeat(40), "g".repeat(40), "b".repeat(40)])(
		"skips malformed or mismatched marker %s",
		async (marker) => {
			await expect(
				runWithRef("promotion/example-cycle", { marker, sha }),
			).resolves.toBe(SKIP);
		},
	);
	// Marker and Git SHA agree here, so only the shape checks can refuse them.
	it.each(["a".repeat(39), "A".repeat(40)])(
		"skips a malformed marker even when it equals the Git SHA (%s)",
		async (value) => {
			await expect(
				runWithRef("promotion/example-cycle", {
					marker: value,
					sha: value,
				}),
			).resolves.toBe(SKIP);
		},
	);
	it("skips a marker without Vercel Git SHA evidence", async () => {
		await expect(
			runWithRef("promotion/example-cycle", { marker: sha }),
		).resolves.toBe(SKIP);
	});
	it("does not admit the marker on a non-promotion ref", async () => {
		await expect(
			runWithRef("feature/some-work", { marker: sha, sha }),
		).resolves.toBe(SKIP);
	});
});
