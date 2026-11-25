import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	checkPackages,
	computeIntegrity,
	groupByCommit,
	listPublishedPackages,
	resultExitCode,
} from "./check.mjs";

const fixture = (file) =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url)),
	);
const metadata = fixture("npm-view-sdk-0.8.4");
const provenance = fixture("attestations-sdk-0.8.4");
const notFound = fixture("attestations-runtime-0.1.0-none");
const commit = "023952e75943ea0d972a2cef05b9bfdbe933dd2b";
const name = metadata.name;

test("enumerates only public scoped packages", () => {
	assert.deepEqual(
		listPublishedPackages([
			{ name, private: false },
			{ name: "@fabricorg/example" },
			{ name: "@fabricorg/private-example", private: true },
			{ name: "@repo/example" },
		]),
		["@fabricorg/example", name],
	);
});

test("rejects an empty published package set", () => {
	assert.throws(() => listPublishedPackages([]), /No publishable/);
});

test("groups packages by provenance commit", () => {
	const entries = [{ commit }, { commit: "b".repeat(40) }, { commit }];
	assert.deepEqual(
		[...groupByCommit(entries).values()],
		[[entries[0], entries[2]], [entries[1]]],
	);
});

test("computes an npm SHA-512 integrity string", () => {
	assert.equal(
		computeIntegrity(Buffer.from("abc")),
		"sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
	);
});

function changePayload(change) {
	const response = structuredClone(provenance);
	const envelope = response.attestations[0].bundle.dsseEnvelope;
	const statement = JSON.parse(Buffer.from(envelope.payload, "base64"));
	change(statement, statement.predicate.buildDefinition);
	envelope.payload = Buffer.from(JSON.stringify(statement)).toString(
		"base64",
	);
	return response;
}

function run({
	latest = Response.json(metadata),
	attestation = Response.json(provenance),
	rebuild = async () => new Map([[name, metadata.dist.integrity]]),
} = {}) {
	return checkPackages([name], {
		fetchJsonResponse: async (url) => {
			switch (url) {
				case "https://registry.npmjs.org/@fabricorg%2fsdk/latest":
					return latest;
				case "https://registry.npmjs.org/-/npm/v1/attestations/@fabricorg%2fsdk@0.8.4":
					return attestation;
				default:
					assert.fail(`Unexpected registry request: ${url}`);
			}
		},
		rebuild,
	});
}

test("all matching bytes pass", async () => {
	const rows = await run();
	assert.deepEqual(rows, [
		{
			name,
			version: metadata.version,
			expected: metadata.dist.integrity,
			commit,
			actual: metadata.dist.integrity,
			verdict: "pass",
		},
	]);
	assert.equal(resultExitCode(rows), 0);
});

test("a mismatch fails", async () => {
	const rows = await run({
		rebuild: async () =>
			new Map([[name, computeIntegrity(Buffer.from("abc"))]]),
	});
	assert.equal(rows[0].verdict, "fail");
	assert.equal(resultExitCode(rows), 1);
});

const cases = [
	[
		"registry HTTP error",
		() => ({ latest: Response.json(metadata, { status: 503 }) }),
		/HTTP 503/,
	],
	[
		"unreadable registry response",
		() => ({ latest: new Response("bad JSON") }),
		/JSON/,
	],
	[
		"missing version",
		() => ({ latest: Response.json({ ...metadata, version: "" }) }),
		/version/,
	],
	[
		"non-string version",
		() => ({ latest: Response.json({ ...metadata, version: 42 }) }),
		/version/,
	],
	[
		"missing integrity",
		() => ({ latest: Response.json({ ...metadata, dist: {} }) }),
		/integrity/,
	],
	[
		"non-string integrity",
		() => ({
			latest: Response.json({
				...metadata,
				dist: { integrity: [metadata.dist.integrity] },
			}),
		}),
		/integrity/,
	],
	[
		"invalid integrity",
		() => ({
			latest: Response.json({
				...metadata,
				dist: { integrity: "sha512-bad" },
			}),
		}),
		/integrity/,
	],
	[
		"attestation 404",
		() => ({ attestation: Response.json(notFound, { status: 404 }) }),
		/HTTP 404/,
	],
	[
		"missing SLSA attestation",
		() => ({
			attestation: Response.json({
				attestations: [
					{ ...provenance.attestations[0], predicateType: "other" },
				],
			}),
		}),
		/Missing SLSA/,
	],
	[
		"malformed payload",
		() => ({
			attestation: Response.json({
				attestations: [
					{
						predicateType: provenance.attestations[0].predicateType,
						bundle: {
							dsseEnvelope: {
								payload: `!${provenance.attestations[0].bundle.dsseEnvelope.payload}`,
							},
						},
					},
				],
			}),
		}),
		/base64/,
	],
	[
		"wrong statement type",
		() => ({
			attestation: Response.json(
				changePayload((statement) => {
					statement.predicateType = "other";
				}),
			),
		}),
		/statement type/,
	],
	[
		"wrong repository",
		() => ({
			attestation: Response.json(
				changePayload((_, definition) => {
					definition.externalParameters.workflow.repository =
						"https://example.com";
				}),
			),
		}),
		/repository/,
	],
	[
		"wrong workflow",
		() => ({
			attestation: Response.json(
				changePayload((_, definition) => {
					definition.externalParameters.workflow.path =
						".github/workflows/example.yml";
				}),
			),
		}),
		/workflow/,
	],
	[
		"short commit",
		() => ({
			attestation: Response.json(
				changePayload((_, definition) => {
					definition.resolvedDependencies[0].digest.gitCommit =
						commit.slice(1);
				}),
			),
		}),
		/commit/,
	],
	[
		"non-hex commit",
		() => ({
			attestation: Response.json(
				changePayload((_, definition) => {
					definition.resolvedDependencies[0].digest.gitCommit =
						"z".repeat(40);
				}),
			),
		}),
		/commit/,
	],
	[
		"non-string commit",
		() => ({
			attestation: Response.json(
				changePayload((_, definition) => {
					definition.resolvedDependencies[0].digest.gitCommit = [
						"a".repeat(40),
					];
				}),
			),
		}),
		/40-hex provenance commit/,
	],
	[
		"failed commit export or build",
		() => ({
			rebuild: async () => {
				throw new Error("build failed");
			},
		}),
		/build failed/,
	],
	[
		"missing packed tarball",
		() => ({ rebuild: async () => new Map() }),
		/tarball/,
	],
];

for (const [label, input, error] of cases) {
	test(`${label} is could not check`, async () => {
		const rows = await run(input());
		assert.equal(rows[0].verdict, "could not check");
		assert.match(rows[0].reason, error);
		assert.equal(resultExitCode(rows), 1);
	});
}
