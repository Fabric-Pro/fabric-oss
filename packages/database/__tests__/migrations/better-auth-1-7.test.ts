import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backfillBetterAuth17,
	isBetterAuth17Ready,
	oauthUpgradeAudiences,
} from "../../scripts/backfill-better-auth-1-7";

// Explicit opt-in: this suite creates and drops its own schema. Never use the
// application's DATABASE_URL or an existing shared database for this rehearsal.
const databaseUrl = process.env.OAUTH_UPGRADE_TEST_DATABASE_URL;
const root = resolve(import.meta.dirname, "../..");
const migrations = resolve(root, "prisma/migrations");
const backfillPath = resolve(root, "scripts/backfill-better-auth-1-7.sql");
const cursorMigrationPath = resolve(
	migrations,
	"20261007120000_allow_cursor_oauth_callback/migration.sql",
);
let client: Client;
let schema: string;

function gateEnvironment() {
	const url = new URL(databaseUrl ?? "");
	url.searchParams.set("options", `-c search_path=${schema}`);
	return { ...process.env, DATABASE_URL: url.toString() };
}

function checkInstalled(args: string[] = []) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			resolve(root, "scripts/backfill-better-auth-1-7.ts"),
			"--check-installed",
			...args,
		],
		{ cwd: root, env: gateEnvironment(), encoding: "utf8", timeout: 10000 },
	);
}

async function backfill() {
	try {
		await client.query(
			"SELECT set_config('app.oauth_upgrade_audiences', $1, false)",
			[
				JSON.stringify([
					"https://example.com/api/mcp-gateway",
					"https://example.com/api/mcp-gateway/",
					"https://example.com/api/v1",
				]),
			],
		);
		await client.query(readFileSync(backfillPath, "utf8"));
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function register(id: string, extra: Record<string, unknown> = {}) {
	const row = {
		id,
		clientId: id,
		public: true,
		type: "native",
		tokenEndpointAuthMethod: "none",
		redirectUris: ["http://127.0.0.1:4000/callback"],
		grantTypes: ["authorization_code", "refresh_token"],
		responseTypes: ["code"],
		requirePKCE: true,
		...extra,
	};
	const fields = Object.keys(row);
	return client.query(
		`INSERT INTO oauth_client (${fields.map((field) => `"${field}"`).join(",")})
		 VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})`,
		Object.values(row),
	);
}

describe.skipIf(!databaseUrl)("Better Auth 1.7 database compatibility", () => {
	beforeEach(async () => {
		if (!databaseUrl) {
			throw new Error("Missing disposable database URL");
		}
		const url = new URL(databaseUrl);
		if (
			!["127.0.0.1", "localhost"].includes(url.hostname) ||
			!(
				url.pathname === "/auth_rehearsal" ||
				url.pathname.startsWith("/auth_upgrade_test")
			)
		) {
			throw new Error(
				"OAuth upgrade tests require a disposable local database",
			);
		}
		client = new Client({ connectionString: databaseUrl });
		await client.connect();
		schema = `oauth_upgrade_${randomUUID().replaceAll("-", "")}`;
		await client.query(`CREATE SCHEMA "${schema}"`);
		await client.query(`SET search_path TO "${schema}"`);
		await client.query(
			'CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE session (id TEXT PRIMARY KEY)',
		);
		const baseline = readFileSync(
			resolve(
				migrations,
				"20261002130000_oauth_agent_sign_in/migration.sql",
			),
			"utf8",
		);
		await client.query(baseline.slice(baseline.indexOf("-- CreateTable")));
		// Seed before expansion, using only the 1.6 columns.
		await register("example-native");
		await register("example-untyped", {
			type: null,
			redirectUris: ["http://localhost:4000/callback"],
		});
		await client.query(`
			INSERT INTO "user" VALUES ('example-user');
			INSERT INTO session VALUES ('example-session');
			INSERT INTO oauth_refresh_token (id, token, "clientId", "sessionId", "userId", "referenceId", scopes)
			VALUES ('example-refresh', 'example-refresh-hash', 'example-native', 'example-session', 'example-user', 'example-org', ARRAY['offline_access']);
			INSERT INTO oauth_access_token (id, token, "clientId", "sessionId", "userId", "referenceId", "refreshId", scopes)
			VALUES ('example-access', 'example-access-hash', 'example-native', 'example-session', 'example-user', 'example-org', 'example-refresh', ARRAY['openid']);
			INSERT INTO oauth_consent (id, "clientId", "userId", "referenceId", scopes)
			VALUES ('example-consent', 'example-native', 'example-user', 'example-org', ARRAY['openid']);
		`);
		const expansion = readdirSync(migrations).find((name) =>
			name.endsWith("_better_auth_1_7_expansion"),
		);
		if (expansion) {
			await client.query(
				readFileSync(
					resolve(migrations, expansion, "migration.sql"),
					"utf8",
				),
			);
		}
	});

	afterEach(async () => {
		if (!client) {
			return;
		}
		await client.query("ROLLBACK");
		if (schema) {
			await client.query(`DROP SCHEMA "${schema}" CASCADE`);
		}
		await client.end();
	});

	it("adds repository read only to the installed default API resource policy", async () => {
		const migration = readFileSync(
			resolve(
				migrations,
				"20261006160000_repository_transport_resource_scope/migration.sql",
			),
			"utf8",
		);
		await client.query(migration);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_resource",
				)
			).rows[0].count,
		).toBe(0);
		await backfill();
		const defaults = [
			"mcp:read",
			"instructions:read",
			"instructions:write",
			"offline_access",
		];
		const rows = [
			["api", "https://example.com/api/v1", defaults, false],
			["mcp", "https://example.com/api/mcp-gateway", defaults, false],
			["custom", "https://other.example/api/v1", defaults, false],
		];
		for (const [id, identifier, scopes, disabled] of rows) {
			await client.query(
				'INSERT INTO oauth_resource (id, identifier, name, "allowedScopes", disabled) VALUES ($1, $2, $1, $3, $4)',
				[id, identifier, scopes, disabled],
			);
		}
		const grantQuery =
			"SELECT * FROM (SELECT 'access' AS kind, row_to_json(t) AS row FROM oauth_access_token t UNION ALL SELECT 'refresh', row_to_json(t) FROM oauth_refresh_token t UNION ALL SELECT 'consent', row_to_json(t) FROM oauth_consent t UNION ALL SELECT 'client', row_to_json(t) FROM oauth_client t) grants ORDER BY kind, row::text";
		const grants = await client.query(grantQuery);
		await client.query(migration);
		await client.query(migration);
		expect(
			(
				await client.query(
					'SELECT "allowedScopes" FROM oauth_resource WHERE id = $1',
					["api"],
				)
			).rows[0].allowedScopes,
		).toEqual([...defaults, "repositories:read"]);
		for (const id of ["mcp", "custom"]) {
			expect(
				(
					await client.query(
						'SELECT "allowedScopes" FROM oauth_resource WHERE id = $1',
						[id],
					)
				).rows[0].allowedScopes,
			).toEqual(defaults);
		}
		expect((await client.query(grantQuery)).rows).toEqual(grants.rows);
		await client.query(
			'UPDATE oauth_resource SET "allowedScopes" = $1 WHERE id = $2',
			[["instructions:read"], "api"],
		);
		await client.query(migration);
		expect(
			(
				await client.query(
					'SELECT "allowedScopes" FROM oauth_resource WHERE id = $1',
					["api"],
				)
			).rows[0].allowedScopes,
		).toEqual(["instructions:read"]);
		await client.query(
			'UPDATE oauth_resource SET "allowedScopes" = $1, disabled = true WHERE id = $2',
			[defaults, "api"],
		);
		await client.query(migration);
		expect(
			(
				await client.query(
					'SELECT "allowedScopes" FROM oauth_resource WHERE id = $1',
					["api"],
				)
			).rows[0].allowedScopes,
		).toEqual(defaults);
	});

	it("expands the schema while preserving legacy client and grant reads", async () => {
		const rows = await client.query(
			'SELECT public, type, "applicationType" FROM oauth_client ORDER BY id',
		);
		expect(rows.rows).toEqual([
			{ public: true, type: "native", applicationType: null },
			{ public: true, type: null, applicationType: null },
		]);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_refresh_token",
				)
			).rows[0].count,
		).toBe(1);
	});

	it("backfills known native shapes twice without changing grants or consent", async () => {
		const before = await client.query(
			"SELECT row_to_json(t) AS row FROM oauth_refresh_token t",
		);
		await backfill();
		const first = await client.query(
			"SELECT row_to_json(t) AS row FROM oauth_client t ORDER BY id",
		);
		await backfill();
		expect(
			(
				await client.query(
					"SELECT row_to_json(t) AS row FROM oauth_client t ORDER BY id",
				)
			).rows,
		).toEqual(first.rows);
		expect(
			first.rows.every(
				({ row }) =>
					row.applicationType === "native" && row.public === true,
			),
		).toBe(true);
		const after = await client.query(
			"SELECT row_to_json(t) AS row FROM oauth_refresh_token t",
		);
		expect(after.rows[0].row.resources).toEqual([
			"https://example.com/api/mcp-gateway",
			"https://example.com/api/mcp-gateway/",
			"https://example.com/api/v1",
		]);
		expect({ ...after.rows[0].row, resources: null }).toEqual(
			before.rows[0].row,
		);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_access_token",
				)
			).rows[0].count,
		).toBe(1);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_consent",
				)
			).rows[0].count,
		).toBe(1);
	});

	it("maps old registrations after backfill and new registrations for rollback", async () => {
		await backfill();
		await register("example-old", { type: null });
		await register("example-new", {
			public: null,
			type: null,
			applicationType: "native",
		});
		const rows = await client.query(
			'SELECT public, type, "applicationType", "tokenEndpointAuthMethod" FROM oauth_client WHERE id IN ($1, $2)',
			["example-old", "example-new"],
		);
		expect(rows.rows).toHaveLength(2);
		for (const row of rows.rows) {
			expect(row).toEqual({
				public: true,
				type: "native",
				applicationType: "native",
				tokenEndpointAuthMethod: "none",
			});
		}
		await client.query("UPDATE oauth_client SET name = $1 WHERE id = $2", [
			"Example agent",
			"example-old",
		]);
		await backfill();
	});

	it("gives old project grants only their surface and preserves explicit new resources", async () => {
		await backfill();
		await client.query(
			`INSERT INTO oauth_consent (id, "clientId", "referenceId") VALUES ('example-project', 'example-native', 'project:api:example-project')`,
		);
		expect(
			(
				await client.query(
					"SELECT resources FROM oauth_consent WHERE id = 'example-project'",
				)
			).rows[0].resources,
		).toEqual(["https://example.com/api/v1"]);
		await client.query(
			`INSERT INTO oauth_consent (id, "clientId", "referenceId", resources) VALUES ('example-specific', 'example-native', 'example-org', ARRAY['https://example.com/api/v1'])`,
		);
		await backfill();
		expect(
			(
				await client.query(
					"SELECT resources FROM oauth_consent WHERE id = 'example-specific'",
				)
			).rows[0].resources,
		).toEqual(["https://example.com/api/v1"]);
		await expect(
			client.query(
				`INSERT INTO oauth_consent (id, "clientId", "referenceId") VALUES ('example-bad-project', 'example-native', 'project:other:example-project')`,
			),
		).rejects.toThrow("Unsupported OAuth grant reference");
	});

	it("maps public web clients to the legacy user-agent type", async () => {
		await backfill();
		await register("example-web", {
			public: null,
			type: null,
			applicationType: "web",
			redirectUris: ["https://example.com/callback"],
		});
		expect(
			(
				await client.query(
					'SELECT public, type, "applicationType" FROM oauth_client WHERE id = $1',
					["example-web"],
				)
			).rows[0],
		).toEqual({
			public: true,
			type: "user-agent-based",
			applicationType: "web",
		});
	});
	it("maps an untyped HTTPS registration from an old instance to a public web client", async () => {
		await backfill();
		await register("example-old-web", {
			type: null,
			redirectUris: ["https://example.com/callback"],
		});
		expect(
			(
				await client.query(
					'SELECT public, type, "applicationType" FROM oauth_client WHERE id = $1',
					["example-old-web"],
				)
			).rows[0],
		).toEqual({
			public: true,
			type: "user-agent-based",
			applicationType: "web",
		});
	});

	it.each([
		"com.example.agent:/callback",
		"com.example.agent:/callback?account=dev@example.com",
		"https://example.com/callback",
		"https://example.com/callback?account=dev@example.com",
		"https://example.com?callback=1",
		"http://127.0.0.1:49152?callback=1",
		"HTTPS://example.com/callback",
		"HTTP://LOCALHOST:49152/callback",
		"https://[2001:db8::1]/callback",
		"https://münich.example/callback",
	])(
		"keeps explicit native registrations readable on rollback: %s",
		async (redirect) => {
			await backfill();
			await register("example-explicit-native", {
				public: null,
				type: null,
				applicationType: "native",
				redirectUris: [redirect],
			});
			expect(
				(
					await client.query(
						'SELECT public, type, "applicationType" FROM oauth_client WHERE id = $1',
						["example-explicit-native"],
					)
				).rows[0],
			).toEqual({
				public: true,
				type: "native",
				applicationType: "native",
			});
		},
	);

	it("checks the audience configuration and installed triggers before reporting ready", async () => {
		const audiences = oauthUpgradeAudiences("https://example.com/");
		expect(await isBetterAuth17Ready(client, audiences)).toBe(false);
		await backfillBetterAuth17(client, audiences);
		expect(await isBetterAuth17Ready(client, audiences)).toBe(false);
		await backfillBetterAuth17(client, audiences, true);
		expect(await isBetterAuth17Ready(client, audiences)).toBe(true);
		expect(
			await isBetterAuth17Ready(
				client,
				oauthUpgradeAudiences("https://other.example.com"),
			),
		).toBe(false);
		await client.query(
			"ALTER TABLE oauth_refresh_token DISABLE TRIGGER fabric_oauth_grant_resources",
		);
		expect(await isBetterAuth17Ready(client, audiences)).toBe(false);
		await client.query("UPDATE oauth_refresh_token SET resources = NULL");
		await client.query(
			"ALTER TABLE oauth_refresh_token ENABLE TRIGGER fabric_oauth_grant_resources",
		);
		expect(await isBetterAuth17Ready(client, audiences)).toBe(false);
	});

	it("checks installed compatibility without an application URL", async () => {
		expect(await isBetterAuth17Ready(client)).toBe(false);
		await backfill();
		expect(await isBetterAuth17Ready(client)).toBe(true);
		expect(checkInstalled().status).toBe(0);
		await client.query(
			"ALTER TABLE oauth_refresh_token DISABLE TRIGGER fabric_oauth_grant_resources",
		);
		expect(await isBetterAuth17Ready(client)).toBe(false);
		expect(checkInstalled().status).toBe(1);
	});

	it("delegates installed readiness to the configured audience verifier", async () => {
		await backfill();
		await client.query(
			`CREATE OR REPLACE FUNCTION fabric_oauth_1_7_ready() RETURNS boolean LANGUAGE sql SET search_path TO "${schema}" AS $$SELECT fabric_oauth_1_7_ready(ARRAY['https://other.example.com/api/mcp-gateway', 'https://other.example.com/api/mcp-gateway/', 'https://other.example.com/api/v1'])$$`,
		);
		expect(await isBetterAuth17Ready(client)).toBe(false);
		expect(checkInstalled().status).toBe(1);
	});

	it("runs installed CLI verification in a read-only transaction", async () => {
		await client.query(
			`CREATE FUNCTION fabric_oauth_1_7_ready() RETURNS boolean LANGUAGE plpgsql SET search_path TO "${schema}" AS $$BEGIN UPDATE oauth_client SET disabled = true; RETURN true; END;$$`,
		);
		expect(checkInstalled().status).toBe(1);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_client WHERE disabled = true",
				)
			).rows[0].count,
		).toBe(0);
	});

	it.each(["missing", "false", "null", "malformed", "error"])(
		"stops the actual promotion command before RLS when readiness is %s",
		async (state) => {
			if (state === "false") {
				await backfill();
				await client.query(
					"ALTER TABLE oauth_refresh_token DISABLE TRIGGER fabric_oauth_grant_resources",
				);
			} else if (state !== "missing") {
				const expression =
					state === "error"
						? "SELECT 1 / 0 = 1"
						: state === "null"
							? "SELECT NULL::boolean"
							: "SELECT 'true'::text";
				await client.query(
					`CREATE FUNCTION fabric_oauth_1_7_ready() RETURNS ${state === "malformed" ? "text" : "boolean"} LANGUAGE sql AS $$${expression}$$`,
				);
			}
			expect(checkInstalled().status).toBe(1);
			const directory = mkdtempSync(
				resolve(tmpdir(), "oauth-promotion-gate-"),
			);
			const log = resolve(directory, "steps.log");
			try {
				writeFileSync(
					resolve(directory, "pnpm"),
					'#!/bin/sh\nprintf "%s\\n" "$1" >> "$OAUTH_PROMOTION_TEST_LOG"\n',
					{ mode: 0o755 },
				);
				writeFileSync(
					resolve(directory, "prisma"),
					'#!/bin/sh\nprintf "%s\\n" "migration" >> "$OAUTH_PROMOTION_TEST_LOG"\n',
					{ mode: 0o755 },
				);
				const { scripts } = JSON.parse(
					readFileSync(resolve(root, "package.json"), "utf8"),
				);
				const result = spawnSync("/bin/sh", ["-c", scripts.promote], {
					cwd: root,
					env: {
						...gateEnvironment(),
						PATH: `${directory}:${process.env.PATH}`,
						OAUTH_PROMOTION_TEST_LOG: log,
					},
					encoding: "utf8",
					timeout: 10000,
				});
				expect(result.status, result.stderr).toBe(1);
				expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
					"preflight",
					"migration",
				]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("rejects conflicting installed-check options without writing", async () => {
		await backfill();
		for (const args of [
			["--apply"],
			["--check"],
			["--app-url", "https://example.com"],
		]) {
			expect(checkInstalled(args).status).toBe(1);
		}
		expect(await isBetterAuth17Ready(client)).toBe(true);
	});

	it("refuses readiness for incompatible rows even if the triggers are enabled again", async () => {
		const audiences = oauthUpgradeAudiences("https://example.com");
		await backfillBetterAuth17(client, audiences, true);
		await client.query(
			"ALTER TABLE oauth_client DISABLE TRIGGER fabric_oauth_client_compatibility",
		);
		await client.query(
			'UPDATE oauth_client SET "tokenEndpointAuthMethod" = $1 WHERE id = $2',
			["client_secret_basic", "example-native"],
		);
		await client.query(
			"ALTER TABLE oauth_client ENABLE TRIGGER fabric_oauth_client_compatibility",
		);
		expect(await isBetterAuth17Ready(client, audiences)).toBe(false);
		expect(await isBetterAuth17Ready(client)).toBe(false);
	});

	it("refuses readiness if a project grant's stored resources were widened", async () => {
		const audiences = oauthUpgradeAudiences("https://example.com");
		await backfillBetterAuth17(client, audiences, true);
		await client.query(
			"ALTER TABLE oauth_refresh_token DISABLE TRIGGER fabric_oauth_grant_resources",
		);
		await client.query(
			'UPDATE oauth_refresh_token SET "referenceId" = $1',
			["project:api:example-project"],
		);
		await client.query(
			"ALTER TABLE oauth_refresh_token ENABLE TRIGGER fabric_oauth_grant_resources",
		);
		expect(await isBetterAuth17Ready(client, audiences)).toBe(false);
	});

	it.each([
		[
			"Cursor",
			[
				"cursor://anysphere.cursor-mcp/oauth/callback",
				"https://www.cursor.com/agents/mcp/oauth/callback",
				"http://localhost:8787/callback",
			],
		],
		["legacy Cursor", ["cursor://anysphere.cursor-mcp/oauth/callback"]],
	])(
		"accepts the %s native registration, with the migration's function applied",
		async (_client, redirectUris) => {
			await backfill();
			await client.query(readFileSync(cursorMigrationPath, "utf8"));
			await register("example-cursor", {
				public: null,
				type: null,
				applicationType: "native",
				redirectUris,
			});
			expect(
				(
					await client.query(
						'SELECT public, type, "applicationType" FROM oauth_client WHERE id = $1',
						["example-cursor"],
					)
				).rows[0],
			).toEqual({
				public: true,
				type: "native",
				applicationType: "native",
			});
		},
	);

	it("accepts Cursor's callback from the installer script alone", async () => {
		await backfill();
		await register("example-cursor", {
			redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
		});
	});

	it("applies as the table owner when another role owns the installed function", async () => {
		await backfill();
		const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
		const installer = `oauth_installer_${suffix}`;
		const migrator = `oauth_migrator_${suffix}`;
		await client.query(
			`CREATE ROLE "${installer}" NOLOGIN; CREATE ROLE "${migrator}" NOLOGIN`,
		);
		try {
			// Staging's shape: a person ran the installer, while the migration
			// role owns the table. The first version of this migration replaced
			// the function and failed there with exactly this error.
			await client.query(
				`ALTER FUNCTION fabric_oauth_client_compatibility() OWNER TO "${installer}"`,
			);
			await client.query(
				`ALTER TABLE oauth_client OWNER TO "${migrator}"`,
			);
			await client.query(
				`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${migrator}"`,
			);
			await client.query(`SET ROLE "${migrator}"`);
			await expect(
				client.query(
					"CREATE OR REPLACE FUNCTION fabric_oauth_client_compatibility() RETURNS trigger AS $$BEGIN RETURN NEW; END$$ LANGUAGE plpgsql",
				),
			).rejects.toThrow("must be owner of function");
			await client.query(readFileSync(cursorMigrationPath, "utf8"));
			await client.query("RESET ROLE");

			expect(
				(
					await client.query(
						"SELECT tgfoid::regprocedure::text AS fn, tgenabled FROM pg_trigger WHERE tgname = 'fabric_oauth_client_compatibility' AND tgrelid = 'oauth_client'::regclass",
					)
				).rows,
			).toEqual([
				{
					fn: "fabric_oauth_client_compatibility_v2()",
					tgenabled: "O",
				},
			]);
			expect(await isBetterAuth17Ready(client)).toBe(true);
			await register("example-cursor", {
				public: null,
				type: null,
				applicationType: "native",
				redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
			});
			await expect(
				register("example-unknown", {
					redirectUris: ["cursor://evil.example/callback"],
				}),
			).rejects.toThrow("Unsupported OAuth client shape");
		} finally {
			await client.query("RESET ROLE");
			await client.query(
				`REASSIGN OWNED BY "${installer}", "${migrator}" TO CURRENT_USER`,
			);
			await client.query(`DROP OWNED BY "${installer}", "${migrator}"`);
			await client.query(`DROP ROLE "${installer}", "${migrator}"`);
		}
	});

	it("installs no trigger where the installer never ran", async () => {
		await client.query(readFileSync(cursorMigrationPath, "utf8"));
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid = 'oauth_client'::regclass AND NOT tgisinternal",
				)
			).rows[0].count,
		).toBe(0);
	});

	it.each([
		{ type: "user-agent-based" },
		{ type: "web" },
		{ public: false },
		{ tokenEndpointAuthMethod: null },
		{ clientSecret: "example-secret" },
		{ grantTypes: ["client_credentials"] },
		{ skipConsent: true },
		{ type: null, redirectUris: ["http://example.com/callback"] },
		{ redirectUris: ["com.example.agent://callback"] },
		{ redirectUris: ["cursor://evil.example/callback"] },
		{ redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback/"] },
		{ redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback?x=1"] },
		{
			applicationType: "web",
			type: null,
			redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
		},
		{ redirectUris: ["http://localhost.example.com/callback"] },
		{ redirectUris: ["http://127.1:4000/callback"] },
		{ redirectUris: ["http://127.0.0.1:4000/callback#fragment"] },
		{ redirectUris: ["http://user@127.0.0.1:4000/callback"] },
		{
			applicationType: "web",
			type: null,
			redirectUris: ["https://user@example.com/callback"],
		},
		{
			applicationType: "web",
			type: null,
			redirectUris: ["https://localhost?callback=1"],
		},
		{
			applicationType: "web",
			type: null,
			redirectUris: ["https://[::1]/callback"],
		},
		{
			applicationType: "web",
			type: null,
			redirectUris: ["https://[0:0:0:0:0:0:0:1]/callback"],
		},
		{ redirectUris: [] },
	])("rejects an unknown post-backfill shape: %j", async (extra) => {
		await backfill();
		await expect(register("example-unknown", extra)).rejects.toThrow(
			"Unsupported OAuth client shape",
		);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_client",
				)
			).rows[0].count,
		).toBe(2);
	});

	it("rolls back the complete backfill when one pre-existing client is unknown", async () => {
		await register("example-unknown", { type: "user-agent-based" });
		await expect(backfill()).rejects.toThrow(
			"Unsupported OAuth client shape",
		);
		expect(
			(
				await client.query(
					'SELECT count(*)::int AS count FROM oauth_client WHERE "applicationType" IS NOT NULL',
				)
			).rows[0].count,
		).toBe(0);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid = 'oauth_client'::regclass AND NOT tgisinternal",
				)
			).rows[0].count,
		).toBe(0);
	});

	it("enforces resource links by client id and resource identifier with cascade deletion", async () => {
		await client.query(
			`INSERT INTO oauth_resource (id, identifier, name) VALUES ('example-resource-row', 'https://example.com/mcp', 'Example MCP')`,
		);
		await client.query(
			`INSERT INTO oauth_client_resource (id, "clientId", "resourceId") VALUES ('example-link', 'example-native', 'https://example.com/mcp')`,
		);
		await expect(
			client.query(
				`INSERT INTO oauth_client_resource (id, "clientId", "resourceId") VALUES ('example-duplicate', 'example-native', 'https://example.com/mcp')`,
			),
		).rejects.toThrow();
		await client.query(
			"DELETE FROM oauth_resource WHERE id = 'example-resource-row'",
		);
		expect(
			(
				await client.query(
					"SELECT count(*)::int AS count FROM oauth_client_resource",
				)
			).rows[0].count,
		).toBe(0);
	});
});

describe("OAuth client compatibility function", () => {
	const functionPattern =
		/CREATE OR REPLACE FUNCTION fabric_oauth_client_compatibility\(\)[\s\S]*?\$function\$ LANGUAGE plpgsql;/;
	const migrationFunctionPattern =
		/CREATE OR REPLACE FUNCTION fabric_oauth_client_compatibility_v2\(\)[\s\S]*?\$function\$ LANGUAGE plpgsql;/;

	it("is the same in the installer script and the migration's copy", () => {
		const fromScript = readFileSync(backfillPath, "utf8").match(
			functionPattern,
		)?.[0];
		const fromMigration = readFileSync(cursorMigrationPath, "utf8")
			.match(migrationFunctionPattern)?.[0]
			?.replace(
				"fabric_oauth_client_compatibility_v2()",
				"fabric_oauth_client_compatibility()",
			);
		expect(fromScript).toBeDefined();
		expect(fromMigration).toBe(fromScript);
	});

	it("allows exactly one pre-RFC 8252 callback, matched in full", () => {
		const body = readFileSync(backfillPath, "utf8").match(
			functionPattern,
		)?.[0];
		expect(body).toContain(
			"redirect_uri = 'cursor://anysphere.cursor-mcp/oauth/callback'",
		);
		expect(body?.match(/cursor:\/\//g)).toHaveLength(1);
	});
});

describe("OAuth upgrade URL input", () => {
	it.each([
		"ftp://example.com",
		"https://example.com/path",
		"https://user@example.com",
		"https://example.com?query",
		"https://example.com#fragment",
	])(
		"refuses an origin that does not match application resource configuration: %s",
		(url) => {
			expect(() => oauthUpgradeAudiences(url)).toThrow();
		},
	);
});
