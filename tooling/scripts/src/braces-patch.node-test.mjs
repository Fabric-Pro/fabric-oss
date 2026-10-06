import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const patchPath = "patches/braces@3.0.3.patch";
// biome-ignore lint/suspicious/noTemplateCurlyInString: This intentionally tests a literal dollar-brace pattern.
const dollarBracePattern = "${a,b}";
// Pin the reviewed bytes as well as pnpm's generated lockfile hash. Changing
// the security patch requires reviewing and updating this regression contract.
const patchHash =
	"8b35ecd5f79ae60312b3f2470d458c7f00c870a6e9a450a068654745c435a195";

function verifyMetadata(workspace, lockfile, patch) {
	assert.ok(
		/^patchedDependencies:\n(?: {2}[^\n]*\n)* {2}['"]?braces@3\.0\.3['"]?: patches\/braces@3\.0\.3\.patch$/m.test(
			workspace,
		),
		"Register the reviewed exact-version braces patch in pnpm-workspace.yaml",
	);
	assert.equal(createHash("sha256").update(patch).digest("hex"), patchHash);
	assert.ok(
		new RegExp(
			`^patchedDependencies:\\n(?: {2}[^\\n]*\\n)*  braces@3\\.0\\.3: ${patchHash}$`,
			"m",
		).test(lockfile),
		"The lockfile must record the reviewed patch hash",
	);
	for (const consumer of ["chokidar@3.6.0", "micromatch@4.0.8"]) {
		assert.ok(
			new RegExp(
				`^  ${consumer.replaceAll(".", "\\.")}:\\n    dependencies:\\n(?:      .*\\n)*?      braces: 3\\.0\\.3\\(patch_hash=${patchHash}\\)$`,
				"m",
			).test(lockfile),
			`${consumer} must resolve the reviewed patch`,
		);
	}
	for (const reference of lockfile.matchAll(/^ {6}braces: (.+)$/gm)) {
		assert.equal(reference[1], `3.0.3(patch_hash=${patchHash})`);
	}
}

function installedConsumer(name, version) {
	const store = join(root, "node_modules/.pnpm");
	const entry = readdirSync(store).find(
		(value) =>
			value === `${name}@${version}` ||
			value.startsWith(`${name}@${version}(`),
	);
	assert.ok(
		entry,
		`Missing installed ${name}@${version}; run pnpm install --frozen-lockfile`,
	);
	return createRequire(
		join(store, entry, "node_modules", name, "package.json"),
	);
}

function ast(depth) {
	let node = { type: "text", value: "x" };
	for (let i = 0; i < depth; i++) {
		node = { type: "paren", nodes: [node] };
	}
	return { type: "root", nodes: [node] };
}

function rejectsDepth(call, errorType) {
	assert.throws(
		call,
		(error) =>
			error instanceof errorType &&
			/exceeds max depth \(100\)/.test(error.message),
	);
}

test("reviewed braces patch is registered and locked for both consumers", () => {
	const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	const patch = readFileSync(join(root, patchPath));
	verifyMetadata(workspace, lockfile, patch);
	assert.throws(() =>
		verifyMetadata(
			workspace.replace(
				"  braces@3.0.3: patches/braces@3.0.3.patch",
				"removed:\n  braces@3.0.3: patches/braces@3.0.3.patch",
			),
			lockfile,
			patch,
		),
	);
	assert.throws(() =>
		verifyMetadata(
			workspace,
			lockfile.replace(
				`  braces@3.0.3: ${patchHash}`,
				`removed:\n  braces@3.0.3: ${patchHash}`,
			),
			patch,
		),
	);
	assert.throws(() =>
		verifyMetadata(
			workspace,
			lockfile.replace(
				`braces: 3.0.3(patch_hash=${patchHash})`,
				"braces: 3.0.3",
			),
			patch,
		),
	);
	assert.throws(() =>
		verifyMetadata(
			workspace.replace("patchedDependencies:", "removed:"),
			lockfile,
			patch,
		),
	);
	assert.throws(() =>
		verifyMetadata(
			workspace,
			lockfile.replaceAll(patchHash, "removed"),
			patch,
		),
	);
	assert.throws(() =>
		verifyMetadata(
			workspace,
			lockfile,
			Buffer.concat([patch, Buffer.from("changed")]),
		),
	);
});

for (const [name, version] of [
	["chokidar", "3.6.0"],
	["micromatch", "4.0.8"],
]) {
	for (const method of ["compile", "expand", "stringify"]) {
		test(`${name}: ${method} rejects excessive string and AST depth with bounded errors`, () => {
			const braces = installedConsumer(name, version)("braces");
			for (const options of [
				{},
				{ maxDepth: Number.POSITIVE_INFINITY },
				{ maxDepth: Number.NaN },
				{ maxDepth: 10000 },
				{ maxDepth: "10000" },
			]) {
				for (const pattern of [
					`${"{".repeat(101)}x${"}".repeat(101)}`,
					`${"(".repeat(101)}x${")".repeat(101)}`,
					`${"{(".repeat(51)}x${")}".repeat(51)}`,
				]) {
					rejectsDepth(
						() => braces[method](pattern, options),
						SyntaxError,
					);
				}
				rejectsDepth(
					() => braces[method](ast(101), options),
					RangeError,
				);
				assert.doesNotThrow(() => braces[method](ast(100), options));
				rejectsDepth(
					() => braces[method](ast(101).nodes[0], options),
					RangeError,
				);
			}
			assert.throws(
				() => braces[method]("{{x}}", { maxDepth: 1 }),
				/exceeds max depth \(1\)/,
			);
			// The original stack-exhaustion class fits below MAX_LENGTH (10000).
			rejectsDepth(
				() => braces[method](`${"{".repeat(4000)}x${"}".repeat(4000)}`),
				SyntaxError,
			);
			rejectsDepth(() => braces[method](ast(5000)), RangeError);
		});
	}
	test(`${name}: ordinary brace behavior and parser boundary remain intact`, () => {
		const braces = installedConsumer(name, version)("braces");
		assert.equal(
			braces.compile("src/{a,b}/{1..3}.ts"),
			"src/(a|b)/([1-3]).ts",
		);
		assert.deepEqual(braces.expand("src/{a,b}/{1..3}.ts"), [
			"src/a/1.ts",
			"src/a/2.ts",
			"src/a/3.ts",
			"src/b/1.ts",
			"src/b/2.ts",
			"src/b/3.ts",
		]);
		assert.deepEqual(braces.expand("{a,{b,c}}"), ["a", "b", "c"]);
		assert.deepEqual(braces.expand("literal\\{a,b\\}"), ["literal{a,b}"]);
		assert.deepEqual(
			braces.expand("{a,a,}", { nodupes: true, noempty: true }),
			["a"],
		);
		assert.equal(
			braces.stringify(braces.parse("src/{a,b}.ts")),
			"src/{a,b}.ts",
		);
		assert.equal(braces.stringify("{a}", { escapeInvalid: true }), "{a}");
		assert.deepEqual(
			braces.expand(dollarBracePattern, { escapeInvalid: true }),
			[dollarBracePattern],
		);
		assert.doesNotThrow(() =>
			braces.parse(`${"{".repeat(100)}x${"}".repeat(100)}`),
		);
		rejectsDepth(() => braces.parse(`${"{".repeat(101)}x`), SyntaxError);
		assert.throws(
			() => braces.parse("x".repeat(10001)),
			/exceeds max characters/,
		);
		assert.throws(() => braces.expand("{1..1001}"), /range limit/);
	});
}

test("micromatch uses the patched braces resolution", () => {
	const mm = installedConsumer("micromatch", "4.0.8")("micromatch");
	assert.deepEqual(mm.braceExpand("src/{a,b}.ts"), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(
		mm.braceExpand(dollarBracePattern, { escapeInvalid: true }),
		[dollarBracePattern],
	);
	rejectsDepth(
		() => mm.braceExpand(`${"{".repeat(101)}a,b${"}".repeat(101)}`),
		SyntaxError,
	);
	rejectsDepth(
		() => mm.parse(`${"{".repeat(101)}a,b${"}".repeat(101)}`),
		SyntaxError,
	);
});

function verifyDockerfile(source, path) {
	const stages = new Map();
	let hasPatches = false;
	let stageName;
	for (const line of source.replace(/\\\n\s*/g, " ").split("\n")) {
		const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
		if (from) {
			hasPatches = stages.get(from[1]) === true;
			stageName = from[2];
		}
		const copy =
			/^COPY\s+(?:--from=(\S+)\s+)?(?:\/app\/)?patches\s+\.\/patches\/?\s*$/i.exec(
				line,
			);
		if (copy) {
			assert.ok(
				!copy[1] || stages.get(copy[1]),
				`${path}: patch source stage must contain patches`,
			);
			hasPatches = true;
		}
		if (/^RUN\s.*\bpnpm\s+(?:install|fetch)\b/.test(line)) {
			assert.ok(
				hasPatches,
				`${path}: copy patches before pnpm install/fetch in every stage`,
			);
		}
		if (stageName) {
			stages.set(stageName, hasPatches);
		}
	}
}

function dockerfiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (
			entry.name.startsWith(".") ||
			["node_modules", "__fixtures__"].includes(entry.name)
		) {
			return [];
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return dockerfiles(path);
		}
		return entry.isFile() && entry.name.startsWith("Dockerfile")
			? [path]
			: [];
	});
}

test("all Docker pnpm install stages receive the reviewed patch", () => {
	const files = dockerfiles(root);
	assert.ok(files.length > 0);
	for (const path of files) {
		verifyDockerfile(readFileSync(path, "utf8"), path);
	}
	const fixture =
		"FROM node:22 AS builder\nCOPY patches ./patches\nRUN pnpm install\nFROM node:22 AS runtime\nCOPY --from=builder /app/patches ./patches\nRUN pnpm install --prod\n";
	verifyDockerfile(fixture, "fixture");
	assert.throws(() =>
		verifyDockerfile(
			fixture.replace("COPY patches ./patches\n", ""),
			"fixture",
		),
	);
	assert.throws(() =>
		verifyDockerfile(
			fixture.replace("COPY --from=builder /app/patches ./patches\n", ""),
			"fixture",
		),
	);
});
