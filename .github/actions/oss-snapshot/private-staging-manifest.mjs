import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAggregateManifest } from "./oss-snapshot-manifest.mjs";

const WORKFLOW = ".github/workflows/private-staging-images.yml";
const POLICY = Object.freeze({
	workflow: WORKFLOW,
	namespace: "ghcr.io/fabric-pro/fabric-dev-snapshots",
	kind: "fabric-private-staging-snapshot-set",
});
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
	throw new Error(`snapshot manifest validation failed: ${message}`);
}

// An automatic staging build may reuse an unchanged image from an earlier
// snapshot. That image keeps the revision label of the commit it was built
// from; once the reuse record accounts for it, the fragment is validated
// exactly like a fresh build.
function asFreshBuild(fragment, expected) {
	if (fragment === null || typeof fragment !== "object") {
		return fragment;
	}
	const { inputs, reuse, ...built } = fragment;
	const component = fragment.component;
	if (inputs !== undefined && !DIGEST_RE.test(inputs)) {
		fail(`${component} has malformed build inputs`);
	}
	if (reuse === undefined) {
		return built;
	}
	if (expected.sourceRef !== "refs/heads/staging") {
		fail(`${component} reuses an image outside automatic staging builds`);
	}
	if (
		!SHA_RE.test(reuse?.reusedFromSourceSha ?? "") ||
		!SHA_RE.test(reuse?.builtFromSourceSha ?? "") ||
		!/^[1-9][0-9]*$/.test(reuse?.reusedFromRun ?? "") ||
		inputs === undefined
	) {
		fail(`${component} has an invalid reuse record`);
	}
	if (
		built.labels?.["org.opencontainers.image.revision"] !==
		reuse.builtFromSourceSha
	) {
		fail(`${component} has unexpected OCI source labels`);
	}
	return {
		...built,
		labels: {
			...built.labels,
			"org.opencontainers.image.revision": expected.sourceSha,
		},
	};
}

export function createPrivateManifest(fragments, expected) {
	if (
		expected?.repository !== "Fabric-Pro/fabric-dev" ||
		expected.serverUrl !== "https://github.com" ||
		!/^refs\/heads\/(staging|promotion\/[a-zA-Z0-9_-]+)$/.test(
			expected.sourceRef,
		) ||
		expected.workflowRef !==
			`${expected.repository}/${WORKFLOW}@${expected.sourceRef}`
	) {
		throw new Error("unexpected private source identity");
	}
	if (!Array.isArray(fragments)) {
		return createAggregateManifest(fragments, expected, POLICY);
	}
	const manifest = createAggregateManifest(
		fragments.map((fragment) => asFreshBuild(fragment, expected)),
		expected,
		POLICY,
	);
	// The evidence records each fragment as emitted, reuse records included.
	const emitted = new Map(
		fragments.map((fragment) => [fragment.component, fragment]),
	);
	return {
		...manifest,
		images: manifest.images.map(({ component }) => emitted.get(component)),
	};
}

async function main() {
	const args = new Map();
	for (let index = 2; index < process.argv.length; index += 2) {
		const key = process.argv[index];
		const value = process.argv[index + 1];
		if (!key?.startsWith("--") || value === undefined || args.has(key)) {
			throw new Error("invalid manifest argument");
		}
		args.set(key, value);
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
		if (!args.has(`--${key}`)) {
			throw new Error(`missing --${key}`);
		}
	}
	const directory = args.get("--directory");
	const files = (await readdir(directory)).filter((name) =>
		name.endsWith(".manifest.json"),
	);
	const fragments = await Promise.all(
		files.map(async (name) =>
			JSON.parse(await readFile(path.join(directory, name), "utf8")),
		),
	);
	const manifest = createPrivateManifest(fragments, {
		repository: args.get("--repository"),
		sourceSha: args.get("--sha"),
		sourceRef: args.get("--ref"),
		workflowRef: args.get("--workflow-ref"),
		serverUrl: args.get("--server-url"),
	});
	await writeFile(
		args.get("--output"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
