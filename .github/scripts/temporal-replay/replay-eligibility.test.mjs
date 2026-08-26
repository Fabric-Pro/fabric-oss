import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	CREDENTIAL_FREE_JOB_NAME_EXPRESSION,
	credentialFreeCheckName,
	DELEGATED_CHECK_NAME,
	evaluateAggregateOutcome,
	evaluateCredentialFreeOutcome,
	evaluateReplayEligibility,
	evaluateTrustedDenial,
	REPLAY_JOB_CONDITION,
	REQUIRED_CHECK_NAME,
	shouldRunReplay,
	TRUSTED_DENIAL_JOB_CONDITION,
} from "./replay-eligibility.mjs";

const trustedWorkflow = await readFile(
	new URL("../../workflows/temporal-replay-validation.yml", import.meta.url),
	"utf8",
);
const credentialFreeWorkflow = await readFile(
	new URL("../../workflows/temporal-replay-pr-check.yml", import.meta.url),
	"utf8",
);

const basePullRequest = {
	eventName: "pull_request_target",
	repository: "Fabric-Pro/fabric",
	headRepository: "Fabric-Pro/fabric",
	pullRequestAuthor: "developer",
	headRef: "feature/replay-safe-change",
	workflowsChanged: true,
	initialStatusResult: "success",
	authorizationResult: "success",
	changesResult: "success",
	replayResult: "success",
};

function normalizeExpression(expression) {
	return expression.replaceAll(/\s+/g, " ").trim();
}

function jobBody(workflow, name, nextName) {
	const end = nextName ? `\n {2}${nextName}:` : "$";
	const match = workflow.match(
		new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)${end}`),
	);
	assert.ok(match, `${name} job was not found`);
	return match[1];
}

function blockExpression(job, followingKey) {
	const match = job.match(
		new RegExp(
			`\\n {4}(?:if|name): >-\\n([\\s\\S]*?)\\n {4}${followingKey}:`,
		),
	);
	assert.ok(match, `block expression before ${followingKey} was not found`);
	return match[1]
		.replace(/^\s*\$\{\{/, "")
		.replace(/\}\}\s*$/, "")
		.trim();
}

const trustedChangesJob = jobBody(trustedWorkflow, "changes", "authorize");
const authorizeJob = jobBody(trustedWorkflow, "authorize", "publish_denial");
const denialJob = jobBody(
	trustedWorkflow,
	"publish_denial",
	"initialize_status",
);
const initializeJob = jobBody(trustedWorkflow, "initialize_status", "replay");
const replayJob = jobBody(trustedWorkflow, "replay", "publish_outcome");
const publishJob = jobBody(trustedWorkflow, "publish_outcome");
const credentialChangesJob = jobBody(
	credentialFreeWorkflow,
	"changes",
	"replay_check",
);
const credentialCheckJob = jobBody(credentialFreeWorkflow, "replay_check");

test("secret-bearing execution uses only trusted default-branch workflow code", () => {
	assert.match(trustedWorkflow, /^ {2}pull_request_target:$/m);
	assert.doesNotMatch(trustedWorkflow, /^ {2}pull_request:$/m);
	assert.match(trustedWorkflow, /^ {2}workflow_dispatch:$/m);
	assert.match(trustedWorkflow, /^permissions: \{\}$/m);
});

test("credential-free producer is pull_request-only and has no private execution surface", () => {
	assert.match(credentialFreeWorkflow, /^ {2}pull_request:$/m);
	assert.doesNotMatch(credentialFreeWorkflow, /^ {2}pull_request_target:$/m);
	assert.match(credentialFreeWorkflow, /^permissions: \{\}$/m);
	assert.doesNotMatch(credentialFreeWorkflow, /\$\{\{\s*secrets\./);
	assert.doesNotMatch(credentialFreeWorkflow, /^ {4}environment:/m);
	assert.doesNotMatch(
		credentialFreeWorkflow,
		/actions\/checkout|pnpm install|fetch:replay-histories|test:replay/,
	);
	assert.doesNotMatch(credentialFreeWorkflow, /statuses: write/);
	assert.doesNotMatch(
		credentialFreeWorkflow,
		/TEMPORAL_(?:ADDRESS|NAMESPACE|CLOUD_API_KEY)/,
	);
});

test("dynamic automatic CheckRun name exactly matches tested producer routing", () => {
	assert.equal(
		normalizeExpression(blockExpression(credentialCheckJob, "needs")),
		normalizeExpression(CREDENTIAL_FREE_JOB_NAME_EXPRESSION),
	);
	assert.match(credentialCheckJob, /if: always\(\)/);
});

test("trusted replay gate exactly matches the tested eligibility policy", () => {
	assert.equal(
		normalizeExpression(blockExpression(replayJob, "runs-on")),
		normalizeExpression(REPLAY_JOB_CONDITION),
	);
	assert.match(replayJob, /^ {4}environment: dev$/m);
});

test("trusted denial gate exactly matches the tested blocking policy", () => {
	assert.equal(
		normalizeExpression(blockExpression(denialJob, "runs-on")),
		normalizeExpression(TRUSTED_DENIAL_JOB_CONDITION),
	);
	assert.match(denialJob, /needs: \[changes, authorize\]/);
});

test("pending and final replay statuses run only for eligible relevant PRs or manual dispatch", () => {
	for (const job of [initializeJob, publishJob]) {
		assert.match(job, /needs\.changes\.outputs\.workflows == 'true'/);
		assert.match(
			job,
			/needs\.authorize\.outputs\.secret_eligible == 'true'/,
		);
	}
	assert.match(initializeJob, /needs: \[changes, authorize\]/);
	assert.match(publishJob, /if: >-\n {6}always\(\)/);
	assert.equal(
		[...trustedWorkflow.matchAll(/statuses\/\$PR_HEAD_SHA/g)].length,
		3,
	);
	assert.equal(
		[...trustedWorkflow.matchAll(/--raw-field context=replay-validation/g)]
			.length,
		3,
	);
	assert.equal(
		[...trustedWorkflow.matchAll(/^ {6}statuses: write$/gm)].length,
		3,
	);
});

test("trusted gate executes no PR code before authorization", () => {
	for (const [name, body] of [
		["authorize", authorizeJob],
		["publish_denial", denialJob],
		["initialize_status", initializeJob],
	]) {
		assert.doesNotMatch(
			body,
			/actions\/checkout|pnpm install|secrets\.|environment:/,
		);
		assert.doesNotMatch(
			body,
			/^ {6}uses:/m,
			`${name} must not execute an action`,
		);
	}
	assert.match(
		trustedChangesJob,
		/if: github\.event_name == 'workflow_dispatch'/,
	);
	assert.doesNotMatch(
		trustedChangesJob,
		/ref: \$\{\{ github\.event\.pull_request\.head/,
	);
	assert.doesNotMatch(credentialChangesJob, /actions\/checkout/);
});

test("trusted gate enforces exact repository, App creator, and relay namespace metadata", () => {
	assert.match(
		authorizeJob,
		/if \[\[ "\$HEAD_REPOSITORY" != "\$REPOSITORY" \]\]; then/,
	);
	assert.match(
		authorizeJob,
		/"\$REPOSITORY" == "Fabric-Pro\/fabric" \|\|\n {18}"\$REPOSITORY" == "Fabric-Pro\/fabric-dev"/,
	);
	assert.match(
		authorizeJob,
		/"\$PR_AUTHOR" == "fabric-relay\[bot\]" &&\n {18}"\$HEAD_REF" == relay\/\*/,
	);
	assert.match(authorizeJob, /public_pr_outside_relay_namespace/);
});

test("eligible PR replay checks out only the immutable PR head SHA", () => {
	assert.match(replayJob, /if: github\.event_name == 'pull_request_target'/);
	assert.match(
		replayJob,
		/ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
	);
	assert.equal(
		[
			...replayJob.matchAll(
				/ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/g,
			),
		].length,
		1,
	);
	assert.equal(
		[...replayJob.matchAll(/persist-credentials: false/g)].length,
		2,
	);
});

test("required trusted status is posted to the exact validated PR head SHA", () => {
	assert.match(initializeJob, /--raw-field state=pending/);
	assert.match(denialJob, /--raw-field state=failure/);
	assert.match(publishJob, /--raw-field state="\$state"/);
	assert.doesNotMatch(trustedWorkflow, /^ {4}name: replay-validation$/m);
	assert.equal(
		[...trustedWorkflow.matchAll(/\^\[0-9a-f\]\{40\}\$/g)].length,
		4,
	);
});

test("event values enter shell through env rather than expression interpolation", () => {
	for (const job of [
		initializeJob,
		authorizeJob,
		denialJob,
		publishJob,
		credentialCheckJob,
	]) {
		const scripts = [
			...job.matchAll(/run: \|\n([\s\S]*?)(?=\n {6}\S|$)/g),
		].map(([, script]) => script);
		for (const script of scripts) {
			assert.doesNotMatch(script, /\$\{\{/);
		}
	}
	assert.match(trustedWorkflow, /--raw-field description="\$description"/);
});

test("trusted manual dispatch always runs the real replay", () => {
	const manual = {
		...basePullRequest,
		eventName: "workflow_dispatch",
		repository: "example/renamed-repository",
		headRepository: undefined,
		pullRequestAuthor: undefined,
		headRef: undefined,
		workflowsChanged: false,
	};
	assert.deepEqual(shouldRunReplay(manual), {
		run: true,
		reason: "trusted_manual_dispatch",
	});
	assert.deepEqual(evaluateAggregateOutcome(manual), {
		success: true,
		reason: "replay_passed",
	});
});

test("private same-repository relevant PRs delegate to trusted real replay", () => {
	for (const repository of ["Fabric-Pro/fabric", "Fabric-Pro/fabric-dev"]) {
		const input = {
			...basePullRequest,
			repository,
			headRepository: repository,
		};
		assert.equal(shouldRunReplay(input).run, true);
		assert.equal(credentialFreeCheckName(input), DELEGATED_CHECK_NAME);
		assert.deepEqual(evaluateCredentialFreeOutcome(input), {
			success: true,
			reason: "delegated_to_trusted_replay",
		});
	}
});

test("fabric-oss relay eligibility is exact and has exclusive producers", () => {
	const input = {
		...basePullRequest,
		repository: "Fabric-Pro/fabric-oss",
		headRepository: "Fabric-Pro/fabric-oss",
		pullRequestAuthor: "fabric-relay[bot]",
		headRef: "relay/staging-pr-11-2870647a7196",
	};
	assert.deepEqual(evaluateReplayEligibility(input), {
		eligible: true,
		reason: "authenticated_public_relay_pr",
	});
	assert.equal(credentialFreeCheckName(input), DELEGATED_CHECK_NAME);
	assert.deepEqual(evaluateCredentialFreeOutcome(input), {
		success: true,
		reason: "delegated_to_trusted_replay",
	});
	assert.equal(shouldRunReplay(input).run, true);
});

test("ordinary, fork, and Dependabot fabric-oss PRs get a green required credential-free check", () => {
	for (const pullRequest of [
		{
			headRepository: "Fabric-Pro/fabric-oss",
			pullRequestAuthor: "external-contributor",
			headRef: "feature/replay-fix",
		},
		{
			headRepository: "external-contributor/fabric-oss",
			pullRequestAuthor: "external-contributor",
			headRef: "replay-fix",
		},
		{
			headRepository: "Fabric-Pro/fabric-oss",
			pullRequestAuthor: "dependabot[bot]",
			headRef: "dependabot/npm_and_yarn/example-1.0.0",
		},
	]) {
		const input = {
			...basePullRequest,
			...pullRequest,
			repository: "Fabric-Pro/fabric-oss",
			replayResult: "skipped",
		};
		assert.equal(credentialFreeCheckName(input), REQUIRED_CHECK_NAME);
		assert.deepEqual(evaluateCredentialFreeOutcome(input), {
			success: true,
			reason: "public_credential_free_not_applicable",
		});
		assert.deepEqual(evaluateTrustedDenial(input), {
			publish: false,
			reason: "trusted_denial_not_required",
		});
		assert.equal(shouldRunReplay(input).run, false);
	}
	assert.match(
		credentialCheckJob,
		/No checkout, dependency installation, private history access, secrets, or PR code execution occurred/,
	);
});

test("no-change PRs get the stable required credential-free check", () => {
	const input = { ...basePullRequest, workflowsChanged: false };
	assert.equal(credentialFreeCheckName(input), REQUIRED_CHECK_NAME);
	assert.deepEqual(evaluateCredentialFreeOutcome(input), {
		success: true,
		reason: "no_workflow_changes",
	});
	assert.deepEqual(evaluateTrustedDenial(input), {
		publish: false,
		reason: "no_workflow_changes",
	});
});

test("trusted failures pair with any PR-controlled required CheckRun", () => {
	const privateFork = {
		...basePullRequest,
		headRepository: "external-contributor/fabric",
		replayResult: "skipped",
	};
	assert.equal(credentialFreeCheckName(privateFork), REQUIRED_CHECK_NAME);
	assert.deepEqual(evaluateCredentialFreeOutcome(privateFork), {
		success: false,
		reason: "replay_not_authorized",
	});
	assert.deepEqual(evaluateTrustedDenial(privateFork), {
		publish: true,
		reason: "private_replay_not_authorized",
	});

	const relayNamespaceMistake = {
		...basePullRequest,
		repository: "Fabric-Pro/fabric-oss",
		headRepository: "Fabric-Pro/fabric-oss",
		pullRequestAuthor: "fabric-relay[bot]",
		headRef: "feature/not-relay",
		replayResult: "skipped",
	};
	assert.equal(
		credentialFreeCheckName(relayNamespaceMistake),
		REQUIRED_CHECK_NAME,
	);
	assert.deepEqual(evaluateCredentialFreeOutcome(relayNamespaceMistake), {
		success: false,
		reason: "public_pr_outside_relay_namespace",
	});
	assert.deepEqual(evaluateAggregateOutcome(relayNamespaceMistake), {
		success: false,
		reason: "replay_not_authorized",
	});
	assert.deepEqual(evaluateTrustedDenial(relayNamespaceMistake), {
		publish: true,
		reason: "public_pr_outside_relay_namespace",
	});
	assert.match(denialJob, /--raw-field context=replay-validation/);
	assert.match(denialJob, /--raw-field state=failure/);
	assert.match(denialJob, /branch protection requires both to\n {4}# pass/);
});

test("change-detection failures fail the credential-free required check", () => {
	for (const [override, reason] of [
		[{ changesResult: "failure" }, "change_detection_failed"],
		[{ workflowsChanged: undefined }, "invalid_change_detection_output"],
	]) {
		const input = { ...basePullRequest, ...override };
		assert.equal(credentialFreeCheckName(input), REQUIRED_CHECK_NAME);
		assert.deepEqual(evaluateCredentialFreeOutcome(input), {
			success: false,
			reason,
		});
	}
});

test("trusted change and authorization failures publish exact-head denial", () => {
	assert.deepEqual(
		evaluateTrustedDenial({ ...basePullRequest, changesResult: "failure" }),
		{ publish: true, reason: "trusted_change_detection_failed" },
	);
	assert.deepEqual(
		evaluateTrustedDenial({
			...basePullRequest,
			workflowsChanged: undefined,
		}),
		{ publish: true, reason: "invalid_change_detection_output" },
	);
	assert.deepEqual(
		evaluateTrustedDenial({
			...basePullRequest,
			authorizationResult: "failure",
		}),
		{ publish: true, reason: "trusted_authorization_failed" },
	);
	assert.deepEqual(
		evaluateTrustedDenial({
			...basePullRequest,
			workflowsChanged: false,
			authorizationResult: "failure",
		}),
		{ publish: false, reason: "no_workflow_changes" },
	);
});

test("eligible skipped, failed, or unauthorized real replays stay blocking", () => {
	for (const replayResult of ["skipped", "failure"]) {
		assert.equal(
			evaluateAggregateOutcome({ ...basePullRequest, replayResult })
				.success,
			false,
		);
	}
	assert.deepEqual(
		evaluateAggregateOutcome({
			...basePullRequest,
			repository: "Fabric-Pro/fabric-oss",
			headRepository: "Fabric-Pro/fabric-oss",
			pullRequestAuthor: "contributor",
			replayResult: "success",
		}),
		{ success: false, reason: "ineligible_replay_executed" },
	);
});

test("Temporal credentials and environment exist only in guarded replay", () => {
	assert.equal(
		[...replayJob.matchAll(/\$\{\{ secrets\.TEMPORAL_[A-Z_]+ \}\}/g)]
			.length,
		6,
	);
	assert.equal(
		[...trustedWorkflow.matchAll(/\$\{\{ secrets\.[A-Z_]+ \}\}/g)].length,
		6,
	);
	assert.equal(
		[...trustedWorkflow.matchAll(/^ {4}environment: dev$/gm)].length,
		1,
	);
	assert.doesNotMatch(replayJob, /statuses: write/);
});

test("messages distinguish credential-free and real replay outcomes", () => {
	assert.match(
		credentialCheckJob,
		/Credential-free: private Temporal replay is not applicable/,
	);
	assert.match(publishJob, /Real dev-history Temporal replay passed/);
	assert.match(
		credentialCheckJob,
		/manual policy is not automated by this check/,
	);
});

test("policy files are workflow-relevant and every action is SHA-pinned", () => {
	for (const workflow of [trustedWorkflow, credentialFreeWorkflow]) {
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
			assert.match(reference, /@[0-9a-f]{40}$/);
		}
	}
});
