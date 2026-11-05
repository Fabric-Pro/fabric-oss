import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
	new URL("../workflows/request-external-review.yml", import.meta.url),
	"utf8",
);
const runBlock = workflow.match(/ {8}run: \|\n((?: {10}.*\n|\n)+)/)?.[1];
assert.ok(runBlock, "the review request shell must remain covered");
const script = runBlock
	.replace(/^ {10}/gm, "")
	.replace(/^REVIEWER=\S+$/m, "REVIEWER=example-reviewer")
	.replace(/\$\{\{ github\.repository \}\}/g, "example-org/example-repo");
const endpoint = "repos/example-org/example-repo/pulls/7";
const post = [
	"api",
	"--method",
	"POST",
	`${endpoint}/requested_reviewers`,
	"-f",
	"reviewers[]=example-reviewer",
];
const validationError = {
	status: 1,
	stderr: "gh: Validation Failed (HTTP 422)",
};

function runReview(t, { author = "example-contributor", responses = [] } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "external-review-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const log = join(directory, "calls.json");
	writeFileSync(log, "[]");
	writeFileSync(
		join(directory, "gh"),
		`#!/usr/bin/env node
const fs = require("node:fs");
const calls = JSON.parse(fs.readFileSync(process.env.GH_TEST_LOG, "utf8"));
const response = JSON.parse(process.env.GH_TEST_RESPONSES)[calls.length];
calls.push(process.argv.slice(2));
fs.writeFileSync(process.env.GH_TEST_LOG, JSON.stringify(calls));
if (!response) {
	process.stderr.write("Unexpected GitHub API call");
	process.exit(99);
}
process.stdout.write(response.stdout || "");
process.stderr.write(response.stderr || "");
process.exit(response.status || 0);
`,
		{ mode: 0o755 },
	);
	const result = spawnSync(
		"/bin/bash",
		["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
		{
			encoding: "utf8",
			timeout: 5_000,
			env: {
				PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
				AUTHOR: author,
				NUMBER: "7",
				GH_TOKEN: "example-token",
				GH_TEST_LOG: log,
				GH_TEST_RESPONSES: JSON.stringify(responses),
			},
		},
	);
	assert.ifError(result.error);
	return {
		...result,
		calls: JSON.parse(readFileSync(log, "utf8")),
	};
}

for (const author of ["example-reviewer", "EXAMPLE-REVIEWER"]) {
	test(`skips self-review without any API call for ${author}`, (t) => {
		const result = runReview(t, { author });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(result.calls, []);
		assert.match(result.stdout, /skip/i);
	});
}

test("requests the designated individual for another contributor", (t) => {
	const result = runReview(t, { responses: [{ stdout: "{}" }] });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.calls, [post]);
	assert.match(result.stdout, /Review requested/);
});

test("treats a 422 as a no-op when that individual is already requested", (t) => {
	const result = runReview(t, {
		responses: [validationError, { stdout: "true" }, { stdout: "0" }],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.calls[0], post);
	assert.equal(result.calls[1][1], `${endpoint}/requested_reviewers`);
	assert.equal(result.calls[2][1], `${endpoint}/reviews`);
	assert.equal(result.calls.length, 3);
	assert.match(result.stdout, /already present/);
});

test("treats a 422 as a no-op when that individual already reviewed", (t) => {
	const result = runReview(t, {
		responses: [validationError, { stdout: "false" }, { stdout: "1" }],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.calls.length, 3);
	assert.match(result.stdout, /already present/);
});

test("does not hide a 422 without evidence of an existing request or review", (t) => {
	const result = runReview(t, {
		responses: [validationError, { stdout: "false" }, { stdout: "0" }],
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /HTTP 422/);
});

for (const stderr of ["gh: Forbidden (HTTP 403)", "gh: connection failed"]) {
	test(`reports a genuine API failure: ${stderr}`, (t) => {
		const result = runReview(t, { responses: [{ status: 1, stderr }] });
		assert.equal(result.status, 1);
		assert.deepEqual(result.calls, [post]);
		assert.ok(result.stderr.includes(stderr));
	});
}

for (const failedLookup of ["requested_reviewers", "reviews"]) {
	test(`fails closed when the ${failedLookup} evidence lookup fails`, (t) => {
		const responses = [validationError];
		if (failedLookup === "reviews") {
			responses.push({ stdout: "false" });
		}
		responses.push({ status: 1, stderr: "gh: evidence unavailable" });
		const result = runReview(t, { responses });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /evidence unavailable/);
	});
}

test("treats author input as data, not shell code", (t) => {
	const result = runReview(t, {
		author: "$(printf injected >&2)",
		responses: [{ stdout: "{}" }],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(result.calls, [post]);
});

test("keeps the privileged workflow free of checkout and PR interpolation", () => {
	assert.match(
		workflow,
		/pull_request_target:\n\s+types: \[opened, reopened\]/,
	);
	assert.match(workflow, /github\.repository == '[^']+' &&/);
	assert.match(
		workflow,
		/github\.event\.pull_request\.user\.login != '[^']+'/,
	);
	assert.match(
		workflow,
		/AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/,
	);
	assert.doesNotMatch(workflow, /uses:/);
	assert.doesNotMatch(runBlock, /\$\{\{ github\.event/);
	assert.match(
		workflow,
		/permissions:\n {2}contents: read\n {2}pull-requests: write/,
	);
});
