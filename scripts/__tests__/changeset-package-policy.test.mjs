import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkStatusFile } from "../lib/changeset-package-policy.mjs";

const sdk = JSON.parse(
	readFileSync(
		new URL("./fixtures/changeset-sdk-status.json", import.meta.url),
		"utf8",
	),
);
function check(
	t,
	status,
	packages = [],
	workspace = "packages:\n  - packages/*\n  - apps/*\n  - packages/*/*\n  - agents/*/*\n  - tooling/*\n",
) {
	const root = mkdtempSync(join(tmpdir(), "package-policy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "pnpm-workspace.yaml"), workspace);
	for (const [name, dir, privateValue] of packages) {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(
			join(root, dir, "package.json"),
			JSON.stringify({ name, private: privateValue }),
		);
	}
	const file = join(root, "status.json");
	if (status !== undefined) {
		writeFileSync(
			file,
			typeof status === "string" ? status : JSON.stringify(status),
		);
	}
	return checkStatusFile(file, root);
}
const status = (name, releases = [name]) => ({
	changesets: [{ id: "example-change", releases: [{ name, type: "patch" }] }],
	releases: releases.map((name) => ({ name, type: "patch" })),
});
test("real SDK status permits internal cascades in supported directories", (t) => {
	assert.deepEqual(
		check(
			t,
			sdk,
			sdk.releases.map((r, i) => [
				r.name,
				r.name === "@repo/web" ? "apps/web" : `packages/example-${i}`,
			]),
		),
		[],
	);
});
test("fabric-app is permitted despite being private", (t) =>
	assert.deepEqual(
		check(t, status("fabric-app"), [
			["fabric-app", "packages/fabric-app", true],
		]),
		[],
	));
test("direct internal name fails alone with changeset id and remedy", (t) => {
	const errors = check(t, status("@repo/database"), [
		["@repo/database", "packages/database", false],
	]).join("\n");
	assert.match(errors, /example-change.*@repo\/database/);
	assert.match(errors, /fabric-app.*patch/);
});
test("private published-scope package fails", (t) =>
	assert.match(
		check(t, status("@fabricorg/mcp-server"), [
			["@fabricorg/mcp-server", "packages/mcp-server", true],
		]).join(),
		/Direct/,
	));
for (const dir of [
	"agents/example/agent",
	"tooling/example",
	"packages/example/nested",
]) {
	test(`cascade fails alone: ${dir}`, (t) => {
		assert.match(
			check(t, status("fabric-app", ["fabric-app", "example-agent"]), [
				["fabric-app", "packages/fabric-app", true],
				["example-agent", dir],
			]).join(),
			/Cascade.*example-agent/,
		);
	});
}
test("missing workspace release fails closed", (t) =>
	assert.match(
		check(t, status("fabric-app", ["missing-package"]), [
			["fabric-app", "packages/fabric-app"],
		]).join(),
		/could not check.*missing-package/,
	));
for (const value of [
	undefined,
	"{bad",
	{},
	{ changesets: [], releases: [null] },
	{ changesets: [{}], releases: [] },
]) {
	test(`invalid evidence: ${JSON.stringify(value)}`, (t) =>
		assert.match(check(t, value).join(), /could not check/));
}

test("lists all direct and cascaded offenders", (t) => {
	const input = status("@repo/database", ["example-agent", "example-tool"]);
	input.changesets.push({
		id: "second-change",
		releases: [{ name: "@fabricorg/mcp-server", type: "patch" }],
	});
	const errors = check(t, input, [
		["@repo/database", "packages/database"],
		["@fabricorg/mcp-server", "packages/mcp-server", true],
		["example-agent", "agents/example/agent"],
		["example-tool", "tooling/example"],
	]);
	assert.equal(errors.length, 4);
	for (const name of [
		"example-change",
		"second-change",
		"example-agent",
		"example-tool",
	]) {
		assert.ok(errors.some((error) => error.includes(name)));
	}
});
test("unreadable status evidence fails closed", (t) => {
	const root = mkdtempSync(join(tmpdir(), "unreadable-policy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.match(checkStatusFile(root, root).join(), /could not check/);
});

test("workspace globs ignore build directories and node_modules", (t) => {
	assert.deepEqual(
		check(t, status("fabric-app"), [
			["fabric-app", "packages/fabric-app", true],
			["fabric-app", "packages/node_modules"],
			["fabric-app", "packages/.next"],
		]),
		[],
	);
});

test("quoted positive workspace patterns discover packages", (t) => {
	assert.deepEqual(
		check(
			t,
			status("fabric-app"),
			[["fabric-app", "packages/fabric-app"]],
			'packages:\n  - "packages/*"\n',
		),
		[],
	);
});
test("quoted negation excludes manifests at the root and below it", (t) => {
	assert.deepEqual(
		check(
			t,
			status("fabric-app"),
			[
				["fabric-app", "packages/fabric-app"],
				["fabric-app", "agents/langchain/cuga"],
				["fabric-app", "agents/langchain/cuga/nested"],
			],
			'packages:\n  - packages/*\n  - agents/*/*\n  - agents/*/*/*\n  - "!agents/langchain/cuga/**"\n',
		),
		[],
	);
});
for (const [name, workspace, packages, diagnostic] of [
	[
		"unsupported pattern",
		"packages:\n  - packages/{one,two}\n",
		[],
		/unsupported workspace pattern/,
	],
	[
		"missing packages section",
		"catalog:\n  example: 1\n",
		[],
		/workspace package patterns are missing/,
	],
	[
		"duplicate package",
		"packages:\n  - packages/*\n",
		[
			["example", "packages/one"],
			["example", "packages/two"],
		],
		/duplicate package: example/,
	],
	[
		"missing package name",
		"packages:\n  - packages/*\n",
		[[undefined, "packages/unnamed"]],
		/package name missing: packages\/unnamed/,
	],
	[
		"positive recursive glob",
		"packages:\n  - packages/**\n",
		[["example", "packages/example"]],
		/positive recursive workspace globs are unsupported/,
	],
]) {
	test(`workspace parser rejects ${name}`, (t) => {
		const errors = check(
			t,
			{ changesets: [], releases: [] },
			packages,
			workspace,
		);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /could not check/);
		assert.match(errors[0], diagnostic);
	});
}
