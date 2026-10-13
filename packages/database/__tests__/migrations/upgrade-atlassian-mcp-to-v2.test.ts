/**
 * Tests for `20261009130000_upgrade_atlassian_mcp_to_v2` migration SQL:
 * verifies system Atlassian server and OAuth configs are updated to v2
 * while custom servers, non-OAuth configs, and other integrations are preserved.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";

const SHOULD_RUN = hasReachableDatabaseUrl();

const MIGRATION_SQL_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../prisma/migrations/20261009130000_upgrade_atlassian_mcp_to_v2/migration.sql",
);

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

describe("upgrade_atlassian_mcp_to_v2 migration SQL", () => {
	it("migration file exists and contains valid SQL statements with system-server guards", () => {
		const stmts = migrationStatements();
		expect(stmts.length).toBeGreaterThanOrEqual(3);

		// Update system server
		expect(stmts[0]).toContain('UPDATE "mcp_server"');
		expect(stmts[0]).toContain(
			"https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
		);
		expect(stmts[0]).toContain('"isSystemProvided" = true');
		expect(stmts[0]).toContain('"userId" IS NULL');
		expect(stmts[0]).toContain('"organizationId" IS NULL');

		// Delete pending oauth states
		expect(stmts[1]).toContain('DELETE FROM "mcp_oauth_state"');
		expect(stmts[1]).toContain('s."isSystemProvided" = true');
		expect(stmts[1]).toContain('s."userId" IS NULL');
		expect(stmts[1]).toContain('s."organizationId" IS NULL');

		// Reset configs
		expect(stmts[2]).toContain('UPDATE "mcp_config"');
		expect(stmts[2]).toContain("CASE");
		expect(stmts[2]).toContain('s."isSystemProvided" = true');
		expect(stmts[2]).toContain('s."userId" IS NULL');
		expect(stmts[2]).toContain('s."organizationId" IS NULL');
		expect(stmts[2]).toContain("\"authType\" = 'OAUTH2'");
	});

	(SHOULD_RUN ? it : it.skip)(
		"replays against scratch schema and verifies isolation between system and custom servers",
		async () => {
			const { db } = await import("../../prisma/client");
			const schema = `mig_atlassian_v2_${process.pid}_${Date.now()}`;

			try {
				await db.$transaction(async (tx) => {
					const inSchema = async () => {
						await tx.$executeRawUnsafe(
							`SET LOCAL search_path TO "${schema}", public`,
						);
					};

					await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
					await inSchema();

					// Create mock tables without artificially strict constraints (e.g. no UNIQUE on key alone)
					await tx.$executeRawUnsafe(`
						CREATE TABLE "mcp_server" (
							"id" text PRIMARY KEY,
							"key" text NOT NULL,
							"isSystemProvided" boolean NOT NULL DEFAULT false,
							"userId" text,
							"organizationId" text,
							"defaultUrl" text,
							"oauthDiscoveryUrl" text
						)
					`);
					await tx.$executeRawUnsafe(`
						CREATE TABLE "mcp_config" (
							"id" text PRIMARY KEY,
							"mcpServerId" text NOT NULL,
							"authType" text NOT NULL DEFAULT 'OAUTH2',
							"baseUrl" text,
							"scopes" text[] NOT NULL DEFAULT '{}',
							"oauthClientId" text,
							"encryptedOauthClientSecret" text,
							"encryptedAccessToken" text,
							"accessTokenHash" text,
							"encryptedRefreshToken" text,
							"tokenExpiresAt" timestamp(3),
							"oauthBinding" jsonb,
							"oauthMetadataCache" jsonb,
							"oauthMetadataCachedAt" timestamp(3),
							"dcrRegistrationEndpoint" text,
							"dcrClientMetadata" jsonb,
							"dcrRegisteredAt" timestamp(3),
							"cachedTools" jsonb,
							"toolsCachedAt" timestamp(3),
							"toolCount" integer NOT NULL DEFAULT 0,
							"oauthGrantGeneration" integer NOT NULL DEFAULT 0,
							"needsReauth" boolean NOT NULL DEFAULT false
						)
					`);
					await tx.$executeRawUnsafe(`
						CREATE TABLE "mcp_oauth_state" (
							"id" text PRIMARY KEY,
							"configId" text NOT NULL
						)
					`);

					// Seed test servers
					await tx.$executeRawUnsafe(`
						INSERT INTO "mcp_server" ("id", "key", "isSystemProvided", "userId", "organizationId", "defaultUrl", "oauthDiscoveryUrl")
						VALUES
							('srv-atlassian', 'atlassian', true, NULL, NULL, 'https://mcp.atlassian.com/v1/mcp', 'https://mcp.atlassian.com/.well-known/oauth-authorization-server'),
							('srv-custom-atlassian', 'atlassian', false, 'usr-1', 'org-1', 'https://custom.example.com/mcp', NULL),
							('srv-slack', 'slack-remote', true, NULL, NULL, 'https://mcp.slack.com/mcp', NULL)
					`);

					// Seed test configs
					await tx.$executeRawUnsafe(`
						INSERT INTO "mcp_config" (
							"id", "mcpServerId", "authType", "baseUrl", "scopes", "oauthClientId",
							"encryptedAccessToken", "encryptedRefreshToken", "oauthBinding",
							"toolCount", "oauthGrantGeneration", "needsReauth"
						) VALUES
							('cfg-v1', 'srv-atlassian', 'OAUTH2', 'https://mcp.atlassian.com/v1/mcp', ARRAY['read:jira-work'], 'client-v1', 'tok-v1', 'ref-v1', '{"bound": true}'::jsonb, 10, 0, false),
							('cfg-null', 'srv-atlassian', 'OAUTH2', NULL, ARRAY['read:jira-work'], 'client-null', 'tok-null', 'ref-null', '{"bound": true}'::jsonb, 5, 2, false),
							('cfg-custom', 'srv-custom-atlassian', 'OAUTH2', 'https://custom.example.com/mcp', ARRAY['custom:read'], 'client-custom', 'tok-custom', 'ref-custom', '{"bound": true}'::jsonb, 4, 0, false),
							('cfg-non-oauth', 'srv-atlassian', 'API_KEY', 'https://mcp.atlassian.com/v1/mcp', ARRAY['read:jira-work'], 'client-api', 'tok-api', 'ref-api', '{"bound": true}'::jsonb, 2, 0, false),
							('cfg-slack', 'srv-slack', 'OAUTH2', 'https://mcp.slack.com/mcp', ARRAY['channels:read'], 'client-slack', 'tok-slack', 'ref-slack', '{"bound": true}'::jsonb, 3, 0, false)
					`);

					// Seed test oauth states
					await tx.$executeRawUnsafe(`
						INSERT INTO "mcp_oauth_state" ("id", "configId")
						VALUES
							('state-atlassian', 'cfg-v1'),
							('state-custom', 'cfg-custom'),
							('state-slack', 'cfg-slack')
					`);

					// Execute migration statements one-by-one with local search_path set
					for (const stmt of migrationStatements()) {
						await inSchema();
						await tx.$executeRawUnsafe(stmt);
					}

					await inSchema();

					// Verify mcp_server updates
					const servers = (await tx.$queryRawUnsafe(`
						SELECT "id", "key", "defaultUrl", "oauthDiscoveryUrl"
						FROM "mcp_server" ORDER BY "id"
					`)) as Array<{
						id: string;
						key: string;
						defaultUrl: string | null;
						oauthDiscoveryUrl: string | null;
					}>;

					const systemServer = servers.find(
						(s) => s.id === "srv-atlassian",
					);
					expect(systemServer).toBeDefined();
					expect(systemServer?.defaultUrl).toBe(
						"https://mcp.atlassian.com/v2/mcp?tools=all",
					);
					expect(systemServer?.oauthDiscoveryUrl).toBe(
						"https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
					);

					// Custom server with key='atlassian' is untouched
					const customServer = servers.find(
						(s) => s.id === "srv-custom-atlassian",
					);
					expect(customServer).toBeDefined();
					expect(customServer?.defaultUrl).toBe(
						"https://custom.example.com/mcp",
					);
					expect(customServer?.oauthDiscoveryUrl).toBeNull();

					// Verify mcp_config updates
					const configs = (await tx.$queryRawUnsafe(`
						SELECT "id", "baseUrl", "scopes", "oauthClientId", "encryptedAccessToken",
						       "encryptedRefreshToken", "oauthBinding", "toolCount",
						       "oauthGrantGeneration", "needsReauth"
						FROM "mcp_config" ORDER BY "id"
					`)) as Array<{
						id: string;
						baseUrl: string | null;
						scopes: string[];
						oauthClientId: string | null;
						encryptedAccessToken: string | null;
						encryptedRefreshToken: string | null;
						oauthBinding: unknown;
						toolCount: number;
						oauthGrantGeneration: number;
						needsReauth: boolean;
					}>;

					// cfg-v1: reset to v2 and tokens wiped
					const cfgV1 = configs.find((c) => c.id === "cfg-v1");
					expect(cfgV1).toBeDefined();
					expect(cfgV1?.baseUrl).toBe(
						"https://mcp.atlassian.com/v2/mcp?tools=all",
					);
					expect(cfgV1?.scopes).toEqual([]);
					expect(cfgV1?.oauthClientId).toBeNull();
					expect(cfgV1?.encryptedAccessToken).toBeNull();
					expect(cfgV1?.encryptedRefreshToken).toBeNull();
					expect(cfgV1?.oauthBinding).toBeNull();
					expect(cfgV1?.toolCount).toBe(0);
					expect(cfgV1?.oauthGrantGeneration).toBe(1);
					expect(cfgV1?.needsReauth).toBe(true);

					// cfg-null: reset and tokens wiped; baseUrl preserved as NULL
					const cfgNull = configs.find((c) => c.id === "cfg-null");
					expect(cfgNull).toBeDefined();
					expect(cfgNull?.baseUrl).toBeNull();
					expect(cfgNull?.scopes).toEqual([]);
					expect(cfgNull?.oauthClientId).toBeNull();
					expect(cfgNull?.encryptedAccessToken).toBeNull();
					expect(cfgNull?.oauthBinding).toBeNull();
					expect(cfgNull?.toolCount).toBe(0);
					expect(cfgNull?.oauthGrantGeneration).toBe(3);
					expect(cfgNull?.needsReauth).toBe(true);

					// cfg-custom: custom server config is untouched
					const cfgCustom = configs.find(
						(c) => c.id === "cfg-custom",
					);
					expect(cfgCustom).toBeDefined();
					expect(cfgCustom?.baseUrl).toBe(
						"https://custom.example.com/mcp",
					);
					expect(cfgCustom?.scopes).toEqual(["custom:read"]);
					expect(cfgCustom?.oauthClientId).toBe("client-custom");
					expect(cfgCustom?.encryptedAccessToken).toBe("tok-custom");
					expect(cfgCustom?.encryptedRefreshToken).toBe("ref-custom");
					expect(cfgCustom?.toolCount).toBe(4);
					expect(cfgCustom?.oauthGrantGeneration).toBe(0);
					expect(cfgCustom?.needsReauth).toBe(false);

					// cfg-non-oauth: non-OAUTH2 config is untouched
					const cfgNonOauth = configs.find(
						(c) => c.id === "cfg-non-oauth",
					);
					expect(cfgNonOauth).toBeDefined();
					expect(cfgNonOauth?.oauthClientId).toBe("client-api");
					expect(cfgNonOauth?.encryptedAccessToken).toBe("tok-api");
					expect(cfgNonOauth?.toolCount).toBe(2);
					expect(cfgNonOauth?.oauthGrantGeneration).toBe(0);
					expect(cfgNonOauth?.needsReauth).toBe(false);

					// cfg-slack: unrelated Slack config is untouched
					const cfgSlack = configs.find((c) => c.id === "cfg-slack");
					expect(cfgSlack).toBeDefined();
					expect(cfgSlack?.baseUrl).toBe("https://mcp.slack.com/mcp");
					expect(cfgSlack?.oauthClientId).toBe("client-slack");
					expect(cfgSlack?.encryptedAccessToken).toBe("tok-slack");
					expect(cfgSlack?.needsReauth).toBe(false);

					// Only state-atlassian removed; state-custom & state-slack preserved
					const states = (await tx.$queryRawUnsafe(`
						SELECT "id" FROM "mcp_oauth_state" ORDER BY "id"
					`)) as Array<{ id: string }>;
					expect(states.map((s) => s.id).sort()).toEqual([
						"state-custom",
						"state-slack",
					]);

					throw new Rollback();
				});
			} catch (error) {
				if (!(error instanceof Rollback)) {
					throw error;
				}
			} finally {
				await db.$executeRawUnsafe(
					`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
				);
			}
		},
	);
});
