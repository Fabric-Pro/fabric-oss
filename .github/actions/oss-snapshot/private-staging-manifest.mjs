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
	return createAggregateManifest(fragments, expected, POLICY);
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
