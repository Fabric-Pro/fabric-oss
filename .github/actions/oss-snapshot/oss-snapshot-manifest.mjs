import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_IMAGES = Object.freeze([
	{
		component: "temporal-worker",
		dockerfile: "packages/temporal/Dockerfile",
	},
	{
		component: "document-generator",
		dockerfile: "agents/langchain/document-generator/Dockerfile",
	},
	{
		component: "project-document-generator",
		dockerfile: "agents/langchain/project-document-generator/Dockerfile",
	},
	{
		component: "task-planner",
		dockerfile: "agents/langchain/task-planner/Dockerfile",
	},
	{
		component: "story-breakdown",
		dockerfile: "agents/langchain/story-breakdown/Dockerfile",
	},
	{
		component: "data-analyst",
		dockerfile: "agents/langchain/data-analyst/Dockerfile",
	},
	{
		component: "api-agent",
		dockerfile: "agents/langchain/api-agent/Dockerfile",
	},
	{
		component: "prompt-enhancer",
		dockerfile: "agents/langchain/prompt-enhancer/Dockerfile",
	},
	{
		component: "backlog-updater",
		dockerfile: "agents/langchain/backlog-updater/Dockerfile",
	},
	{
		component: "weave-readers",
		dockerfile: "agents/langchain/weave-readers/Dockerfile",
	},
	{
		component: "weave-shuttle",
		dockerfile: "agents/langchain/weave-shuttle/Dockerfile",
	},
	{
		component: "weave-planners",
		dockerfile: "agents/langchain/weave-planners/Dockerfile",
	},
	{
		component: "mcp-stdio-wrapper",
		dockerfile: "packages/mcp-stdio-wrapper/Dockerfile",
	},
	{
		component: "migration-runner",
		dockerfile: "packages/database/Dockerfile.migrate",
	},
]);

export const SNAPSHOT_NAMESPACE = "ghcr.io/fabric-pro/fabric-oss-snapshots";
export const SNAPSHOT_WORKFLOW = ".github/workflows/oss-snapshot-images.yml";

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
	throw new Error(`snapshot manifest validation failed: ${message}`);
}

function requireString(value, field) {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${field} must be a non-empty string`);
	}
	return value;
}

export function validateSnapshotFragments(fragments, expected) {
	if (!Array.isArray(fragments)) {
		fail("fragments must be an array");
	}

	for (const field of [
		"repository",
		"sourceSha",
		"sourceRef",
		"workflowRef",
		"serverUrl",
	]) {
		requireString(expected?.[field], `expected.${field}`);
	}
	if (!SHA_RE.test(expected.sourceSha)) {
		fail("expected.sourceSha must be a full 40-character lowercase SHA");
	}

	const expectedSource = `${expected.serverUrl}/${expected.repository}`;
	const signerWorkflow = `${expected.repository}/${SNAPSHOT_WORKFLOW}`;
	const expectedByComponent = new Map(
		SNAPSHOT_IMAGES.map((image) => [image.component, image]),
	);
	const seen = new Set();

	if (fragments.length !== SNAPSHOT_IMAGES.length) {
		fail(
			`expected ${SNAPSHOT_IMAGES.length} fragments, received ${fragments.length}`,
		);
	}

	for (const fragment of fragments) {
		const component = requireString(fragment?.component, "component");
		if (seen.has(component)) {
			fail(`duplicate component ${component}`);
		}
		seen.add(component);

		const imageDefinition = expectedByComponent.get(component);
		if (!imageDefinition) {
			fail(`unexpected component ${component}`);
		}
		if (fragment.schemaVersion !== "1.0.0") {
			fail(`${component} has an unsupported schemaVersion`);
		}
		if (fragment.dockerfile !== imageDefinition.dockerfile) {
			fail(`${component} has an unexpected Dockerfile`);
		}
		if (fragment.context !== ".") {
			fail(`${component} must use the repository root build context`);
		}

		const expectedImage = `${SNAPSHOT_NAMESPACE}/${component}`;
		if (fragment.image !== expectedImage) {
			fail(`${component} has unexpected image coordinates`);
		}
		if (fragment.tag !== expected.sourceSha) {
			fail(`${component} is not tagged by the full source SHA`);
		}
		if (!DIGEST_RE.test(fragment.digest)) {
			fail(`${component} has an invalid OCI digest`);
		}
		if (
			fragment.sourceRepository !== expected.repository ||
			fragment.sourceSha !== expected.sourceSha ||
			fragment.sourceRef !== expected.sourceRef
		) {
			fail(`${component} has unexpected source identity`);
		}
		if (
			fragment.buildWorkflow !== expected.workflowRef ||
			fragment.signerWorkflow !== signerWorkflow
		) {
			fail(`${component} has unexpected workflow identity`);
		}
		if (
			fragment.labels?.["org.opencontainers.image.source"] !==
				expectedSource ||
			fragment.labels?.["org.opencontainers.image.revision"] !==
				expected.sourceSha
		) {
			fail(`${component} has unexpected OCI source labels`);
		}
		if (
			fragment.attestations?.provenance !==
				"https://slsa.dev/provenance/v1" ||
			fragment.attestations?.sbom !== "https://spdx.dev/Document/v2.3"
		) {
			fail(`${component} does not record both required attestations`);
		}
	}

	for (const { component } of SNAPSHOT_IMAGES) {
		if (!seen.has(component)) {
			fail(`missing component ${component}`);
		}
	}

	return [...fragments].sort((a, b) =>
		a.component.localeCompare(b.component),
	);
}

export function createAggregateManifest(fragments, expected) {
	const images = validateSnapshotFragments(fragments, expected);
	return {
		schemaVersion: "1.0.0",
		kind: "fabric-oss-snapshot-set",
		sourceRepository: expected.repository,
		sourceSha: expected.sourceSha,
		sourceRef: expected.sourceRef,
		buildWorkflow: expected.workflowRef,
		images,
	};
}

async function readFragments(directory) {
	const names = (await readdir(directory)).filter((name) =>
		name.endsWith(".manifest.json"),
	);
	return Promise.all(
		names.map(async (name) =>
			JSON.parse(await readFile(path.join(directory, name), "utf8")),
		),
	);
}

function parseArguments(argv) {
	const args = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) {
			fail(`invalid command-line argument near ${key ?? "end of input"}`);
		}
		args.set(key.slice(2), value);
	}
	for (const key of [
		"directory",
		"output",
		"repository",
		"sha",
		"ref",
		"workflow-ref",
		"server-url",
	]) {
		if (!args.has(key)) {
			fail(`missing --${key}`);
		}
	}
	return args;
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const expected = {
		repository: args.get("repository"),
		sourceSha: args.get("sha"),
		sourceRef: args.get("ref"),
		workflowRef: args.get("workflow-ref"),
		serverUrl: args.get("server-url"),
	};
	const manifest = createAggregateManifest(
		await readFragments(args.get("directory")),
		expected,
	);
	await writeFile(
		args.get("output"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);

	const summary = args.get("summary");
	if (summary) {
		const rows = manifest.images.map(
			(image) =>
				`| \`${image.component}\` | \`${image.image}@${image.digest}\` |`,
		);
		await appendFile(
			summary,
			[
				"## OSS snapshot images",
				"",
				`Built and attested all ${manifest.images.length} images from \`${manifest.sourceSha}\`.`,
				"",
				"| Component | Immutable image |",
				"|---|---|",
				...rows,
				"",
			].join("\n"),
		);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
