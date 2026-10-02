import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function verifyCandidateMetadata(repo, head) {
	assert.match(head, /^[0-9a-f]{40}$/u, "candidate SHA is invalid");
	const git = (...args) =>
		execFileSync(
			"git",
			["-c", "core.hooksPath=/dev/null", "-C", repo, ...args],
			{ encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
		).trim();
	assert.equal(git("rev-parse", "HEAD"), head, "candidate checkout moved");
	assert.equal(
		git("cat-file", "-t", `${head}:.changeset`),
		"tree",
		"changeset metadata is unavailable",
	);
	const paths = git("ls-tree", "-r", "-z", "--name-only", head)
		.split("\0")
		.filter(Boolean);
	assert(
		!paths.some(
			(path) =>
				path.startsWith(".changeset/") &&
				path.endsWith(".md") &&
				path.split("/").at(-1) !== "README.md",
		),
		"candidate still has release entries",
	);
	for (const path of paths.filter(
		(path) =>
			path === "package.json" ||
			/^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path),
	)) {
		const manifest = JSON.parse(git("show", `${head}:${path}`));
		assert.equal(
			typeof manifest.name,
			"string",
			"package identity is invalid",
		);
		if (manifest.version !== undefined) {
			assert.match(
				manifest.version,
				/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
				"package version is invalid",
			);
		}
	}
	return { head, tree: git("rev-parse", `${head}^{tree}`) };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	verifyCandidateMetadata(process.argv[2] ?? ".", process.argv[3] ?? "");
	console.log("Exact private promotion metadata is valid.");
}
