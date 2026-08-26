import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";

const workflow = await readFile(
	new URL(
		"../../workflows/oss-dev-snapshot-verification.yml",
		import.meta.url,
	),
	"utf8",
);
const verifierUrl = new URL("./verify-dev-snapshot.sh", import.meta.url);
const verifierPath = fileURLToPath(verifierUrl);
const verifier = await readFile(verifierUrl, "utf8");

test("the consumer covers the exact 14-image snapshot set", () => {
	const componentBlock = verifier.match(/COMPONENTS=\(\n([\s\S]+?)\n\)/)?.[1];
	assert.ok(componentBlock);
	const components = componentBlock
		.trim()
		.split("\n")
		.map((line) => line.trim());
	assert.deepEqual(
		components,
		SNAPSHOT_IMAGES.map(({ component }) => component).sort(),
	);
	assert.equal(components.length, 14);
});

test("the workflow runs only for fabric-dev master with serialized runs", () => {
	assert.match(workflow, /push:\n\s+branches: \[master\]/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(
		workflow,
		/if: github\.repository == 'Fabric-Pro\/fabric-dev' && github\.ref == 'refs\/heads\/master'/,
	);
	assert.match(workflow, /concurrency:[\s\S]+cancel-in-progress: false/);
	assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

test("the consumer has read-only GitHub permissions and no cloud identity", () => {
	for (const permission of [
		"contents: read",
		"packages: read",
		"attestations: read",
	]) {
		assert.ok(
			workflow.includes(permission),
			`missing permission ${permission}`,
		);
	}
	assert.doesNotMatch(workflow, /(?:contents|packages|attestations): write/);
	assert.doesNotMatch(workflow, /id-token: write/);
	assert.doesNotMatch(
		workflow,
		/azure\/login|az acr import|az containerapp/i,
	);
});

test("all actions are pinned and exact-SHA evidence is retained", () => {
	const actionReferences = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(
		([, reference]) => reference,
	);
	assert.ok(actionReferences.length > 0);
	for (const reference of actionReferences) {
		assert.match(reference, /@[0-9a-f]{40}$/);
	}
	assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
	assert.match(workflow, /retention-days: 90/);
	assert.doesNotMatch(workflow, /(?:^|:)latest(?:$|\s)/m);
});

test("resolution is bounded, authenticated, and never falls back", () => {
	assert.match(
		verifier,
		/docker buildx imagetools inspect[\s\S]+"\$\{image\}:\$\{SOURCE_SHA\}"/,
	);
	assert.match(
		verifier,
		/MAX_WAIT_SECONDS="\$\{SNAPSHOT_MAX_WAIT_SECONDS:-1500\}"/,
	);
	assert.match(verifier, /elapsed >= MAX_WAIT_SECONDS/);
	assert.match(verifier, /does not have read access/);
	assert.doesNotMatch(verifier, /(?:^|:)latest(?:$|\s)/m);
});

test("attestations bind the OSS producer and come from the private registry", () => {
	for (const option of [
		"--bundle-from-oci",
		"--repo",
		"--signer-workflow",
		"--source-digest",
		"--source-ref",
		"--deny-self-hosted-runners",
	]) {
		assert.ok(
			verifier.includes(option),
			`missing verifier option ${option}`,
		);
	}
	assert.match(
		verifier,
		/--predicate-type https:\/\/spdx\.dev\/Document\/v2\.3/,
	);
	assert.match(verifier, /oci:\/\/\$\{image\}@\$\{digest\}/);
	assert.match(verifier, /mode: "verification-only"/);
});

test("an invalid source SHA fails before any registry command", () => {
	const result = spawnSync("bash", [verifierPath, "not-a-sha"], {
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /exact lowercase 40-character commit OID/);
});

test("the verifier resolves and verifies every component in an offline harness", async () => {
	const fixtureDir = await mkdtemp(join(tmpdir(), "oss-snapshot-consumer-"));
	const dockerPath = join(fixtureDir, "docker");
	const ghPath = join(fixtureDir, "gh");
	const ghLog = join(fixtureDir, "gh.log");
	const ghState = join(fixtureDir, "gh.state");
	const evidencePath = join(fixtureDir, "evidence.json");
	const digest = `sha256:${"a".repeat(64)}`;
	await writeFile(
		dockerPath,
		`#!/usr/bin/env bash
if [[ "$*" == *"{{json .Image}}"* ]]; then
	printf '%s\\n' '${JSON.stringify({ architecture: "amd64", os: "linux" })}'
else
	printf '%s\\n' '${JSON.stringify({
		digest,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
	})}'
fi
`,
	);
	await writeFile(
		ghPath,
		`#!/usr/bin/env bash
if [[ ! -e "$GH_STATE" ]]; then
	touch "$GH_STATE"
	echo 'no attestation bundles found' >&2
	exit 1
fi
printf '%s\\n' "$*" >>"$GH_LOG"
`,
	);
	await Promise.all([chmod(dockerPath, 0o755), chmod(ghPath, 0o755)]);

	const result = spawnSync(
		"bash",
		[verifierPath, "a".repeat(40), evidencePath],
		{
			encoding: "utf8",
			env: {
				...process.env,
				GH_LOG: ghLog,
				GH_STATE: ghState,
				GH_TOKEN: "fixture-token",
				PATH: `${fixtureDir}:${process.env.PATH}`,
				SNAPSHOT_MAX_WAIT_SECONDS: "10",
				SNAPSHOT_POLL_INTERVAL_SECONDS: "1",
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Waiting for api-agent provenance attestation/);
	const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
	assert.equal(evidence.mode, "verification-only");
	assert.equal(evidence.sourceSha, "a".repeat(40));
	assert.equal(evidence.images.length, 14);
	assert.deepEqual(
		evidence.images.map(({ component }) => component),
		SNAPSHOT_IMAGES.map(({ component }) => component).sort(),
	);
	assert.ok(evidence.images.every((image) => image.digest === digest));

	const ghCalls = (await readFile(ghLog, "utf8")).trim().split("\n");
	assert.equal(ghCalls.length, 28);
	assert.ok(ghCalls.every((call) => call.includes("--bundle-from-oci")));
	assert.equal(
		ghCalls.filter((call) => call.includes("--predicate-type")).length,
		14,
	);
});

test("registry authorization failures stop immediately", async () => {
	const fixtureDir = await mkdtemp(join(tmpdir(), "oss-snapshot-auth-"));
	const dockerPath = join(fixtureDir, "docker");
	const ghPath = join(fixtureDir, "gh");
	await writeFile(
		dockerPath,
		"#!/usr/bin/env bash\necho 'unauthorized: authentication required' >&2\nexit 1\n",
	);
	await writeFile(ghPath, "#!/usr/bin/env bash\nexit 0\n");
	await Promise.all([chmod(dockerPath, 0o755), chmod(ghPath, 0o755)]);

	const result = spawnSync("bash", [verifierPath, "b".repeat(40)], {
		encoding: "utf8",
		env: {
			...process.env,
			GH_TOKEN: "fixture-token",
			PATH: `${fixtureDir}:${process.env.PATH}`,
			SNAPSHOT_MAX_WAIT_SECONDS: "60",
			SNAPSHOT_POLL_INTERVAL_SECONDS: "1",
		},
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not have read access/);
});

test("the workflow rechecks master only after verification and never mutates", () => {
	const verifyIndex = workflow.indexOf(
		"Resolve and verify all exact-SHA snapshots",
	);
	const tipIndex = workflow.indexOf(
		"Recheck staging tip before any future mutation",
	);
	assert.ok(verifyIndex >= 0 && tipIndex > verifyIndex);
	assert.match(
		workflow,
		/git fetch --no-tags --depth=1 origin refs\/heads\/master/,
	);
	assert.match(workflow, /current_sha.*!=.*GITHUB_SHA/);
	assert.match(workflow, /Mode: verification-only/);
});
