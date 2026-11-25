import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	installedConsumers,
	installedDependency,
} from "./installed-consumers.mjs";
import {
	addPackage,
	assertRejectsMalformed,
	entriesNamed,
	isStableOutside,
	mutableCopy,
	readLockfile,
	referencesTo,
	requireLockfile,
	semver,
	validateLockfile,
} from "./lockfile-shape.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const webRequire = createRequire(join(root, "apps/web/package.json"));
const aguiPatchPath = "patches/@ag-ui__core@1.0.2.patch";
const aguiPatchHash =
	"153de2e00fea90a9c5f72a661e584c87c49fcd96634ffb4d97aafac580e95bf6";

function verifyAguiPatch(workspace, lockfile, patch) {
	assert.equal(
		createHash("sha256").update(patch).digest("hex"),
		aguiPatchHash,
	);
	assert.equal(
		workspace.patchedDependencies["@ag-ui/core@1.0.2"],
		aguiPatchPath,
	);
	assert.equal(
		workspace.packageExtensions["@ag-ui/core@1.0.2"].dependencies[
			"zod-agui-runtime"
		],
		"npm:zod@4.6.7",
	);
	requireLockfile(lockfile);
	assert.equal(
		lockfile.patchedDependencies["@ag-ui/core@1.0.2"],
		aguiPatchHash,
	);
	const patched = `1.0.2(patch_hash=${aguiPatchHash})`;
	const snapshots = entriesNamed(lockfile, "snapshots", "@ag-ui/core");
	assert.ok(snapshots.length > 0);
	for (const { key } of snapshots) {
		assert.ok(
			key.startsWith(`@ag-ui/core@${patched}`),
			`Unpatched AG-UI: ${key}`,
		);
		const runtime = lockfile.references.filter(
			(reference) =>
				reference.section === "snapshots" &&
				reference.owner === key &&
				reference.group === "dependencies" &&
				reference.name === "zod-agui-runtime",
		);
		assert.deepEqual(
			runtime.map((reference) => reference.reference),
			["zod@4.6.7"],
			`AG-UI zod runtime alias: ${key}`,
		);
	}
	for (const reference of referencesTo(lockfile, "@ag-ui/core")) {
		assert.ok(
			reference.target?.name === "@ag-ui/core" &&
				reference.reference
					.replace("@ag-ui/core@", "")
					.startsWith(patched),
			`Unpatched AG-UI parent: ${reference.owner}`,
		);
	}
}

test("the exact AG-UI schema patch and isolated alias cover every peer island", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const workspace = yaml.parse(
		readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
	);
	const lockfile = readLockfile();
	const patch = readFileSync(join(root, aguiPatchPath));
	verifyAguiPatch(workspace, lockfile, patch);
	assert.throws(() =>
		verifyAguiPatch(
			workspace,
			lockfile,
			Buffer.concat([patch, Buffer.from("changed")]),
		),
	);
	const bad = mutableCopy(lockfile);
	bad.snapshots["@ag-ui/core@1.0.2(zod@3.25.76)"] = {};
	assert.throws(
		() => verifyAguiPatch(workspace, validateLockfile(bad), patch),
		/Unpatched AG-UI/,
	);
	const parent = addPackage(mutableCopy(lockfile), "example-parent@1.0.0", {
		dependencies: { "@ag-ui/core": "file:vendor/ag-ui" },
	});
	assert.throws(
		() => verifyAguiPatch(workspace, validateLockfile(parent), patch),
		/Unpatched AG-UI parent: example-parent@1\.0\.0/,
	);
	const runtime = mutableCopy(lockfile);
	const key = Object.keys(runtime.snapshots).find((name) =>
		name.startsWith("@ag-ui/core@"),
	);
	runtime.snapshots[key].dependencies["zod-agui-runtime"] = "zod@3.25.76";
	assert.throws(
		() => verifyAguiPatch(workspace, validateLockfile(runtime), patch),
		/AG-UI zod runtime alias/,
	);
	const unpatched = mutableCopy(lockfile);
	unpatched.patchedDependencies = {};
	assert.throws(() =>
		verifyAguiPatch(workspace, validateLockfile(unpatched), patch),
	);
	assertRejectsMalformed(
		(malformed) => verifyAguiPatch(workspace, malformed, patch),
		lockfile,
	);
});

test("mounted CopilotKit parsers use AG-UI's supported fixed Zod dependency while direct v3 stays isolated", async () => {
	const run = {
		threadId: "example-thread",
		runId: "example-run",
		messages: [{ id: "message-1", role: "user", content: "hello" }],
	};
	for (const runtime of [
		installedDependency(webRequire, "@copilotkit/runtime/v2"),
	]) {
		assert.equal(runtime.manifest.version, "1.80.0");
		assert.equal(
			installedDependency(runtime.require, "zod").manifest.version,
			"3.25.76",
		);
		const agui = installedDependency(
			runtime.require,
			"@ag-ui/core/schemas",
		);
		assert.equal(agui.manifest.version, "1.0.2");
		const zod = installedDependency(agui.require, "zod-agui-runtime/v4");
		assert.equal(zod.manifest.version, "4.6.7");
		assert.ok(
			semver.satisfies(
				zod.manifest.version,
				agui.manifest.peerDependencies.zod,
			),
		);
		for (const file of [
			"schemas.js",
			"schemas.mjs",
			"schemas.d.ts",
			"schemas.d.mts",
		]) {
			const source = readFileSync(
				join(dirname(agui.path), "dist", file),
				"utf8",
			);
			assert.ok(
				source.includes('"zod-agui-runtime/v4"'),
				`${file}: fixed schema dependency`,
			);
			assert.equal(
				source.includes('"zod/v4"'),
				false,
				`${file}: old bundled v4 import`,
			);
		}
		for (const { RunAgentInputSchema } of [
			runtime.require("@ag-ui/core/schemas"),
			await import(
				pathToFileURL(join(dirname(agui.path), "dist/schemas.mjs")).href
			),
		]) {
			assert.deepEqual(
				RunAgentInputSchema.parse(run).messages,
				run.messages,
			);
			assert.equal(
				RunAgentInputSchema.safeParse({ ...run, threadId: 1 }).success,
				false,
			);
			assert.equal(
				RunAgentInputSchema.safeParse({
					...run,
					messages: [{ role: "invalid" }],
				}).success,
				false,
			);
			// AG-UI arrays are uncapped; the transport bound remains necessary.
			const oversized = {
				...run,
				messages: [
					{
						...run.messages[0],
						content: "x".repeat(8 * 1024 * 1024),
					},
				],
			};
			assert.equal(
				RunAgentInputSchema.safeParse(oversized).success,
				true,
			);
		}
		const { z } = agui.require("zod-agui-runtime/v4");
		let parsed = 0;
		const capped = z
			.array(
				z.string().transform((value) => {
					parsed++;
					return value;
				}),
			)
			.max(1);
		assert.equal(capped.safeParse(["a", "b"]).success, false);
		assert.equal(
			parsed,
			0,
			"fixed Zod must reject capped arrays before parsing their elements",
		);
	}
});

test("both mounted endpoints retain the 8 MiB byte guard before SDK parsing", async () => {
	const { MAX_AGENT_REQUEST_BODY_BYTES, withBoundedAgentRequestBody } =
		await import(
			"../../../apps/web/modules/saas/agents/runtime/request-body.ts"
		);
	assert.equal(MAX_AGENT_REQUEST_BODY_BYTES, 8 * 1024 * 1024);
	for (const headers of [{}, { "content-length": "1" }]) {
		const request = new Request("https://example.test/agent", {
			method: "POST",
			headers,
			body: "x".repeat(MAX_AGENT_REQUEST_BODY_BYTES + 1),
		});
		const result = await withBoundedAgentRequestBody(request);
		assert.ok(result instanceof Response);
		assert.equal(result.status, 413);
	}
	const request = new Request("https://example.test/agent", {
		method: "POST",
		body: '{"messages":[]}',
	});
	const result = await withBoundedAgentRequestBody(request);
	assert.ok(result instanceof Request);
	assert.equal(await result.text(), '{"messages":[]}');
	for (const [route, parameter] of [
		["apps/web/app/api/copilotkit/route.ts", "req"],
		["apps/web/app/api/agents/runtime/[[...path]]/route.ts", "request"],
	]) {
		assert.ok(
			readFileSync(join(root, route), "utf8").includes(
				`await withBoundedAgentRequestBody(${parameter})`,
			),
			`${route}: retain the body guard`,
		);
	}
});

for (const [alias, version] of [
	["@ai-sdk/provider-utils-v6", "4.0.66"],
	["@ai-sdk/provider-utils-v7", "5.0.81"],
]) {
	test(`Mastra ${alias} retains JSON/SSE validation and bounded response handlers on its fixed API major`, async () => {
		for (const mastra of installedConsumers("@mastra/core", "1.85.0")) {
			const dependency = installedDependency(mastra.require, alias);
			assert.equal(dependency.manifest.name, "@ai-sdk/provider-utils");
			assert.equal(dependency.manifest.version, version);
			const declared = mastra.manifest.dependencies[alias];
			assert.ok(
				declared.startsWith(
					`npm:@ai-sdk/provider-utils@${version[0]}.`,
				),
			);
			const entrypoints = dependency.manifest.exports["."];
			const esm = await import(
				pathToFileURL(
					join(dirname(dependency.path), entrypoints.import),
				).href
			);
			const implementations = entrypoints.require
				? [mastra.require(alias), esm]
				: [esm];
			for (const utils of implementations) {
				const { z } = dependency.require("zod");
				const schema = z.object({ value: z.number() });
				assert.deepEqual(
					(await utils.safeParseJSON({ text: '{"value":2}', schema }))
						.value,
					{ value: 2 },
				);
				for (const text of [
					'{"value":"invalid"}',
					"not-json",
					'{"__proto__":{"polluted":true}}',
				]) {
					assert.equal(
						(await utils.safeParseJSON({ text, schema })).success,
						false,
					);
				}
				const stream = utils.parseJsonEventStream({
					stream: new Response(
						'data: {"value":3}\n\ndata: {"value":"invalid"}\n\ndata: [DONE]\n\n',
					).body,
					schema,
				});
				const chunks = [];
				for await (const chunk of stream) {
					chunks.push(chunk);
				}
				assert.equal(chunks.length, 2);
				assert.equal(chunks[0].success, true);
				assert.deepEqual(chunks[0].value, { value: 3 });
				assert.equal(chunks[1].success, false);
				const successHandler = utils.createJsonResponseHandler(schema);
				const errorHandler = utils.createJsonErrorResponseHandler({
					errorSchema: z.object({ error: z.string() }),
					errorToMessage: (body) => body.error,
				});
				const statusHandler =
					utils.createStatusCodeErrorResponseHandler();
				const input = {
					url: "https://example.test/model",
					requestBodyValues: {},
				};
				assert.deepEqual(
					(
						await successHandler({
							...input,
							response: new Response('{"value":4}'),
						})
					).value,
					{ value: 4 },
				);
				const ordinaryError = await errorHandler({
					...input,
					response: new Response('{"error":"synthetic rejection"}', {
						status: 400,
					}),
				});
				assert.equal(
					ordinaryError.value.message,
					"synthetic rejection",
				);
				assert.equal(ordinaryError.value.statusCode, 400);
				const ordinaryStatus = await statusHandler({
					...input,
					response: new Response("synthetic rejection", {
						status: 429,
						statusText: "Too Many Requests",
					}),
				});
				assert.equal(ordinaryStatus.value.statusCode, 429);
				assert.equal(
					ordinaryStatus.value.responseBody,
					"synthetic rejection",
				);
				for (const handler of [
					successHandler,
					errorHandler,
					statusHandler,
				]) {
					let reads = 0;
					let cancelled = false;
					const body = new ReadableStream(
						{
							pull(controller) {
								reads++;
								controller.enqueue(new Uint8Array(4));
							},
							cancel() {
								cancelled = true;
							},
						},
						{ highWaterMark: 0 },
					);
					const response = new Response(body, {
						headers: {
							"content-length": String(
								utils.DEFAULT_MAX_DOWNLOAD_SIZE + 1,
							),
						},
					});
					await assert.rejects(
						handler({ ...input, response }),
						/exceeded maximum size/,
					);
					assert.equal(
						reads,
						0,
						"oversized declared responses must fail before reading or JSON parsing",
					);
					assert.equal(cancelled, true);
				}
				for (const headers of [{}, { "content-length": "1" }]) {
					let reads = 0;
					let cancelled = false;
					const body = new ReadableStream(
						{
							pull(controller) {
								reads++;
								controller.enqueue(new Uint8Array(4));
							},
							cancel() {
								cancelled = true;
							},
						},
						{ highWaterMark: 0 },
					);
					await assert.rejects(
						utils.readResponseWithSizeLimit({
							response: new Response(body, { headers }),
							url: input.url,
							maxBytes: 8,
						}),
						/exceeded maximum size/,
					);
					assert.equal(
						reads,
						3,
						"the shared handler reader must stop at the first chunk over its byte budget",
					);
					assert.equal(cancelled, true);
				}
			}
		}
	});
}

function verifyMastraProviderUtilsLockfile(lockfile) {
	for (const { key, version } of entriesNamed(
		lockfile,
		"packages",
		"@ai-sdk/provider-utils",
	)) {
		assert.ok(
			isStableOutside(
				version,
				"<3.0.28 || >=4.0.0 <4.0.33 || >=5.0.0 <5.0.1",
			),
			`Affected or unreviewed provider-utils: ${key}`,
		);
	}
	for (const { key, version } of entriesNamed(
		lockfile,
		"packages",
		"@ai-sdk/ui-utils",
	)) {
		assert.notEqual(version, "1.2.11", `Retired UI utilities: ${key}`);
	}
}

test("the lockfile excludes GHSA-866g-f22w-33x8 and the retired Mastra UI utilities", () => {
	const lockfile = readLockfile();
	verifyMastraProviderUtilsLockfile(lockfile);
	for (const version of [
		"2.2.8",
		"3.0.27",
		"4.0.32",
		"5.0.0",
		"4.0.0-beta.10",
		"5.0.0-beta.0",
	]) {
		const key = `@ai-sdk/provider-utils@${version}`;
		const bad = addPackage(mutableCopy(lockfile), key);
		assert.throws(
			() => verifyMastraProviderUtilsLockfile(validateLockfile(bad)),
			{ message: `Affected or unreviewed provider-utils: ${key}` },
		);
	}
	const bad = addPackage(mutableCopy(lockfile), "@ai-sdk/ui-utils@1.2.11");
	assert.throws(
		() => verifyMastraProviderUtilsLockfile(validateLockfile(bad)),
		{ message: "Retired UI utilities: @ai-sdk/ui-utils@1.2.11" },
	);
});

test("supported Azure parents use fixed Identity and MSAL while the Teams parent stays separately reviewed", () => {
	for (const [name, version] of [
		["applicationinsights", "3.17.0"],
		["@azure/monitor-opentelemetry", "1.20.1"],
	]) {
		for (const parent of installedConsumers(name, version)) {
			const identity = installedDependency(
				parent.require,
				"@azure/identity",
			);
			assert.equal(identity.manifest.version, "4.14.1");
			assert.ok(
				semver.satisfies(
					identity.manifest.version,
					parent.manifest.dependencies["@azure/identity"],
				),
			);
			const msal = installedDependency(
				identity.require,
				"@azure/msal-node",
			);
			assert.ok(semver.gte(msal.manifest.version, "7.1.0"));
			assert.ok(
				semver.satisfies(
					msal.manifest.version,
					identity.manifest.dependencies["@azure/msal-node"],
				),
			);
		}
	}
	for (const parent of installedConsumers(
		"@microsoft/agents-hosting",
		"1.8.1",
	)) {
		assert.equal(
			installedDependency(parent.require, "@azure/msal-node").manifest
				.version,
			"5.1.5",
		);
	}
});

// GHSA-x8rm-f576-gq67 (PhoneNumber ReDoS) affects graphql-scalars >=1.24.1
// <=2.0.0. The fix, 2.0.1, is outside CopilotKit's and type-graphql's 1.x
// ranges, so a CopilotKit-scoped override pins the unaffected 1.24.0.
const graphqlScalarsAffected = ">=1.24.1 <=2.0.0";
const graphqlScalarsVersion = "1.24.0";

// Prereleases fail too: semver.satisfies excludes them from any range, so a
// 2.0.0-rc would otherwise read as "outside" the affected range.
function verifyGraphqlScalarsLockfile(lockfile) {
	requireLockfile(lockfile);
	for (const section of ["packages", "snapshots"]) {
		const entries = entriesNamed(lockfile, section, "graphql-scalars");
		assert.ok(
			entries.length > 0,
			`No graphql-scalars entries in ${section}`,
		);
		for (const { key, version } of entries) {
			assert.ok(
				isStableOutside(version, graphqlScalarsAffected),
				`Vulnerable or unreviewed graphql-scalars resolution: ${key} (${section})`,
			);
		}
	}
	for (const reference of referencesTo(lockfile, "graphql-scalars")) {
		assert.ok(
			reference.target?.name === "graphql-scalars" &&
				isStableOutside(
					reference.target.version,
					graphqlScalarsAffected,
				),
			`Vulnerable or unreviewed graphql-scalars reference: ${reference.owner}`,
		);
	}
}

// Runs PhoneNumber parsing on the advisory's payload shape in a child with a
// deadline: the affected regex backtracks exponentially, the 1.24.0 one is
// linear. A timeout, a crash or an unexpected result all count as failures.
function phoneNumberRejectsQuickly(modulePath) {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			`const { GraphQLPhoneNumber } = require(process.argv[1]);
			let rejected = false;
			try { GraphQLPhoneNumber.parseValue("1".repeat(40) + "x"); }
			catch { rejected = true; }
			process.exit(rejected ? 0 : 3);`,
			modulePath,
		],
		{ encoding: "utf8", timeout: 5000, windowsHide: true },
	);
	return (
		result.error === undefined &&
		result.signal === null &&
		result.status === 0
	);
}

test("graphql-scalars lockfile guard rejects affected versions", () => {
	const lockfile = readLockfile();
	verifyGraphqlScalarsLockfile(lockfile);
	for (const version of [
		"1.24.1",
		"1.25.0",
		"2.0.0",
		"2.0.0-rc.1",
		"1.24.1-beta.0",
		"2.0.1-rc.0",
	]) {
		const bad = addPackage(
			mutableCopy(lockfile),
			`graphql-scalars@${version}`,
		);
		assert.throws(
			() => verifyGraphqlScalarsLockfile(validateLockfile(bad)),
			/Vulnerable or unreviewed graphql-scalars resolution/,
			version,
		);
	}
	// A `file:` copy has no version to compare and fails as unreviewed.
	const local = addPackage(mutableCopy(lockfile), "example-parent@1.0.0", {
		dependencies: { "graphql-scalars": "file:vendor/graphql-scalars" },
	});
	assert.throws(
		() => verifyGraphqlScalarsLockfile(validateLockfile(local)),
		/Vulnerable or unreviewed graphql-scalars reference: example-parent@1\.0\.0/,
	);
	for (const bad of [null, {}, { packages: {}, snapshots: {} }]) {
		assert.throws(
			() => verifyGraphqlScalarsLockfile(validateLockfile(bad)),
			/could not check/,
		);
		assert.throws(
			() => verifyGraphqlScalarsLockfile(bad),
			/could not check: guard input is not a validated lockfile/,
		);
	}
	assertRejectsMalformed(verifyGraphqlScalarsLockfile, lockfile);
});

test("CopilotKit and type-graphql load unaffected graphql-scalars with their scalars", () => {
	for (const runtime of installedConsumers("@copilotkit/runtime", "1.80.0")) {
		const scalars = installedDependency(runtime.require, "graphql-scalars");
		assert.equal(scalars.manifest.version, graphqlScalarsVersion);
		assert.ok(
			semver.satisfies(
				scalars.manifest.version,
				runtime.manifest.dependencies["graphql-scalars"],
			),
		);
		const typeGraphql = installedDependency(
			runtime.require,
			"type-graphql",
		);
		const peerScalars = installedDependency(
			typeGraphql.require,
			"graphql-scalars",
		);
		assert.equal(peerScalars.path, scalars.path);
		assert.ok(
			semver.satisfies(
				peerScalars.manifest.version,
				typeGraphql.manifest.peerDependencies["graphql-scalars"],
			),
		);
		const module = scalars.require(scalars.entry);
		for (const name of [
			"GraphQLJSON",
			"GraphQLJSONObject",
			"GraphQLTimestamp",
			"GraphQLDateTimeISO",
		]) {
			assert.equal(typeof module[name]?.parseValue, "function", name);
		}
		assert.equal(phoneNumberRejectsQuickly(scalars.entry), true);
	}
});

test("PhoneNumber probe fails on a slow, accepting or crashing parser", () => {
	const artifacts = join(root, "artifacts");
	mkdirSync(artifacts, { recursive: true });
	const directory = mkdtempSync(join(artifacts, "phone-probe-"));
	try {
		for (const [name, body] of [
			["slow.js", "parseValue() { for (;;) {} }"],
			["accepts.js", "parseValue(value) { return value; }"],
			["crashes.js", "parseValue() { process.exit(1); }"],
		]) {
			const path = join(directory, name);
			writeFileSync(
				path,
				`module.exports = { GraphQLPhoneNumber: { ${body} } };`,
			);
			assert.equal(phoneNumberRejectsQuickly(path), false, name);
		}
		const good = join(directory, "good.js");
		writeFileSync(
			good,
			'module.exports = { GraphQLPhoneNumber: { parseValue() { throw new TypeError("x"); } } };',
		);
		assert.equal(phoneNumberRejectsQuickly(good), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("modern glob consumers retain object APIs, expansion, negation and minimatch behavior", async () => {
	const directory = join(root, "tooling/scripts/src");
	for (const [name, version] of [
		["archiver-utils", "5.0.2"],
		["rimraf", "5.0.10"],
		["react-email", "4.3.2"],
	]) {
		for (const parent of installedConsumers(name, version)) {
			const dependency = installedDependency(parent.require, "glob");
			assert.equal(dependency.manifest.version, "14.0.2");
			const glob = parent.require("glob");
			assert.equal(typeof glob, "object");
			assert.ok(
				glob
					.globSync("*.node-test.mjs", { cwd: directory })
					.includes("dependency-security.node-test.mjs"),
			);
			assert.deepEqual(
				await glob.glob("no-such-dependency-fixture-*.txt", {
					cwd: directory,
				}),
				[],
			);
			const matcher = installedDependency(
				dependency.require,
				"minimatch",
			);
			assert.ok(semver.gte(matcher.manifest.version, "11.0.1"));
			const { minimatch, Minimatch } = dependency.require("minimatch");
			assert.equal(minimatch("nested/file.ts", "**/*.{ts,tsx}"), true);
			assert.equal(minimatch("nested/file.js", "**/*.{ts,tsx}"), false);
			assert.equal(
				new Minimatch("**/.*", { dot: true }).match("nested/.hidden"),
				true,
			);
		}
	}
	for (const parent of installedConsumers("archiver-utils", "5.0.2")) {
		const files = parent
			.require("./file.js")
			.expand({ cwd: directory }, ["*.node-test.mjs", "!pg-*.mjs"]);
		assert.ok(files.includes("dependency-security.node-test.mjs"));
		assert.equal(
			files.includes("pg-instrumentation-security.node-test.mjs"),
			false,
		);
	}
	const artifacts = join(root, "artifacts");
	mkdirSync(artifacts, { recursive: true });
	const fixture = mkdtempSync(join(artifacts, "dependency-glob-"));
	try {
		writeFileSync(join(fixture, "remove.txt"), "synthetic");
		writeFileSync(join(fixture, "keep.md"), "synthetic");
		for (const parent of installedConsumers("rimraf", "5.0.10")) {
			await parent
				.require("./")
				.rimraf(join(fixture, "*.txt").replaceAll("\\", "/"), {
					glob: true,
				});
		}
		assert.equal(existsSync(join(fixture, "remove.txt")), false);
		assert.equal(existsSync(join(fixture, "keep.md")), true);
	} finally {
		assert.ok(
			resolve(fixture).startsWith(
				`${resolve(artifacts)}\\dependency-glob-`,
			) ||
				resolve(fixture).startsWith(
					`${resolve(artifacts)}/dependency-glob-`,
				),
		);
		rmSync(fixture, { recursive: true });
	}
});

test("legacy glob and minimatch keep their callable contracts", () => {
	for (const consumer of installedConsumers("glob", "7.2.3")) {
		const glob = consumer.require("./");
		assert.equal(typeof glob, "function");
		assert.ok(
			glob.sync("*.node-test.mjs", {
				cwd: join(root, "tooling/scripts/src"),
			}).length > 0,
		);
	}
	for (const version of ["3.1.5", "5.1.9"]) {
		for (const consumer of installedConsumers("minimatch", version)) {
			const minimatch = consumer.require("./");
			assert.equal(typeof minimatch, "function");
			assert.equal(minimatch("file.ts", "*.ts"), true);
		}
	}
});

test("the installed test runner, mocker and coverage stay aligned", () => {
	assert.equal(
		installedDependency(webRequire, "vitest").manifest.version,
		"4.1.12",
	);
	assert.equal(
		installedDependency(webRequire, "@vitest/coverage-v8").manifest.version,
		"4.1.12",
	);
	for (const runner of installedConsumers("vitest", "4.1.12")) {
		assert.equal(
			installedDependency(runner.require, "@vitest/mocker").manifest
				.version,
			"4.1.12",
		);
	}
});
