import assert from "node:assert/strict";
import test from "node:test";
import {
	installedConsumers,
	installedDependency,
} from "./installed-consumers.mjs";
import {
	addPackage,
	assertRejectsMalformed,
	entriesNamed,
	isStableAtLeast,
	mutableCopy,
	readLockfile,
	referencesTo,
	requireLockfile,
	semver,
	validateLockfile,
} from "./lockfile-shape.mjs";

const pgName = "@opentelemetry/instrumentation-pg";
// [parent, parent version, PG instrumentation version that parent resolves]
const pgParents = [
	["@azure/monitor-opentelemetry", "1.20.1", "0.73.0"],
	["@opentelemetry/auto-instrumentations-node", "0.81.2", "0.76.0"],
];
const floors = {
	pg: "0.73.0",
	mysql2: "0.67.0",
	knex: "0.65.0",
	mysql: "0.67.0",
	mongoose: "0.67.0",
	oracledb: "0.46.0",
	tedious: "0.40.0",
	"cassandra-driver": "0.66.0",
};
function verifyInstrumentation(lockfile) {
	requireLockfile(lockfile);
	for (const [instrumentation, floor] of Object.entries(floors)) {
		const name = `@opentelemetry/instrumentation-${instrumentation}`;
		for (const section of ["packages", "snapshots"]) {
			const entries = entriesNamed(lockfile, section, name);
			assert.ok(entries.length > 0, `Missing ${name}@ in ${section}`);
			for (const { key, version } of entries) {
				assert.ok(
					isStableAtLeast(version, floor),
					`Vulnerable instrumentation: ${key}`,
				);
			}
		}
		// Every direct or aliased reference, not only the PG one.
		for (const reference of referencesTo(lockfile, name)) {
			assert.ok(
				reference.target?.name === name &&
					isStableAtLeast(reference.target.version, floor),
				`Vulnerable ${instrumentation === "pg" ? "PG" : instrumentation} reference: ${reference.owner}`,
			);
		}
	}
}

test("all eight database instrumentation advisory floors cover every lockfile version", () => {
	const lockfile = readLockfile();
	verifyInstrumentation(lockfile);
	for (const version of ["0.69.0", "0.80.0-rc.1"]) {
		const bad = addPackage(mutableCopy(lockfile), `${pgName}@${version}`);
		assert.throws(
			() => verifyInstrumentation(validateLockfile(bad)),
			/Vulnerable instrumentation/,
			version,
		);
	}
	// Registry references always name a snapshot the entry check reads, so
	// the reference check is shown on `file:` copies.
	for (const [name, version] of [
		["unreviewed-pg-alias", `${pgName}@file:vendor/pg`],
		[pgName, "file:vendor/pg"],
	]) {
		const bad = mutableCopy(lockfile);
		bad.importers["."].dependencies = {
			...bad.importers["."].dependencies,
			[name]: { specifier: "*", version },
		};
		assert.throws(
			() => verifyInstrumentation(validateLockfile(bad)),
			/Vulnerable PG reference/,
		);
	}
	const bad = mutableCopy(lockfile);
	bad.importers["."].dependencies = {
		...bad.importers["."].dependencies,
		"mysql-alias": {
			specifier: "*",
			version: "@opentelemetry/instrumentation-mysql2@file:vendor/mysql2",
		},
	};
	assert.throws(
		() => verifyInstrumentation(validateLockfile(bad)),
		/Vulnerable mysql2 reference/,
	);
	assertRejectsMalformed(verifyInstrumentation, lockfile);
});

const baseParams = {
	user: "synthetic_connection_user",
	database: "example_db",
	host: "db.example.test",
	port: 5432,
	idleTimeoutMillis: 1000,
	maxClient: 10,
};
const cases = [
	{
		name: "connection",
		helper: "getSemanticAttributesFromConnection",
		params: baseParams,
		pool: false,
		database: "example_db",
		host: "db.example.test",
		port: 5432,
	},
	{
		name: "pool parameters",
		helper: "getSemanticAttributesFromPoolConnection",
		params: { ...baseParams, user: "synthetic_pool_user" },
		pool: true,
		database: "example_db",
		host: "db.example.test",
		port: 5432,
	},
	{
		name: "pool URI",
		helper: "getSemanticAttributesFromPoolConnection",
		params: {
			...baseParams,
			connectionString:
				"postgresql://synthetic_uri_user@pool.example.test:6432/uri_db",
		},
		pool: true,
		database: "uri_db",
		host: "pool.example.test",
		port: 6432,
	},
];

for (const [parentName, parentVersion, pgVersion] of pgParents) {
	test(`${parentName}: supported PG parent retains fixed instrumentation`, () => {
		for (const parent of installedConsumers(parentName, parentVersion)) {
			const pg = installedDependency(parent.require, pgName);
			assert.equal(pg.manifest.version, pgVersion);
			assert.ok(
				semver.satisfies(
					pg.manifest.version,
					parent.manifest.dependencies[pgName],
				),
			);
			assert.equal(pg.manifest.main, "build/src/index.js");
		}
	});
	for (const fixture of cases) {
		test(
			parentName +
				": " +
				fixture.name +
				" omits usernames and retains stable database attributes",
			() => {
				for (const parent of installedConsumers(
					parentName,
					parentVersion,
				)) {
					const pg = installedDependency(parent.require, pgName);
					const attributes = pg
						.require("./build/src/utils.js")
						[fixture.helper](fixture.params);
					assert.deepEqual(attributes, {
						...(fixture.pool
							? {
									"db.postgresql.idle.timeout.millis": 1000,
									"db.postgresql.max.client": 10,
								}
							: {}),
						"db.system.name": "postgresql",
						"db.namespace": fixture.database,
						"server.address": fixture.host,
						"server.port": fixture.port,
					});
					assert.doesNotMatch(
						JSON.stringify(attributes),
						/synthetic_.*user|db.user/,
					);
				}
			},
		);
	}
}

test("actual Azure exporter preserves stable and legacy PostgreSQL classification, target, query and operation", () => {
	for (const monitor of installedConsumers(
		"@azure/monitor-opentelemetry",
		"1.20.1",
	)) {
		const exporter = installedDependency(
			monitor.require,
			"@azure/monitor-opentelemetry-exporter",
		);
		assert.equal(exporter.manifest.version, "1.0.0-beta.46");
		const { readableSpanToEnvelope } = exporter.require(
			"./dist/commonjs/utils/spanUtils.js",
		);
		const pg = installedDependency(monitor.require, pgName);
		const utils = pg.require("./build/src/utils.js");
		let queryAttributes = {};
		const tracer = {
			startSpan(_name, options) {
				queryAttributes = { ...options.attributes };
				return {
					setAttribute(key, value) {
						queryAttributes[key] = value;
					},
				};
			},
		};
		utils.handleConfigQuery.call(
			{ connectionParameters: baseParams },
			tracer,
			{},
			{ text: "SELECT 1" },
		);
		assert.equal(queryAttributes["db.query.text"], "SELECT 1");
		const fixtures = [
			[queryAttributes, "SELECT 1"],
			[
				{
					...utils.getSemanticAttributesFromConnection(baseParams),
					"db.operation.name": "SELECT",
				},
				"SELECT",
			],
			[
				{
					"db.system": "postgresql",
					"db.name": "example_db",
					"net.peer.name": "db.example.test",
					"net.peer.port": 5432,
					"db.statement": "SELECT 1",
				},
				"SELECT 1",
			],
			[
				{
					"db.system": "postgresql",
					"db.name": "example_db",
					"net.peer.name": "db.example.test",
					"db.operation": "SELECT",
				},
				"SELECT",
			],
		];
		for (const [attributes, data] of fixtures) {
			const span = {
				name: "pg.query:SELECT example_db",
				kind: 2,
				attributes,
				resource: {
					attributes: { "service.name": "dependency-guard" },
				},
				links: [],
				events: [],
				status: { code: 1 },
				startTime: [1, 0],
				endTime: [1, 1000000],
				duration: [0, 1000000],
				instrumentationScope: { name: "dependency-guard" },
				spanContext: () => ({
					traceId: "1".repeat(32),
					spanId: "2".repeat(16),
					traceFlags: 1,
				}),
			};
			const envelope = readableSpanToEnvelope(
				span,
				"00000000-0000-4000-8000-000000000001",
			);
			assert.equal(envelope.data.baseType, "RemoteDependencyData");
			assert.equal(envelope.data.baseData.type, "postgresql");
			assert.equal(
				envelope.data.baseData.target,
				"db.example.test|example_db",
			);
			assert.equal(envelope.data.baseData.data, data);
			assert.equal(envelope.data.baseData.success, true);
			assert.doesNotMatch(
				JSON.stringify(envelope),
				/synthetic_.*user|db.user/,
			);
		}
	}
});
