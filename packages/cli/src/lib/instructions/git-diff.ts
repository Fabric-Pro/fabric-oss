import { type GitDeadline, type GitResult, simple } from "./git-run.js";

/** Git decides content changes, including checkout line-ending conversion. */
export async function changedTrackedPaths(
	root: string,
	deadline: GitDeadline,
): Promise<GitResult<string[]>> {
	const result = await simple(
		root,
		[
			"diff",
			"--name-only",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--relative",
			"-z",
			"HEAD",
			"--",
			".",
		],
		deadline,
	);
	if (result.kind !== "ok") return result;
	if (result.value.code !== 0) {
		return {
			kind: "unavailable",
			reason: "Git could not compare this checkout to HEAD",
		};
	}
	return {
		kind: "ok",
		value: result.value.stdout.split("\0").filter(Boolean),
	};
}
