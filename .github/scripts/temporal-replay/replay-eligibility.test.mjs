import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	evaluateCredentialFreeOutcome,
	REPLAY_ELIGIBILITY_EXPRESSION,
	REQUIRED_CHECK_NAME,
} from "./replay-eligibility.mjs";

const trustedWorkflow = await readFile(
	new URL("../../workflows/temporal-replay-validation.yml", import.meta.url),
	"utf8",
);
const companion = await readFile(
	new URL("../../workflows/temporal-replay-pr-check.yml", import.meta.url),
	"utf8",
);

function stepScript(name) {
	const steps = companion.split(/^ {6}- /m);
	const step = steps.find((step) => step.startsWith(`name: ${name}\n`));
	const script = step?.split(/^ {8}run: \|\n/m)[1];
	assert.ok(script, `${name} must have an inline run script`);
	return script.replace(/^ {10}/gm, "");
}

test("the companion has one constant replay check and pins replay admission", () => {
	assert.deepEqual(
		[...companion.matchAll(/^ {4}name: (.*)$/gm)]
			.map(([, name]) => name)
			.filter((name) => name.includes(REQUIRED_CHECK_NAME)),
		[REQUIRED_CHECK_NAME],
	);
	assert.match(
		companion,
		/^ {2}replay_check:\n {4}name: replay-validation$/m,
	);
	const [, condition] =
		companion.match(/^ {6}replay_eligible: >-\n\s*\$\{\{([\s\S]*?)\}\}/m) ??
		[];
	assert.ok(condition, "replay_eligible must be an expression");
	assert.equal(
		condition.replaceAll(/\s+/g, " ").trim(),
		REPLAY_ELIGIBILITY_EXPRESSION.replaceAll(/\s+/g, " "),
	);
});

const basePullRequest = {
	eventName: "pull_request",
	repository: "Fabric-Pro/fabric",
	headRepository: "Fabric-Pro/fabric",
	pullRequestAuthor: "example-developer",
	headRef: "feature/example",
	workflowsChanged: true,
	changesResult: "success",
};
const publicPullRequest = {
	repository: "Fabric-Pro/fabric-oss",
	headRepository: "Fabric-Pro/fabric-oss",
};
const relay = { ...publicPullRequest, pullRequestAuthor: "fabric-relay[bot]" };

test("replay eligibility and the actual companion policy agree on PR cases", () => {
	const cases = [
		[
			{},
			false,
			"ops_repository_replay_not_applicable",
			/::notice::Temporal replay runs only in fabric-dev/,
		],
		[
			{
				repository: "Fabric-Pro/fabric-dev",
				headRepository: "Fabric-Pro/fabric-dev",
			},
			true,
			"private_same_repository_pr",
			/Replay is required/,
		],
		[
			{ ...relay, headRef: "relay/example" },
			false,
			"authenticated_public_relay_pr",
			/ran on the corresponding private staging PR/,
		],
		[
			{ ...relay, headRef: "feature/example" },
			false,
			"public_pr_outside_relay_namespace",
			/::error::Relay App PR is outside/,
		],
		[
			publicPullRequest,
			false,
			"public_credential_free_not_applicable",
			/not applicable/,
		],
		[
			{ ...publicPullRequest, headRepository: "example-org/fork" },
			false,
			"public_credential_free_not_applicable",
			/not applicable/,
		],
		[
			{ ...publicPullRequest, pullRequestAuthor: "dependabot[bot]" },
			false,
			"public_credential_free_not_applicable",
			/not applicable/,
		],
		[
			{ headRepository: "example-org/fork" },
			false,
			"replay_not_authorized",
			/::error::Workflow-relevant private-repository fork/,
		],
		[
			{
				repository: "Fabric-Pro/fabric-dev",
				headRepository: "example-org/fork",
			},
			false,
			"replay_not_authorized",
			/::error::Workflow-relevant private-repository fork/,
		],
		[
			{
				repository: "example-org/fabric",
				headRepository: "example-org/fabric",
			},
			false,
			"replay_not_authorized",
			/::error::/,
		],
		[
			{ workflowsChanged: false },
			false,
			"no_workflow_changes",
			/no relevant files changed/,
		],
		[
			{ workflowsChanged: false, headRepository: "example-org/fork" },
			false,
			"no_workflow_changes",
			/no relevant files changed/,
		],
		[
			{ ...relay, workflowsChanged: false },
			false,
			"no_workflow_changes",
			/no relevant files changed/,
		],
		[
			{ changesResult: "failure" },
			false,
			"change_detection_failed",
			/::error::Credential-free Temporal change detection failed/,
		],
		[
			{ workflowsChanged: undefined },
			false,
			"invalid_change_detection_output",
			/::error::Temporal change detection returned invalid output/,
		],
	];
	const script = stepScript("Report credential-free replay policy");
	assert.match(
		script,
		/No checkout, dependency installation, private history access, secrets, or PR code execution occurred/,
	);
	assert.match(script, /manual policy is not automated by this check/);
	for (const [override, run, reason, message] of cases) {
		const input = { ...basePullRequest, ...override };
		assert.deepEqual(evaluateCredentialFreeOutcome(input), { run, reason });
		const result = spawnSync("bash", ["-c", script], {
			encoding: "utf8",
			env: {
				...process.env,
				REPOSITORY: input.repository,
				HEAD_REPOSITORY: input.headRepository,
				PR_AUTHOR: input.pullRequestAuthor,
				HEAD_REF: input.headRef,
				CHANGES_RESULT: input.changesResult,
				WORKFLOWS_CHANGED: String(input.workflowsChanged ?? ""),
				REPLAY_REQUIRED: String(run),
			},
		});
		assert.equal(
			result.status,
			message.source.startsWith("::error::") ? 1 : 0,
			reason,
		);
		assert.match(result.stdout, message, reason);
	}
	for (const eventName of [
		"workflow_dispatch",
		"pull_request_target",
		"schedule",
		"push",
	]) {
		assert.deepEqual(
			evaluateCredentialFreeOutcome({ ...basePullRequest, eventName }),
			{
				run: false,
				reason: "unsupported_event",
			},
		);
	}
});

test("snapshot metadata validation enforces age, UTC timestamp, and producer identity", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "example-replay-metadata-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const fixtures = join(cwd, "packages/temporal/__tests__/__fixtures__");
	await mkdir(fixtures, { recursive: true });
	const metadata = join(fixtures, "history-snapshot.json");
	const clock = join(cwd, "clock.cjs");
	const now = Date.parse("2026-01-02T12:00:00.000Z");
	await writeFile(clock, `Date.now = () => ${now};\n`);
	const minute = 60_000;
	const fresh = {
		fetchedAt: new Date(now - minute).toISOString(),
		sourceSha: "a".repeat(40),
		runId: "123",
		runAttempt: "2",
	};
	const atAge = (minutes) => ({
		...fresh,
		fetchedAt: new Date(now - minutes * minute).toISOString(),
	});
	const script = stepScript("Validate snapshot metadata");
	for (const [name, input, expectedError] of [
		["fresh", fresh],
		[
			"UTC offset with no fractions",
			{ ...fresh, fetchedAt: "2026-01-02T11:59:00+00:00" },
		],
		["23h59m", atAge(24 * 60 - 1)],
		["24h", atAge(24 * 60)],
		["24h01m", atAge(24 * 60 + 1), /age 24\.02 hours/],
		[
			"missing file",
			undefined,
			/history-snapshot\.json is missing or invalid JSON/,
		],
		[
			"invalid JSON",
			"{",
			/history-snapshot\.json is missing or invalid JSON/,
		],
		[
			"missing fetchedAt",
			{ ...fresh, fetchedAt: undefined },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"fetchedAt is not a string",
			{ ...fresh, fetchedAt: [fresh.fetchedAt] },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"invalid fetchedAt",
			{ ...fresh, fetchedAt: "yesterday" },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"non-UTC time",
			{ ...fresh, fetchedAt: "2026-01-02T12:00:00.000+02:00" },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"unknown UTC offset",
			{ ...fresh, fetchedAt: "2026-01-02T11:59:00-00:00" },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"normalized midnight",
			{ ...fresh, fetchedAt: "2026-01-01T24:00:00Z" },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"invalid calendar month",
			{ ...fresh, fetchedAt: "2026-13-01T12:00:00.000Z" },
			/fetchedAt is not a valid UTC timestamp/,
		],
		[
			"invalid calendar date",
			{ ...fresh, fetchedAt: "2026-02-30T12:00:00.000Z" },
			/fetchedAt is not a valid UTC timestamp/,
		],
		["future within skew", atAge(-5)],
		["future beyond skew", atAge(-6), /age -0\.10 hours/],
		[
			"missing source SHA",
			{ ...fresh, sourceSha: undefined },
			/sourceSha is invalid/,
		],
		[
			"non-string sourceSha",
			{ ...fresh, sourceSha: [fresh.sourceSha] },
			/sourceSha is invalid/,
		],
		[
			"invalid source SHA",
			{ ...fresh, sourceSha: "branch" },
			/sourceSha is invalid/,
		],
		[
			"missing producer run ID",
			{ ...fresh, runId: undefined },
			/runId is invalid/,
		],
		["non-string runId", { ...fresh, runId: 123 }, /runId is invalid/],
		[
			"invalid producer run ID",
			{ ...fresh, runId: "0" },
			/runId is invalid/,
		],
		[
			"missing producer run attempt",
			{ ...fresh, runAttempt: undefined },
			/runAttempt is invalid/,
		],
		[
			"non-string runAttempt",
			{ ...fresh, runAttempt: 2 },
			/runAttempt is invalid/,
		],
		[
			"invalid producer run attempt",
			{ ...fresh, runAttempt: "0" },
			/runAttempt is invalid/,
		],
		[
			"source SHA differs from the selected run",
			{ ...fresh, sourceSha: "b".repeat(40) },
			/metadata does not match the selected producer run/,
		],
		[
			"run ID differs from the selected run",
			{ ...fresh, runId: "124" },
			/metadata does not match the selected producer run/,
		],
		[
			"run attempt differs from the selected attempt",
			{ ...fresh, runAttempt: "3" },
			/metadata does not match the selected producer run/,
		],
	]) {
		await t.test(name, async () => {
			await rm(metadata, { force: true });
			if (input !== undefined) {
				await writeFile(
					metadata,
					typeof input === "string" ? input : JSON.stringify(input),
				);
			}
			const result = spawnSync("bash", ["-c", script], {
				cwd,
				encoding: "utf8",
				env: {
					...process.env,
					NODE_OPTIONS: `--require=${clock}`,
					GITHUB_SERVER_URL: "https://example.com",
					GITHUB_REPOSITORY: "example-org/source",
					SNAPSHOT_RUN_SHA: fresh.sourceSha,
					SNAPSHOT_RUN_ID: fresh.runId,
					SNAPSHOT_RUN_ATTEMPT: fresh.runAttempt,
					SNAPSHOT_PRODUCER_URL:
						"https://example.com/example-org/source/actions/runs/123",
				},
			});
			const output = result.stdout + result.stderr;
			if (expectedError) {
				assert.equal(result.status, 1, output);
				assert.match(output, expectedError);
				assert.match(
					output,
					/Run "Temporal Replay Validation" manually on staging to refresh the snapshot, then re-run this check/,
				);
			} else {
				assert.equal(result.status, 0, output);
				assert.match(output, /Snapshot age: -?\d+\.\d+ hours/);
				assert.ok(output.includes(fresh.sourceSha));
				assert.match(
					output,
					/https:\/\/example\.com\/example-org\/source\/actions\/runs\/123\/attempts\/2/,
				);
				assert.match(
					output,
					/Artifact producer run: https:\/\/example\.com\/example-org\/source\/actions\/runs\/123\n$/,
				);
			}
		});
	}
});

test("the final replay assertion rejects required skipped, failed, or missing replay", () => {
	const script = stepScript("Require successful replay when applicable");
	for (const [required, outcome, expected] of [
		["true", "skipped", 1],
		["true", "failure", 1],
		["true", "cancelled", 1],
		["true", "", 1],
		["true", "success", 0],
		["false", "skipped", 0],
	]) {
		const result = spawnSync("bash", ["-c", script], {
			encoding: "utf8",
			env: {
				...process.env,
				REPLAY_REQUIRED: required,
				REPLAY_OUTCOME: outcome,
			},
		});
		assert.equal(
			result.status,
			expected,
			`${required}/${outcome}: ${result.stdout}${result.stderr}`,
		);
		if (expected === 1) {
			assert.match(
				result.stdout,
				/::error::Required Temporal replay did not succeed/,
			);
		}
	}
});

test("policy files are workflow-relevant and actions are SHA-pinned", () => {
	for (const workflow of [trustedWorkflow, companion]) {
		assert.match(workflow, /- '\.github\/scripts\/temporal-replay\/\*\*'/);
		assert.match(
			workflow,
			/- '\.github\/workflows\/temporal-replay-pr-check\.yml'/,
		);
		assert.match(
			workflow,
			/- '\.github\/workflows\/temporal-replay-validation\.yml'/,
		);
		for (const [, reference] of workflow.matchAll(
			/^\s+uses: ([^\s#]+)/gm,
		)) {
			if (
				reference !== "./.github/workflows/private-promotion-policy.yml"
			) {
				assert.match(reference, /@[0-9a-f]{40}$/);
			}
		}
	}
});

const snapshotJob = trustedWorkflow.split("\n  snapshot_histories:\n")[1];

function snapshotEncryptStep() {
	return snapshotJob
		.split("\n      - ")
		.find((step) =>
			step.startsWith("name: Encrypt replay history snapshot\n"),
		);
}

test("snapshot encryption uses a private temporary GPG home and cleans it up on exit", () => {
	const step = snapshotEncryptStep();
	assert.ok(step);
	assert.ok(
		step.includes(
			'GNUPGHOME=$(mktemp -d "$RUNNER_TEMP/temporal-replay-gnupg.XXXXXX")',
		),
	);
	assert.ok(step.includes('chmod 700 "$GNUPGHOME"'));
	assert.match(step, /^ {10}export GNUPGHOME$/m);
	const cleanup = step.match(/^ {10}trap '([^']*)^ {10}' EXIT$/m)?.[1];
	assert.ok(cleanup);
	assert.ok(
		cleanup.includes('gpgconf --homedir "$GNUPGHOME" --kill all || true'),
	);
	assert.ok(cleanup.includes('rm -rf -- "$GNUPGHOME"'));
	assert.ok(cleanup.includes('rm -f -- "$archive"'));
});

test("snapshot decryption sets up a private GPG home after the key guard and cleans up on exit", () => {
	const script = stepScript("Decrypt replay history snapshot");
	const guardEnd = script.indexOf("\nfi\n");
	const ciphertextStart = script.indexOf("\nciphertext=");
	assert.ok(guardEnd >= 0 && ciphertextStart > guardEnd);
	assert.equal(
		script.slice(guardEnd, ciphertextStart),
		[
			"",
			"fi",
			"",
			"# Keep the passphrase in the shell and feed GPG on stdin only.",
			"export -n REPLAY_SNAPSHOT_KEY",
			"archive=",
			'GNUPGHOME=$(mktemp -d "$RUNNER_TEMP/temporal-replay-gnupg.XXXXXX")',
			"trap '",
			'  rm -f -- "$archive"',
			'  gpgconf --homedir "$GNUPGHOME" --kill all || true',
			'  rm -rf -- "$GNUPGHOME"',
			"' EXIT",
			'chmod 700 "$GNUPGHOME"',
			"export GNUPGHOME",
			'archive=$(mktemp "$RUNNER_TEMP/temporal-replay-snapshot.XXXXXX")',
		].join("\n"),
	);
});
