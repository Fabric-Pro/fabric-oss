import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyCandidateMetadata } from "./promotion-contract.mjs";

test("contract reads the exact committed tree, requires consumed releases and valid package metadata", () => {
	const repo = mkdtempSync(join(tmpdir(), "example-candidate-contract-"));
	const git = (...args) =>
		execFileSync(
			"git",
			["-c", "core.hooksPath=/dev/null", "-C", repo, ...args],
			{ encoding: "utf8" },
		).trim();
	const write = (path, body) => writeFileSync(join(repo, path), body);
	const commit = () => {
		git("add", ".");
		git("commit", "-qm", "Synthetic metadata fixture");
		return git("rev-parse", "HEAD");
	};
	try {
		git("init", "-q");
		git("config", "user.name", "Example");
		git("config", "user.email", "dev@example.com");
		mkdirSync(join(repo, ".changeset"));
		write(".changeset/README.md", "Instructions");
		write(".changeset/config.json", "{}");
		write(
			"package.json",
			'{"name":"example-app","version":"1.0.0","scripts":{"build":"never executed"}}',
		);
		const head = commit();
		assert.equal(
			verifyCandidateMetadata(repo, head).tree,
			git("rev-parse", `${head}^{tree}`),
		);
		write(".changeset/untracked.md", "Not in the committed tree");
		verifyCandidateMetadata(repo, head);
		rmSync(join(repo, ".changeset/untracked.md"));
		assert.throws(
			() => verifyCandidateMetadata(repo, "a".repeat(40)),
			/checkout moved/,
		);
		for (let i = 0; i < 12; i++) {
			write(`.changeset/example-${i}.md`, "Pending release");
		}
		const raw = commit();
		assert.throws(
			() => verifyCandidateMetadata(repo, raw),
			/release entries/,
		);
		git("checkout", "-q", "--detach", head);
		write("package.json", '{"name":"example-app","version":"invalid"}');
		assert.throws(
			() => verifyCandidateMetadata(repo, commit()),
			/version is invalid/,
		);
		git("checkout", "-q", "--detach", head);
		write("package.json", "invalid JSON");
		assert.throws(() => verifyCandidateMetadata(repo, commit()));
		assert.throws(
			() => verifyCandidateMetadata(repo, "not-a-sha"),
			/SHA is invalid/,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
