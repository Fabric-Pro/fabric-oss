import assert from "node:assert/strict";
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

const root = fileURLToPath(new URL("../../../", import.meta.url));
const webRequire = createRequire(join(root, "apps/web/package.json"));
const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
	"semver",
);
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
	assert.equal(
		lockfile.patchedDependencies["@ag-ui/core@1.0.2"],
		aguiPatchHash,
	);
	const snapshots = Object.keys(lockfile.snapshots).filter((key) =>
		key.startsWith("@ag-ui/core@"),
	);
	assert.ok(snapshots.length > 0);
	for (const key of snapshots) {
		assert.ok(
			key.startsWith(`@ag-ui/core@1.0.2(patch_hash=${aguiPatchHash})`),
			`Unpatched AG-UI: ${key}`,
		);
		assert.equal(
			lockfile.snapshots[key].dependencies["zod-agui-runtime"],
			"zod@4.6.7",
		);
	}
	for (const [owner, metadata] of Object.entries(lockfile.snapshots)) {
		for (const [name, reference] of Object.entries(
			metadata.dependencies ?? {},
		)) {
			if (name === "@ag-ui/core") {
				assert.ok(
					reference.startsWith(`1.0.2(patch_hash=${aguiPatchHash})`),
					`Unpatched AG-UI parent: ${owner}`,
				);
			}
		}
	}
}

test("the exact AG-UI schema patch and isolated alias cover every peer island", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const workspace = yaml.parse(
		readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
	);
	const lockfile = yaml.parse(
		readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
	);
	const patch = readFileSync(join(root, aguiPatchPath));
	verifyAguiPatch(workspace, lockfile, patch);
	assert.throws(() =>
		verifyAguiPatch(
			workspace,
			lockfile,
			Buffer.concat([patch, Buffer.from("changed")]),
		),
	);
	const bad = structuredClone(lockfile);
	bad.snapshots["@ag-ui/core@1.0.2(zod@3.25.76)"] = {};
	assert.throws(() => verifyAguiPatch(workspace, bad, patch));
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
	["@ai-sdk/provider-utils-v5", "3.0.36"],
	["@ai-sdk/provider-utils-v6", "4.0.51"],
]) {
	test(`Mastra ${alias} retains JSON/SSE validation and bounded response handlers on its fixed API major`, async () => {
		for (const mastra of installedConsumers("@mastra/core", "1.0.4")) {
			const dependency = installedDependency(mastra.require, alias);
			assert.equal(dependency.manifest.name, "@ai-sdk/provider-utils");
			assert.equal(dependency.manifest.version, version);
			const declared = mastra.manifest.dependencies[alias];
			assert.ok(
				declared.startsWith(
					`npm:@ai-sdk/provider-utils@${version[0]}.`,
				),
			);
			for (const utils of [
				mastra.require(alias),
				await import(
					pathToFileURL(
						join(
							dirname(dependency.path),
							dependency.manifest.module,
						),
					).href
				),
			]) {
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

test("legacy UI utilities retain provider-utils 2 without importing the affected response handlers", () => {
	for (const parent of installedConsumers("@ai-sdk/ui-utils", "1.2.11")) {
		assert.equal(
			installedDependency(parent.require, "@ai-sdk/provider-utils")
				.manifest.version,
			"2.2.8",
		);
		for (const file of ["./dist/index.js", "./dist/index.mjs"]) {
			const source = readFileSync(parent.require.resolve(file), "utf8");
			assert.equal(
				source.match(
					/createJsonResponseHandler|createJsonErrorResponseHandler|createStatusCodeErrorResponseHandler/,
				)?.[0],
				undefined,
				`${file}: re-evaluate the vulnerable v2 response-handler path`,
			);
		}
	}
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
