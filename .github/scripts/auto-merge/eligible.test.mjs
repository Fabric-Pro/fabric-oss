import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	AUTO_MERGE_REPOSITORY,
	decideAutoMerge,
	OPT_OUT_LABEL,
	parseAuthors,
} from "./eligible.mjs";

const HEAD_SHA = "a".repeat(40);

function pullRequest(overrides = {}) {
	return {
		number: 7,
		state: "open",
		draft: false,
		base: { ref: "staging" },
		head: { sha: HEAD_SHA, repo: { full_name: AUTO_MERGE_REPOSITORY } },
		user: { login: "example-user", type: "User" },
		labels: [],
		auto_merge: null,
		...overrides,
	};
}

function decide(overrides = {}, pullRequestOverrides = {}) {
	return decideAutoMerge({
		enabled: "true",
		authors: "example-user",
		repository: AUTO_MERGE_REPOSITORY,
		eventAction: "opened",
		pullRequest: pullRequest(pullRequestOverrides),
		...overrides,
	});
}

const ARMED = { auto_merge: { merge_method: "squash" } };

test("parses comma and whitespace separated logins case-insensitively", () => {
	assert.deepEqual(
		[...parseAuthors(" Example-User,other-user\n\tTHIRD-user ,, ")],
		["example-user", "other-user", "third-user"],
	);
	assert.equal(parseAuthors(undefined).size, 0);
	assert.equal(parseAuthors("").size, 0);
});

test("arms a listed author's open pull request into staging", () => {
	assert.deepEqual(decide(), { action: "enable", reason: "eligible" });
});

test("the toggle must be exactly true, ignoring case", () => {
	for (const enabled of [undefined, "", "false", "1", "yes", " true"]) {
		assert.deepEqual(
			decide({ enabled }),
			{ action: "none", reason: "toggle-off" },
			String(enabled),
		);
	}
	assert.equal(decide({ enabled: "TRUE" }).action, "enable");
});

test("the toggle off never disarms, even with the opt-out label", () => {
	assert.deepEqual(
		decide(
			{ enabled: "false" },
			{ ...ARMED, labels: [{ name: OPT_OUT_LABEL }] },
		),
		{ action: "none", reason: "toggle-off" },
	);
});

test("matches authors case-insensitively and skips unlisted ones", () => {
	assert.equal(decide({ authors: "EXAMPLE-USER" }).action, "enable");
	assert.equal(
		decide({}, { user: { login: "Example-User", type: "User" } }).action,
		"enable",
	);
	assert.deepEqual(decide({ authors: "other-user" }), {
		action: "none",
		reason: "author-not-listed",
	});
	assert.deepEqual(decide({ authors: "" }), {
		action: "none",
		reason: "author-not-listed",
	});
	// A listed login must match whole, not as a prefix or substring.
	assert.equal(decide({ authors: "example" }).action, "none");
	assert.equal(decide({ authors: "example-user-2" }).action, "none");
});

test("an unlisted author never loses auto-merge someone armed by hand", () => {
	assert.deepEqual(decide({ authors: "other-user" }, ARMED), {
		action: "none",
		reason: "author-not-listed",
	});
});

test("skips draft pull requests", () => {
	assert.deepEqual(decide({}, { draft: true }), {
		action: "none",
		reason: "draft",
	});
	assert.equal(
		decide({ eventAction: "ready_for_review" }, { draft: false }).action,
		"enable",
	);
});

test("the opt-out label disarms auto-merge and blocks arming", () => {
	const labels = [{ name: "bug" }, { name: OPT_OUT_LABEL }];
	assert.deepEqual(decide({ eventAction: "labeled" }, { ...ARMED, labels }), {
		action: "disable",
		reason: "opted-out",
	});
	assert.deepEqual(decide({ eventAction: "labeled" }, { labels }), {
		action: "none",
		reason: "opted-out",
	});
	const removed = decide({ eventAction: "unlabeled" }, { labels: [] });
	assert.equal(removed.action, "enable");
});

test("skips bot authors unless listed by full login", () => {
	const bot = { user: { login: "example-app[bot]", type: "Bot" } };
	assert.deepEqual(decide({}, bot), {
		action: "none",
		reason: "bot-author",
	});
	assert.deepEqual(
		decide({}, { user: { login: "example-app[bot]", type: "User" } }),
		{ action: "none", reason: "bot-author" },
	);
	const listed = decide({ authors: "example-user, Example-App[bot]" }, bot);
	assert.equal(listed.action, "enable");
	const prefix = decide({ authors: "example-app" }, bot);
	assert.equal(prefix.action, "none");
});

test("only staging pull requests from this repository qualify", () => {
	assert.deepEqual(decide({}, { base: { ref: "master" } }), {
		action: "none",
		reason: "wrong-base",
	});
	const fork = { sha: HEAD_SHA, repo: { full_name: "example-org/fork" } };
	assert.deepEqual(decide({}, { head: fork }), {
		action: "none",
		reason: "fork-head",
	});
	assert.deepEqual(decide({}, { head: { sha: HEAD_SHA, repo: null } }), {
		action: "none",
		reason: "fork-head",
	});
	assert.deepEqual(decide({ repository: "Fabric-Pro/fabric-oss" }), {
		action: "none",
		reason: "inactive-repository",
	});
	assert.deepEqual(decide({}, { state: "closed" }), {
		action: "none",
		reason: "not-open",
	});
});

test("re-arms on a new push and otherwise leaves an armed pull request", () => {
	assert.deepEqual(decide({ eventAction: "synchronize" }, ARMED), {
		action: "rearm",
		reason: "head-moved",
	});
	for (const eventAction of ["opened", "reopened", "unlabeled", "edited"]) {
		assert.deepEqual(
			decide({ eventAction }, ARMED),
			{ action: "none", reason: "already-armed" },
			eventAction,
		);
	}
	assert.equal(decide({ eventAction: "synchronize" }).action, "enable");
});

test("the command line writes the decision and head to outputs", () => {
	const directory = mkdtempSync(join(tmpdir(), "auto-merge-"));
	const output = join(directory, "output");
	const summary = join(directory, "summary");
	const input = join(directory, "pull-request.json");
	const script = fileURLToPath(new URL("./eligible.mjs", import.meta.url));
	const run = (pr) => {
		writeFileSync(input, JSON.stringify(pr));
		writeFileSync(output, "");
		writeFileSync(summary, "");
		return spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				PULL_REQUEST_JSON: input,
				GITHUB_OUTPUT: output,
				GITHUB_STEP_SUMMARY: summary,
				GITHUB_REPOSITORY: AUTO_MERGE_REPOSITORY,
				EVENT_ACTION: "opened",
				AUTO_MERGE_ENABLED: "true",
				AUTO_MERGE_AUTHORS: "example-user",
			},
		});
	};

	const armed = run(pullRequest());
	assert.equal(armed.status, 0, armed.stderr);
	assert.equal(
		readFileSync(output, "utf8"),
		`action=enable\nreason=eligible\nhead_sha=${HEAD_SHA}\n`,
	);
	assert.match(readFileSync(summary, "utf8"), /#7: `enable` \(eligible\)/);

	const invalid = run(
		pullRequest({ head: { sha: "HEAD", repo: { full_name: "x" } } }),
	);
	assert.notEqual(invalid.status, 0);
	assert.equal(readFileSync(output, "utf8"), "");
});
