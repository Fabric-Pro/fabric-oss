import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";
import {
	componentInputs,
	dockerignore,
	fingerprint,
	INPUTS_LABEL,
	inputFiles,
	MAX_REUSE_AGE_HOURS,
	parseDockerfile,
	parseTree,
	planSnapshots,
	rebuildEverything,
	reuseProvenance,
} from "./snapshot-reuse.mjs";

const NODE = `sha256:${"1".repeat(64)}`;
const FRONTEND = `sha256:${"2".repeat(64)}`;
const blob = (seed) => seed.repeat(40).slice(0, 40);
const entry = (path, object = blob("a"), mode = "100644", type = "blob") => ({
	mode,
	type,
	object,
	path,
});

const DOCKERFILE = `# syntax=docker/dockerfile:1
# escape=\\
FROM node:22-slim AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY --chown=node:node ["patches", "./patches"]
RUN --mount=type=cache,target=/root/.cache \\
    # a comment inside a continuation
    --mount=type=bind,source=tooling,target=/tooling \\

    pnpm install
RUN [ -f /app/package.json ]
RUN <<EOF
COPY not-an-instruction ./
EOF
FROM base AS builder
COPY packages ./packages
COPY ./agents/langchain/example/ ./agents/langchain/example
FROM --platform=linux/amd64 node:22-slim AS production
COPY --from=builder /app/dist ./dist
COPY --from=ghcr.io/example/tool@sha256:${"3".repeat(64)} /bin/tool /bin/tool
COPY LICENSE NOTICE ./
`;

test("reads every context path and external image a Dockerfile uses", () => {
	assert.deepEqual(parseDockerfile(DOCKERFILE), {
		images: [
			"docker/dockerfile:1",
			`ghcr.io/example/tool@sha256:${"3".repeat(64)}`,
			"node:22-slim",
		],
		sources: [
			"LICENSE",
			"NOTICE",
			"agents/langchain/example",
			"package.json",
			"packages",
			"patches",
			"pnpm-lock.yaml",
			"tooling",
		],
	});
});

test("a bind mount without a source reads the whole context", () => {
	const parsed = parseDockerfile(
		"FROM node:22-slim\nRUN --mount=target=/src make\n",
	);
	assert.deepEqual(parsed.sources, ["."]);
});

test("constructs whose inputs cannot be known disable reuse", () => {
	for (const text of [
		"ARG BASE=node:22\nFROM $BASE\n",
		"FROM node:22-slim\nADD https://example.com/tool.tgz /tool.tgz\n",
		"FROM node:22-slim\nCOPY ../outside ./\n",
		"FROM node:22-slim\nCOPY $SOURCE ./\n",
		"FROM node:22-slim\nONBUILD COPY . .\n",
		'FROM node:22-slim\nCOPY ["broken", \n',
		"FROM node:22-slim\nRUN <<EOF\nnever closed\n",
	]) {
		assert.throws(() => parseDockerfile(text), { name: "Error" }, text);
	}
});

test("a context path selects its files and everything beneath it, never a sibling prefix", () => {
	const tree = [
		entry("packages/api/src/index.ts"),
		entry("packages-extra/x.ts"),
		entry("apps/web/page.tsx"),
		entry("Dockerfile"),
		entry("packages/a.json"),
		entry("packages/b/c.json"),
	];
	const paths = (sources) =>
		inputFiles(tree, "Dockerfile", sources).map(({ path }) => path);
	assert.deepEqual(paths(["packages"]), [
		"Dockerfile",
		"packages/a.json",
		"packages/api/src/index.ts",
		"packages/b/c.json",
	]);
	// Wildcards may only widen the selection.
	assert.deepEqual(paths(["packages/*.json"]), [
		"Dockerfile",
		"packages/a.json",
		"packages/b/c.json",
	]);
	assert.equal(paths(["."]).length, tree.length);
});

test("submodules and symbolic-link context roots disable reuse", () => {
	const commit = entry("vendor/lib", blob("c"), "160000", "commit");
	assert.throws(() =>
		inputFiles([entry("Dockerfile"), commit], "Dockerfile", ["vendor"]),
	);
	const link = entry("tooling", blob("d"), "120000");
	assert.throws(() =>
		inputFiles([entry("Dockerfile"), link], "Dockerfile", ["tooling"]),
	);
	assert.doesNotThrow(() =>
		inputFiles(
			[entry("Dockerfile"), entry("tooling/link", blob("d"), "120000")],
			"Dockerfile",
			["tooling"],
		),
	);
});

test("ignore patterns match a path or its parents as Docker's context filter does", () => {
	const cases = [
		// A pattern is anchored at the context root; only `**` crosses `/`.
		["*.md", "README.md", true],
		["*.md", "docs/guide.md", false],
		["**/*.md", "docs/guide.md", true],
		["**/*.md", "README.md", true],
		["*.test.ts", "packages/a/x.test.ts", false],
		["**/*.test.ts", "packages/a/x.test.ts", true],
		["?.ts", "a.ts", true],
		["?.ts", "ab.ts", false],
		// A matched directory excludes everything beneath it.
		["docs/", "docs/a/b.ts", true],
		["docs/", "packages/docs/b.ts", false],
		["**/__tests__/", "packages/a/__tests__/b.ts", true],
		["**/__tests__/", "__tests__/b.ts", true],
		["**/tests", "packages/tests2/b.ts", false],
		["/scripts", "scripts/run.sh", true],
		["./tooling//x", "tooling/x/y", true],
		["a/**", "a/b/c", true],
		["a/**", "a", false],
		["a/**", "ab/c", false],
		["a/**/b", "a/b", true],
		["a/**/b", "a/x/y/b/c", true],
		["a/**/b", "a/xb", false],
		["**", "anything/at/all", true],
		// Regular-expression characters are literal.
		["a+b(c).ts", "a+b(c).ts", true],
		["a+b(c).ts", "aab(c).ts", false],
		["a.ts", "abts", false],
		// Only a line that starts with `#` is a comment.
		["# note", "# note", false],
		["  # note", "# note", true],
	];
	for (const [pattern, path, expected] of cases) {
		assert.equal(
			dockerignore(pattern)(path),
			expected,
			`${pattern} ${path}`,
		);
	}
	const byteOrderMark = String.fromCharCode(0xfeff);
	const file = dockerignore(`${byteOrderMark}*.log\r\n\r\ndist/\r\n`);
	assert.ok(file("a.log"));
	assert.ok(file("dist/x.js"));
	assert.ok(!file("src/a.ts"));
});

test("ignore patterns this module cannot evaluate exactly never exclude a path", () => {
	// An unevaluated exclusion excludes nothing; the others still apply.
	for (const pattern of [
		"[ab].ts",
		"a\\*.ts",
		"x/../a.ts",
		"a**.ts",
		"^a.ts",
	]) {
		const ignored = dockerignore(`${pattern}\n*.log`);
		assert.ok(!ignored("a.ts"), pattern);
		assert.ok(!ignored("a**.ts"), pattern);
		assert.ok(ignored("x.log"), pattern);
	}
	// An exception keeps its path even where a later line excludes it again.
	const reExcluded = dockerignore("*.md\n!README.md\nREADME.md");
	assert.ok(!reExcluded("README.md"));
	assert.ok(reExcluded("CHANGES.md"));
	const exception = dockerignore("docs/\n!docs/keep.md");
	assert.ok(!exception("docs/keep.md"));
	assert.ok(exception("docs/other.md"));
	// An exception that cannot be evaluated keeps every path.
	for (const text of ["docs/\n![k]eep.md", "docs/\n!", "docs/\n!a\\b"]) {
		assert.ok(!dockerignore(text)("docs/other.md"), text);
	}
});

test("the repository's .dockerignore excludes only what Docker leaves out", () => {
	const ignored = dockerignore(
		readFileSync(
			new URL("../../../.dockerignore", import.meta.url),
			"utf8",
		),
	);
	for (const path of [
		"packages/temporal/src/__tests__/schedule.test.ts",
		"packages/ai/src/model.test.ts",
		"packages/ai/vitest.config.ts",
		"packages/ai/dist/index.js",
		"packages/ai/tests/fixture.json",
		"CHANGES.md",
		// CI-only tooling must not enter image fingerprints.
		"tooling/jev-pr-review/main.mjs",
		"tooling/identifier-guard/terms-sync.mjs",
		"tooling/some-future-ci-tool/run.mjs",
	]) {
		assert.ok(ignored(path), path);
	}
	for (const path of [
		"packages/temporal/src/workflows/schedule.ts",
		"packages/ai/package.json",
		// `*.md` matches only at the context root, so Docker copies these.
		"packages/ai/README.md",
		"agents/langchain/data-analyst/docs/guide.md",
		// Exceptions for files the images ship.
		"THIRD_PARTY_NOTICES.md",
		"README.md",
		// Tooling the images install or read.
		"tooling/typescript/package.json",
		"tooling/tsgo/package.json",
		"tooling/scripts/package.json",
		"tooling/tailwind/package.json",
		"tooling/tsdown/no-declaration-map-comments.mjs",
	]) {
		assert.ok(!ignored(path), path);
	}
});

test("parses NUL-separated ls-tree records, including names with spaces", () => {
	const output = [
		`100644 blob ${blob("a")}\tpackages/a b.ts`,
		`160000 commit ${blob("b")}\tvendor/lib`,
		"",
	].join("\u0000");
	assert.deepEqual(parseTree(output), [
		entry("packages/a b.ts", blob("a")),
		entry("vendor/lib", blob("b"), "160000", "commit"),
	]);
	assert.throws(() => parseTree("garbage\0"));
});

test("the fingerprint follows inputs and nothing else", () => {
	const tree = [
		entry("Dockerfile", blob("1")),
		entry("packages/a.ts", blob("2")),
		entry("apps/web/x.ts", blob("3")),
	];
	const inputs = (files, images = { "node:22-slim": NODE }) =>
		fingerprint({
			dockerfile: "Dockerfile",
			files: inputFiles(files, "Dockerfile", ["packages"]),
			images,
		});
	const base = inputs(tree);
	assert.match(base, /^sha256:[0-9a-f]{64}$/);
	assert.equal(
		inputs([...tree.slice(0, 2), entry("apps/web/x.ts", blob("9"))]),
		base,
	);
	assert.notEqual(
		inputs([tree[0], entry("packages/a.ts", blob("9")), tree[2]]),
		base,
	);
	assert.notEqual(
		inputs([entry("Dockerfile", blob("9")), ...tree.slice(1)]),
		base,
	);
	assert.notEqual(
		inputs([tree[0], entry("packages/a.ts", blob("2"), "100755"), tree[2]]),
		base,
	);
	assert.notEqual(inputs(tree, { "node:22-slim": FRONTEND }), base);
	assert.notEqual(
		inputs([
			...tree,
			entry(".github/workflows/private-staging-images.yml"),
		]),
		base,
	);
});

test("an unresolved image or an unsupported Dockerfile rebuilds only that component", () => {
	const dockerfiles = new Map(
		SNAPSHOT_IMAGES.map(({ dockerfile }) => [
			dockerfile,
			"FROM node:22-slim\nCOPY packages ./packages\n",
		]),
	);
	dockerfiles.set(SNAPSHOT_IMAGES[1].dockerfile, "ARG BASE\nFROM $BASE\n");
	const tree = [...dockerfiles.keys()]
		.map((path) => entry(path))
		.concat(entry("packages/a.ts"));
	const read = (path) => dockerfiles.get(path);
	const resolved = componentInputs(tree, read, { "node:22-slim": NODE });
	assert.equal(resolved.length, SNAPSHOT_IMAGES.length);
	assert.match(resolved[0].inputs, /^sha256:/);
	assert.equal(resolved[1].inputs, "");
	assert.match(resolved[1].reason, /unresolvable image/);
	const unresolved = componentInputs(tree, read, {});
	assert.ok(
		unresolved.every(({ inputs, reason }) => inputs === "" && reason),
	);
});

test("every snapshot Dockerfile in this repository is reusable", () => {
	for (const { dockerfile } of SNAPSHOT_IMAGES) {
		const parsed = parseDockerfile(
			readFileSync(
				new URL(`../../../${dockerfile}`, import.meta.url),
				"utf8",
			),
		);
		assert.ok(parsed.images.includes("node:22-slim"), dockerfile);
		assert.ok(parsed.sources.length > 0, dockerfile);
	}
});

const NOW = Date.parse("2026-10-15T12:00:00Z");
const SHA = "b".repeat(40);
const BUILT = "c".repeat(40);
const INPUTS = `sha256:${"4".repeat(64)}`;
const DIGEST = `sha256:${"5".repeat(64)}`;
const component = {
	component: "weave-shuttle",
	dockerfile: "agents/langchain/weave-shuttle/Dockerfile",
	inputs: INPUTS,
};
const previousImage = (overrides = {}) => ({
	sourceSha: SHA,
	run: 42,
	images: {
		"weave-shuttle": {
			digest: DIGEST,
			created: "2026-10-15T09:00:00.123456789Z",
			labels: {
				[INPUTS_LABEL]: INPUTS,
				"org.opencontainers.image.revision": BUILT,
			},
			...overrides,
		},
	},
});

test("reuses an unchanged component from the previous complete snapshot", () => {
	assert.deepEqual(planSnapshots([component], previousImage(), NOW), {
		build: [],
		reuse: [
			{
				...component,
				digest: DIGEST,
				reusedSourceSha: SHA,
				reusedRun: "42",
				builtSourceSha: BUILT,
			},
		],
	});
});

test("files the ignore file excludes are not inputs: changing only them reuses, changing a source rebuilds", () => {
	const TESTS = "packages/a/src/__tests__/index.test.ts";
	const README = "packages/a/README.md";
	const SPECIFIC = `${SNAPSHOT_IMAGES[0].dockerfile}.dockerignore`;
	const base = [
		...SNAPSHOT_IMAGES.map(({ dockerfile }) => entry(dockerfile)),
		entry(".dockerignore", blob("1")),
		entry("packages/a/src/index.ts", blob("2")),
		entry(TESTS, blob("3")),
		entry(README, blob("4")),
	];
	const edit = (tree, ...paths) =>
		tree.map((item) =>
			paths.includes(item.path) ? { ...item, object: blob("9") } : item,
		);
	// The first component's inputs with these ignore-file contents.
	const inputsOf = (tree, ignoreFiles) =>
		componentInputs(
			tree,
			(path) =>
				ignoreFiles[path] ??
				"FROM node:22-slim\nCOPY packages ./packages\n",
			{ "node:22-slim": NODE },
		)[0];
	const ignoreTestsAndDocs = { ".dockerignore": "**/__tests__/\n**/*.md\n" };
	const atBase = inputsOf(base, ignoreTestsAndDocs);
	const previous = {
		sourceSha: SHA,
		run: 42,
		images: {
			[atBase.component]: {
				digest: DIGEST,
				created: "2026-10-15T09:00:00Z",
				labels: {
					[INPUTS_LABEL]: atBase.inputs,
					"org.opencontainers.image.revision": BUILT,
				},
			},
		},
	};

	const testsAndDocs = inputsOf(
		edit(base, TESTS, README),
		ignoreTestsAndDocs,
	);
	assert.equal(testsAndDocs.inputs, atBase.inputs);
	assert.equal(planSnapshots([testsAndDocs], previous, NOW).reuse.length, 1);

	const source = inputsOf(
		edit(base, "packages/a/src/index.ts"),
		ignoreTestsAndDocs,
	);
	assert.notEqual(source.inputs, atBase.inputs);
	assert.match(
		planSnapshots([source], previous, NOW).build[0].reason,
		/inputs changed/,
	);

	// An exception keeps a file Docker would copy as an input.
	const keepReadme = {
		".dockerignore": "**/__tests__/\n**/*.md\n!packages/a/README.md\n",
	};
	assert.notEqual(
		inputsOf(edit(base, TESTS, README), keepReadme).inputs,
		inputsOf(base, keepReadme).inputs,
	);

	// With a Dockerfile-specific ignore file too, a path is left out only when
	// both files exclude it.
	const specific = [...base, entry(SPECIFIC, blob("5"))];
	const both = { ...ignoreTestsAndDocs, [SPECIFIC]: "**/__tests__/\n" };
	assert.equal(
		inputsOf(edit(specific, TESTS), both).inputs,
		inputsOf(specific, both).inputs,
	);
	assert.notEqual(
		inputsOf(edit(specific, README), both).inputs,
		inputsOf(specific, both).inputs,
	);

	// Without an ignore file, or with one that is a symbolic link, every
	// selected file stays an input.
	for (const tree of [
		base.filter((item) => item.path !== ".dockerignore"),
		base.map((item) =>
			item.path === ".dockerignore" ? { ...item, mode: "120000" } : item,
		),
	]) {
		assert.notEqual(
			inputsOf(edit(tree, README), ignoreTestsAndDocs).inputs,
			inputsOf(tree, ignoreTestsAndDocs).inputs,
		);
	}
});

test("promotion and recovery builds rebuild every component without an inputs label", () => {
	const plan = rebuildEverything();
	assert.deepEqual(plan.reuse, []);
	assert.deepEqual(
		plan.build.map(({ component, dockerfile, inputs }) => ({
			component,
			dockerfile,
			inputs,
		})),
		SNAPSHOT_IMAGES.map(({ component, dockerfile }) => ({
			component,
			dockerfile,
			inputs: "",
		})),
	);
});

test("rebuilds whenever reuse cannot be shown to be safe", () => {
	const cases = [
		[{}, "no previous complete staging snapshot"],
		[
			{ ...previousImage(), run: "" },
			"no previous complete staging snapshot",
		],
		[{ ...previousImage(), images: {} }, "not found"],
		[previousImage({ digest: "sha256:short" }), "malformed"],
		[
			previousImage({
				labels: { "org.opencontainers.image.revision": BUILT },
			}),
			"inputs changed",
		],
		[
			previousImage({
				labels: {
					[INPUTS_LABEL]: `sha256:${"6".repeat(64)}`,
					"org.opencontainers.image.revision": BUILT,
				},
			}),
			"inputs changed",
		],
		[previousImage({ labels: { [INPUTS_LABEL]: INPUTS } }), "revision"],
		[
			previousImage({
				created: new Date(
					NOW - MAX_REUSE_AGE_HOURS * 3_600_000,
				).toISOString(),
			}),
			"hours",
		],
		[previousImage({ created: "2026-10-15T14:00:00Z" }), "hours"],
		[previousImage({ created: "not a date" }), "hours"],
	];
	for (const [previous, reason] of cases) {
		const plan = planSnapshots([component], previous, NOW);
		assert.equal(plan.reuse.length, 0, reason);
		assert.match(plan.build[0].reason, new RegExp(reason));
	}
	const unsupported = planSnapshots(
		[{ ...component, inputs: "", reason: "unresolvable image $BASE" }],
		previousImage(),
		NOW,
	);
	assert.match(unsupported.build[0].reason, /unresolvable/);
	const unlabeled = planSnapshots(
		[{ ...component, inputs: "" }],
		previousImage({
			labels: {
				[INPUTS_LABEL]: "",
				"org.opencontainers.image.revision": BUILT,
			},
		}),
		NOW,
	);
	assert.match(
		unlabeled.build[0].reason,
		/unknown/,
		"an empty fingerprint never matches an empty label",
	);
});

test("reuse provenance records the run and the reused snapshot it vouches for", () => {
	const context = {
		serverUrl: "https://github.com",
		repository: "Fabric-Pro/fabric-dev",
		ref: "refs/heads/staging",
		sha: "a".repeat(40),
		workflowPath: ".github/workflows/private-staging-images.yml",
		workflowRef:
			"Fabric-Pro/fabric-dev/.github/workflows/private-staging-images.yml@refs/heads/staging",
		runId: "7",
		runAttempt: "1",
		eventName: "push",
		repositoryId: "1",
		repositoryOwnerId: "2",
		runnerEnvironment: "github-hosted",
	};
	const reused = {
		image: "ghcr.io/fabric-pro/fabric-dev-snapshots/weave-shuttle",
		digest: DIGEST,
		inputs: INPUTS,
		reusedSourceSha: SHA,
		reusedRun: "42",
		builtSourceSha: BUILT,
	};
	const predicate = reuseProvenance(context, reused);
	assert.equal(
		predicate.buildDefinition.buildType,
		"https://actions.github.io/buildtypes/workflow/v1",
	);
	assert.deepEqual(predicate.buildDefinition.resolvedDependencies, [
		{
			uri: "git+https://github.com/Fabric-Pro/fabric-dev@refs/heads/staging",
			digest: { gitCommit: "a".repeat(40) },
		},
		{
			uri: "oci://ghcr.io/fabric-pro/fabric-dev-snapshots/weave-shuttle",
			digest: { sha256: "5".repeat(64) },
			annotations: {
				reusedFromSourceSha: SHA,
				reusedFromRun:
					"https://github.com/Fabric-Pro/fabric-dev/actions/runs/42",
				builtFromSourceSha: BUILT,
				inputs: INPUTS,
			},
		},
	]);
	assert.equal(
		predicate.runDetails.builder.id,
		"https://github.com/Fabric-Pro/fabric-dev/.github/workflows/private-staging-images.yml@refs/heads/staging",
	);
	assert.equal(
		predicate.runDetails.metadata.invocationId,
		"https://github.com/Fabric-Pro/fabric-dev/actions/runs/7/attempts/1",
	);
	assert.throws(() => reuseProvenance({ ...context, sha: "main" }, reused));
	assert.throws(() =>
		reuseProvenance(context, { ...reused, builtSourceSha: "" }),
	);
	assert.throws(() =>
		reuseProvenance(context, { ...reused, digest: "sha256:short" }),
	);
});
