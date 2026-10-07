/**
 * Migration test for `20261006200100_mcp_oauth_binding_backfill`.
 *
 * Runs the migration's actual SQL (read from disk) against fixture rows and
 * pins what it may bind:
 * - a credential-holding config on a system server whose grant-time token
 *   endpoint is the allowlisted one for its key is bound, keeping its own
 *   Atlassian host;
 * - everything else holding a token — a custom server, a cache naming another
 *   endpoint, no cache at all for a discovered server, a catalog row that no
 *   longer matches — stays unbound and is flagged for reconnect;
 * - configs without tokens and non-OAuth configs are left alone;
 * - every binding carries `credentialFingerprint`, written by the SAME
 *   statement that writes the binding (checked right after that statement,
 *   before any other runs), equal to what the application computes for the
 *   stored columns — null columns, empty strings, separators and multi-byte
 *   UTF-8 included.
 *
 * - a write that lands on a row while the binding statement waits for it
 *   (the previous app version replacing a credential during the deploy) is
 *   never fingerprinted: the row is skipped, stays unbound and is flagged.
 *
 * Isolation: the serial cases run inside one transaction that creates a
 * scratch schema holding just the columns the backfill reads and writes,
 * points `search_path` at it, and rolls back. The interleaving case needs
 * two connections, so its scratch schema is committed and dropped afterwards.
 * No real table is read or written.
 *
 * Environment gate: needs a reachable Postgres (`DATABASE_URL`), like the
 * other migration replays in this folder; CI's placeholder URL skips it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { credentialFingerprint } from "../../prisma/queries/lib/mcp-oauth-binding";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";

const SHOULD_RUN = hasReachableDatabaseUrl();

const MIGRATION_SQL_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../prisma/migrations/20261006200100_mcp_oauth_binding_backfill/migration.sql",
);

/** The migration's statements: comments dropped, split on `;`. */
function migrationStatements(): string[] {
	const sql = readFileSync(MIGRATION_SQL_PATH, "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n");
	return sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

class Rollback extends Error {}

type Credentials = {
	oauthClientId: string | null;
	encryptedOauthClientSecret: string | null;
	encryptedRefreshToken: string | null;
};

type Row = Credentials & {
	id: string;
	needsReauth: boolean;
	binding: Record<string, unknown> | null;
};

/**
 * Credential sets chosen to break a naive encoding, each on a config the
 * backfill binds (a Notion token at its allowlisted endpoint).
 */
const CREDENTIAL_SETS: Array<[string, Credentials]> = [
	[
		"fp-plain",
		{
			oauthClientId: "client-1",
			encryptedOauthClientSecret: "v1:iv:secret",
			encryptedRefreshToken: "v1:iv:refresh",
		},
	],
	[
		"fp-public-client",
		{
			oauthClientId: "public-client",
			encryptedOauthClientSecret: null,
			encryptedRefreshToken: null,
		},
	],
	[
		"fp-empty-strings",
		{
			oauthClientId: "",
			encryptedOauthClientSecret: "",
			encryptedRefreshToken: "",
		},
	],
	[
		"fp-separators",
		{
			oauthClientId: "a|b",
			encryptedOauthClientSecret: "3:x|-",
			encryptedRefreshToken: "-",
		},
	],
	[
		"fp-multibyte",
		{
			oauthClientId: "clïent-é漢字",
			encryptedOauthClientSecret: "sécret-🔑",
			encryptedRefreshToken: "ü",
		},
	],
];

const sqlLiteral = (value: string | null) =>
	value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;

type Backfill = {
	/** The rows right after the first statement (the binding UPDATE). */
	afterBind: Map<string, Row>;
	/** The rows after the whole migration. */
	rows: Map<string, Row>;
	statementCount: number;
};

async function runBackfill(): Promise<Map<string, Row>> {
	return (await runBackfillStages()).rows;
}

async function runBackfillStages(): Promise<Backfill> {
	const { db } = await import("../../prisma/client");
	const schema = `mig_mcp_oauth_${process.pid}_${Date.now()}`;
	let rows = new Map<string, Row>();
	let afterBind = new Map<string, Row>();
	let statementCount = 0;
	try {
		await db.$transaction(async (tx) => {
			const exec = (sql: string) => tx.$executeRawUnsafe(sql);
			await exec(`CREATE SCHEMA "${schema}"`);
			await exec(`SET LOCAL search_path TO "${schema}"`);
			await exec(`CREATE TABLE "mcp_server" (
				"id" text PRIMARY KEY,
				"key" text NOT NULL,
				"isSystemProvided" boolean NOT NULL,
				"oauthTokenEndpoint" text,
				"oauthAuthorizationEndpoint" text
			)`);
			await exec(`CREATE TABLE "mcp_config" (
				"id" text PRIMARY KEY,
				"mcpServerId" text NOT NULL,
				"authType" text NOT NULL,
				"oauthClientId" text,
				"encryptedOauthClientSecret" text,
				"encryptedAccessToken" text,
				"encryptedRefreshToken" text,
				"oauthMetadataCache" jsonb,
				"oauthBinding" jsonb,
				"needsReauth" boolean NOT NULL DEFAULT false,
				"lastRefreshError" text
			)`);
			await exec(`INSERT INTO "mcp_server" VALUES
				('s-github', 'github-remote', true, 'https://github.com/login/oauth/access_token', 'https://github.com/login/oauth/authorize'),
				('s-github-moved', 'github-remote', true, 'https://evil.example.com/token', NULL),
				('s-notion', 'notion-remote', true, NULL, NULL),
				('s-atlassian', 'atlassian', true, NULL, NULL),
				('s-google', 'google-drive', true, NULL, NULL),
				('s-custom-gitlab', 'my-gitlab', false, NULL, NULL),
				('s-custom-notion', 'notion-remote', false, NULL, NULL)`);
			await exec(`INSERT INTO "mcp_config"
				("id", "mcpServerId", "authType", "encryptedAccessToken", "encryptedRefreshToken", "oauthMetadataCache") VALUES
				('github', 's-github', 'OAUTH2', 'a', 'r', NULL),
				('github-cache-elsewhere', 's-github', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://evil.example.com/token"}'),
				('github-catalog-moved', 's-github-moved', 'OAUTH2', 'a', 'r', NULL),
				('notion-snake', 's-notion', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://mcp.notion.com/token","authorization_endpoint":"https://mcp.notion.com/authorize","registration_endpoint":"https://mcp.notion.com/register","scopes_supported":["default"]}'),
				('notion-camel', 's-notion', 'OAUTH2', 'a', NULL, '{"tokenEndpoint":"https://mcp.notion.com/token","authorizationServer":"https://mcp.notion.com"}'),
				('notion-no-cache', 's-notion', 'OAUTH2', 'a', 'r', NULL),
				('notion-elsewhere', 's-notion', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://evil.example.com/token"}'),
				('atlassian-cf', 's-atlassian', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://cf.mcp.atlassian.com/v1/token"}'),
				('atlassian-mcp', 's-atlassian', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://mcp.atlassian.com/v1/token"}'),
				('google', 's-google', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://oauth2.googleapis.com/token"}'),
				('custom-gitlab', 's-custom-gitlab', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://gitlab.com/oauth/token"}'),
				('custom-notion', 's-custom-notion', 'OAUTH2', 'a', 'r', '{"token_endpoint":"https://mcp.notion.com/token"}'),
				('no-tokens', 's-notion', 'OAUTH2', NULL, NULL, '{"token_endpoint":"https://mcp.notion.com/token"}'),
				('api-key-leftover', 's-custom-gitlab', 'API_KEY', 'a', 'r', NULL)`);

			// A client on the GitHub row, and one config per credential set.
			await exec(`UPDATE "mcp_config"
				SET "oauthClientId" = 'gh-client', "encryptedOauthClientSecret" = 'gh-secret'
				WHERE "id" = 'github'`);
			for (const [id, credentials] of CREDENTIAL_SETS) {
				await exec(`INSERT INTO "mcp_config"
					("id", "mcpServerId", "authType", "oauthClientId", "encryptedOauthClientSecret", "encryptedAccessToken", "encryptedRefreshToken", "oauthMetadataCache")
					VALUES (${sqlLiteral(id)}, 's-notion', 'OAUTH2',
						${sqlLiteral(credentials.oauthClientId)},
						${sqlLiteral(credentials.encryptedOauthClientSecret)},
						'access',
						${sqlLiteral(credentials.encryptedRefreshToken)},
						'{"token_endpoint":"https://mcp.notion.com/token"}')`);
			}

			const read = async () => {
				const result = await tx.$queryRawUnsafe<
					Array<
						Credentials & {
							id: string;
							needsReauth: boolean;
							oauthBinding: Record<string, unknown> | null;
						}
					>
				>(
					`SELECT "id", "needsReauth", "oauthBinding", "oauthClientId", "encryptedOauthClientSecret", "encryptedRefreshToken" FROM "mcp_config"`,
				);
				return new Map(
					result.map((row) => [
						row.id,
						{
							id: row.id,
							needsReauth: row.needsReauth,
							binding: row.oauthBinding,
							oauthClientId: row.oauthClientId,
							encryptedOauthClientSecret:
								row.encryptedOauthClientSecret,
							encryptedRefreshToken: row.encryptedRefreshToken,
						},
					]),
				);
			};

			const statements = migrationStatements();
			statementCount = statements.length;
			for (const [index, statement] of statements.entries()) {
				await exec(statement);
				if (index === 0) {
					afterBind = await read();
				}
			}
			rows = await read();
			throw new Rollback();
		});
	} catch (error) {
		if (!(error instanceof Rollback)) {
			throw error;
		}
	}
	return { afterBind, rows, statementCount };
}

describe.skipIf(!SHOULD_RUN)("mcp_oauth_binding_backfill migration", () => {
	it("binds only proven associations and flags every other credential for reconnect", async () => {
		const rows = await runBackfill();
		const bound = (id: string) => rows.get(id)?.binding;

		expect(bound("github")).toMatchObject({
			authorizationServerUrl: "https://github.com/login/oauth",
			tokenEndpoint: "https://github.com/login/oauth/access_token",
			source: "backfill",
			authorizationServerMetadata: {
				token_endpoint: "https://github.com/login/oauth/access_token",
				authorization_endpoint:
					"https://github.com/login/oauth/authorize",
			},
		});
		expect(bound("notion-snake")).toMatchObject({
			authorizationServerUrl: "https://mcp.notion.com",
			tokenEndpoint: "https://mcp.notion.com/token",
			authorizationServerMetadata: {
				token_endpoint: "https://mcp.notion.com/token",
				authorization_endpoint: "https://mcp.notion.com/authorize",
				registration_endpoint: "https://mcp.notion.com/register",
				scopes_supported: ["default"],
			},
		});
		expect(bound("notion-camel")).toMatchObject({
			tokenEndpoint: "https://mcp.notion.com/token",
		});
		// Each Atlassian host keeps its own authorization server.
		expect(bound("atlassian-cf")).toMatchObject({
			authorizationServerUrl: "https://cf.mcp.atlassian.com",
			tokenEndpoint: "https://cf.mcp.atlassian.com/v1/token",
		});
		expect(bound("atlassian-mcp")).toMatchObject({
			authorizationServerUrl: "https://mcp.atlassian.com",
			tokenEndpoint: "https://mcp.atlassian.com/v1/token",
		});
		expect(bound("google")).toMatchObject({
			authorizationServerUrl: "https://accounts.google.com",
			tokenEndpoint: "https://oauth2.googleapis.com/token",
		});
		for (const id of [
			"github",
			"notion-snake",
			"notion-camel",
			"atlassian-cf",
			"atlassian-mcp",
			"google",
		]) {
			expect(rows.get(id)?.needsReauth, id).toBe(false);
			expect(typeof bound(id)?.boundAt, id).toBe("string");
		}

		for (const id of [
			"github-cache-elsewhere",
			"github-catalog-moved",
			"notion-no-cache",
			"notion-elsewhere",
			"custom-gitlab",
			"custom-notion",
		]) {
			expect(bound(id), id).toBeNull();
			expect(rows.get(id)?.needsReauth, id).toBe(true);
		}

		// No credential, or not an OAuth config: untouched.
		expect(bound("no-tokens")).toBeNull();
		expect(rows.get("no-tokens")?.needsReauth).toBe(false);
		expect(bound("api-key-leftover")).toBeNull();
		expect(rows.get("api-key-leftover")?.needsReauth).toBe(false);
	});

	it("produces bindings the application reads as bound", async () => {
		const { parseMcpOAuthBinding } = await import(
			"../../prisma/queries/lib/mcp-oauth-binding"
		);
		const rows = await runBackfill();
		for (const id of ["github", "notion-snake", "atlassian-cf", "google"]) {
			const parsed = parseMcpOAuthBinding(rows.get(id)?.binding);
			expect(parsed, id).not.toBeNull();
			expect(parsed?.authorizationServerMetadata.token_endpoint).toBe(
				parsed?.tokenEndpoint,
			);
		}
	});
	it("fingerprints each binding in the same statement that writes it, exactly as the application does", async () => {
		const { afterBind, rows, statementCount } = await runBackfillStages();

		// Two statements: the binding UPDATE, then the reconnect flag.
		expect(statementCount).toBe(2);
		const bound = [...rows.values()].filter((row) => row.binding);
		expect(bound.length).toBeGreaterThan(CREDENTIAL_SETS.length);
		for (const row of bound) {
			const expected = credentialFingerprint({
				oauthClientId: row.oauthClientId,
				encryptedOauthClientSecret: row.encryptedOauthClientSecret,
				encryptedRefreshToken: row.encryptedRefreshToken,
			});
			// Already there once the binding statement alone has run…
			expect(
				afterBind.get(row.id)?.binding?.credentialFingerprint,
				row.id,
			).toBe(expected);
			// …and unchanged by the rest of the migration.
			expect(row.binding?.credentialFingerprint, row.id).toBe(expected);
		}
		for (const [id, credentials] of CREDENTIAL_SETS) {
			// The row really holds the fixture values (nothing coerced).
			expect(rows.get(id), id).toMatchObject(credentials);
			expect(rows.get(id)?.binding?.source, id).toBe("backfill");
		}
		expect(rows.get("github")?.binding?.credentialFingerprint).toBe(
			credentialFingerprint({
				oauthClientId: "gh-client",
				encryptedOauthClientSecret: "gh-secret",
				encryptedRefreshToken: "r",
			}),
		);
		// Distinct sets, distinct fingerprints.
		const fingerprints = CREDENTIAL_SETS.map(
			([id]) => rows.get(id)?.binding?.credentialFingerprint,
		);
		expect(new Set(fingerprints).size).toBe(CREDENTIAL_SETS.length);
	});
	it("skips a row whose credentials change while the binding statement waits for it", async () => {
		const { db } = await import("../../prisma/client");
		const schema = `mig_mcp_oauth_race_${process.pid}_${Date.now()}`;
		const inSchema = async (tx: {
			$executeRawUnsafe: (sql: string) => Promise<unknown>;
		}) => {
			await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
		};
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let locked: () => void = () => {};
		const lockHeld = new Promise<void>((resolve) => {
			locked = resolve;
		});
		try {
			await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
			await db.$transaction(async (tx) => {
				await inSchema(tx);
				await tx.$executeRawUnsafe(`CREATE TABLE "mcp_server" (
					"id" text PRIMARY KEY,
					"key" text NOT NULL,
					"isSystemProvided" boolean NOT NULL,
					"oauthTokenEndpoint" text,
					"oauthAuthorizationEndpoint" text
				)`);
				await tx.$executeRawUnsafe(`CREATE TABLE "mcp_config" (
					"id" text PRIMARY KEY,
					"mcpServerId" text NOT NULL,
					"authType" text NOT NULL,
					"oauthClientId" text,
					"encryptedOauthClientSecret" text,
					"encryptedAccessToken" text,
					"encryptedRefreshToken" text,
					"oauthMetadataCache" jsonb,
					"oauthBinding" jsonb,
					"needsReauth" boolean NOT NULL DEFAULT false,
					"lastRefreshError" text
				)`);
				await tx.$executeRawUnsafe(`INSERT INTO "mcp_server" VALUES
					('s-notion', 'notion-remote', true, NULL, NULL)`);
				await tx.$executeRawUnsafe(`INSERT INTO "mcp_config"
					("id", "mcpServerId", "authType", "oauthClientId", "encryptedOauthClientSecret", "encryptedAccessToken", "encryptedRefreshToken", "oauthMetadataCache") VALUES
					('raced', 's-notion', 'OAUTH2', 'client-1', 'secret-1', 'access', 'refresh-1', '{"token_endpoint":"https://mcp.notion.com/token"}'),
					('untouched', 's-notion', 'OAUTH2', 'client-2', 'secret-2', 'access', 'refresh-2', '{"token_endpoint":"https://mcp.notion.com/token"}')`);
			});

			// The previous app version replaces the secret on 'raced' and holds
			// the row until the binding statement is waiting for it.
			const legacyWrite = db.$transaction(
				async (tx) => {
					await inSchema(tx);
					await tx.$executeRawUnsafe(
						`UPDATE "mcp_config" SET "encryptedOauthClientSecret" = 'secret-from-elsewhere' WHERE "id" = 'raced'`,
					);
					locked();
					await released;
				},
				{ timeout: 30_000 },
			);
			await lockHeld;

			const [bind, flag] = migrationStatements();
			const migration = db.$transaction(
				async (tx) => {
					await inSchema(tx);
					await tx.$executeRawUnsafe(bind ?? "");
					await tx.$executeRawUnsafe(flag ?? "");
				},
				{ timeout: 30_000 },
			);

			// Release the legacy write only once the binding statement is
			// blocked on its row lock.
			for (let attempt = 0; attempt < 200; attempt++) {
				const waiting = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
					`SELECT count(*) AS n FROM pg_stat_activity
					  WHERE wait_event_type = 'Lock'
					    AND query LIKE '%"allowlist"%'`,
				);
				if (Number(waiting[0]?.n ?? 0) > 0) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
				if (attempt === 199) {
					throw new Error("the binding statement never waited");
				}
			}
			release();
			await legacyWrite;
			await migration;

			const rows = await db.$queryRawUnsafe<
				Array<{
					id: string;
					needsReauth: boolean;
					oauthBinding: Record<string, unknown> | null;
				}>
			>(
				`SELECT "id", "needsReauth", "oauthBinding" FROM "${schema}"."mcp_config" ORDER BY "id"`,
			);
			const raced = rows.find((row) => row.id === "raced");
			const untouched = rows.find((row) => row.id === "untouched");
			// Never signed with the secret written in between: unbound, and
			// sent back through reconnect.
			expect(raced?.oauthBinding).toBeNull();
			expect(raced?.needsReauth).toBe(true);
			// The row nobody touched is bound as usual.
			expect(untouched?.oauthBinding?.credentialFingerprint).toBe(
				credentialFingerprint({
					oauthClientId: "client-2",
					encryptedOauthClientSecret: "secret-2",
					encryptedRefreshToken: "refresh-2",
				}),
			);
		} finally {
			release();
			await db.$executeRawUnsafe(
				`DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
			);
		}
	}, 60_000);
});
