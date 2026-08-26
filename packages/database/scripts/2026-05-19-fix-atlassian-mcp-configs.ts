/**
 * One-shot data migration: clear stale Atlassian DCR credentials.
 *
 * The 2026-05-19 Atlassian MCP OAuth fix re-targeted OAuth discovery from
 * `auth.atlassian.com` (SSO) to `mcp.atlassian.com` (the Rovo MCP authorization
 * server). Existing `MCPConfig` rows for the Atlassian server may carry:
 *   - the deprecated `baseUrl` `https://mcp.atlassian.com/v1/sse`
 *   - a `client_id` issued by the wrong (`auth.atlassian.com`) server
 *   - DCR registration metadata pinning the wrong endpoint
 * All of these are unusable against the corrected discovery URL.
 *
 * This script clears those fields so the next OAuth-start invocation runs DCR
 * cleanly against `cf.mcp.atlassian.com/v1/register` and produces a working
 * client_id/secret. Tokens are deliberately preserved — if any user actually
 * received a token from the wrong server, it'll 401 on use and the existing
 * `lastRefreshError` / `needsReauth` machinery surfaces "Reconnect".
 *
 * Filter: strictly `mcpServer.key = "atlassian"`. No other server is touched.
 *
 * Idempotent: the `findMany` WHERE clause is OR-keyed on the same fields the
 * script nulls, so a row touched by a previous run no longer matches. A
 * conditional `updateMany({ where: { id, oauthClientId } })` guards against
 * the race where a successful concurrent OAuth dance just wrote a new
 * `oauthClientId`.
 *
 * In-flight `MCPOAuthState` rows tied to these configs are deleted: any
 * mid-flow attempt would land on the callback with a freshly-cleared
 * `cfg.oauthClientId` anyway, and the state TTL is 10 minutes — users retry
 * cleanly.
 *
 * Run with: pnpm --filter @repo/database tsx scripts/2026-05-19-fix-atlassian-mcp-configs.ts [--dry-run]
 *
 * Design doc: docs/superpowers/specs/2026-05-19-atlassian-mcp-oauth-fix-design.md §5.3
 */

import { pathToFileURL } from "node:url";
import { db } from "../prisma/client";
import { Prisma } from "../prisma/generated/client";

const LEGACY_BASE_URL = "https://mcp.atlassian.com/v1/sse";
// Endpoint issued by the post-fix discovery (`mcp.atlassian.com`). Rows whose
// `dcrRegistrationEndpoint` already equals this value are already on the new
// authorization server and must NOT be cleared by a re-run of this migration.
const NEW_DCR_ENDPOINT = "https://cf.mcp.atlassian.com/v1/register";

export interface RunOptions {
	dryRun: boolean;
}

export interface RunResult {
	candidates: number;
	cleared: number;
	raced: number;
	oauthStatesRevoked: number;
}

export async function runFixAtlassianMcpConfigs(
	opts: RunOptions,
): Promise<RunResult> {
	const { dryRun } = opts;

	// Filter targets only PRE-FIX rows so the script is safe to re-run after
	// users have re-OAuth'd against the corrected discovery endpoint.
	// Pre-fix rows either still carry the legacy SSE baseUrl or have a DCR
	// registration endpoint that is non-null and not the new
	// `cf.mcp.atlassian.com/v1/register`. Post-fix rows match neither clause.
	const candidates = await db.mCPConfig.findMany({
		where: {
			mcpServer: { key: "atlassian" },
			OR: [
				{ baseUrl: LEGACY_BASE_URL },
				{
					AND: [
						{ dcrRegistrationEndpoint: { not: null } },
						{ dcrRegistrationEndpoint: { not: NEW_DCR_ENDPOINT } },
					],
				},
			],
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
			baseUrl: true,
			oauthClientId: true,
		},
	});

	console.log(`Found ${candidates.length} Atlassian MCPConfig rows to clear`);

	if (dryRun) {
		const sample = candidates.slice(0, 10);
		for (const c of sample) {
			console.log(
				`  would clear ${c.id} (user=${c.userId ?? "—"}, org=${c.organizationId ?? "—"}, baseUrl=${c.baseUrl ?? "—"})`,
			);
		}
		if (candidates.length > sample.length) {
			console.log(
				`  … and ${candidates.length - sample.length} more (not shown)`,
			);
		}
		return {
			candidates: candidates.length,
			cleared: 0,
			raced: 0,
			oauthStatesRevoked: 0,
		};
	}

	let cleared = 0;
	let raced = 0;

	for (const c of candidates) {
		// Conditional update: if a concurrent OAuth-start rewrote
		// `oauthClientId` between our `findMany` and this `update`, the row
		// no longer matches and we leave the fresh credentials alone.
		const result = await db.mCPConfig.updateMany({
			where: { id: c.id, oauthClientId: c.oauthClientId },
			data: {
				baseUrl: null,
				oauthClientId: null,
				encryptedOauthClientSecret: null,
				dcrRegistrationEndpoint: null,
				// Nullable Json columns require Prisma's sentinel — literal
				// `null` doesn't typecheck against `InputJsonValue`.
				dcrClientMetadata: Prisma.DbNull,
				dcrRegisteredAt: null,
				oauthMetadataCache: Prisma.DbNull,
				oauthMetadataCachedAt: null,
			},
		});
		if (result.count === 1) {
			cleared++;
			console.log(
				`  ✓ cleared ${c.id} (user=${c.userId ?? "—"}, org=${c.organizationId ?? "—"})`,
			);
		} else {
			raced++;
			console.log(`  · skipped ${c.id} (raced — concurrent OAuth start)`);
		}
	}

	// Revoke any in-flight OAuth state rows tied to those configs. The
	// callback would fail anyway (oauthClientId is now null), but this avoids
	// surfacing the confused-state error to users mid-flow when they retry.
	let oauthStatesRevoked = 0;
	if (candidates.length > 0) {
		const deleted = await db.mCPOAuthState.deleteMany({
			where: { configId: { in: candidates.map((c) => c.id) } },
		});
		oauthStatesRevoked = deleted.count;
	}

	console.log(
		`Done: ${cleared} cleared, ${raced} skipped (raced), ${oauthStatesRevoked} in-flight OAuth state rows revoked`,
	);

	return {
		candidates: candidates.length,
		cleared,
		raced,
		oauthStatesRevoked,
	};
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	try {
		await runFixAtlassianMcpConfigs({ dryRun });
	} finally {
		await db.$disconnect();
	}
}

// Only fire `main` when invoked directly via tsx, not when imported by tests.
// `pathToFileURL` handles Windows drive letters correctly — naive string
// concatenation drops a slash on Windows and the script never runs.
const entry = process.argv[1];
const invokedDirectly =
	!!entry && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
