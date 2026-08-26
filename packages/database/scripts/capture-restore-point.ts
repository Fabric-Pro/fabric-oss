#!/usr/bin/env npx tsx
/**
 * Capture a restore point before a database promotion.
 *
 * Two providers, because the database is moving off Neon:
 *
 *   neon     A copy-on-write branch. Effectively instant and cheap enough to
 *            take on every promotion. Needs NEON_API_KEY + NEON_PROJECT_ID.
 *   pg_dump  A logical dump written to RESTORE_POINT_DIR. Works against any
 *            Postgres, and is the fallback once Neon is gone. Costs real time
 *            and disk in proportion to the database.
 *
 * Provider selection is automatic from whichever credentials are present, and
 * RESTORE_POINT_PROVIDER overrides it when both are configured or when you want
 * to force one.
 *
 * OPT-IN, like the image-signing job: configured with neither, this reports as
 * much and exits 0, so a pipeline that has not adopted it is never blocked. Pass
 * `--require` to invert that and fail closed.
 *
 * Usage:
 *   pnpm --filter @repo/database capture:restore-point
 *   pnpm --filter @repo/database capture:restore-point --require
 */

import { execFile } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

const NEON_API = "https://console.neon.tech/api/v2";

export type Provider = "neon" | "pg_dump";

export interface NeonConfig {
	provider: "neon";
	apiKey: string;
	projectId: string;
}

export interface PgDumpConfig {
	provider: "pg_dump";
	connectionString: string;
	outputDir: string;
}

export type CaptureConfig = NeonConfig | PgDumpConfig;

export type ConfigResult =
	| { configured: true; config: CaptureConfig }
	| { configured: false; reason: string };

/**
 * Picks a provider from what is configured. An explicit RESTORE_POINT_PROVIDER
 * wins, and then reports what that choice is missing rather than silently
 * falling back to the other one — a promotion that asked for a Neon branch and
 * quietly got a dump, or nothing, is worse than one that stops.
 */
export function readConfig(env: NodeJS.ProcessEnv): ConfigResult {
	const requested = env.RESTORE_POINT_PROVIDER?.trim() as
		| Provider
		| undefined;

	const apiKey = env.NEON_API_KEY?.trim();
	const projectId = env.NEON_PROJECT_ID?.trim();
	const outputDir = env.RESTORE_POINT_DIR?.trim();
	const connectionString = env.DIRECT_URL?.trim() || env.DATABASE_URL?.trim();

	const neonReady = Boolean(apiKey && projectId);
	const dumpReady = Boolean(outputDir && connectionString);

	if (requested && requested !== "neon" && requested !== "pg_dump") {
		return {
			configured: false,
			reason: `RESTORE_POINT_PROVIDER is "${requested}"; expected "neon" or "pg_dump".`,
		};
	}

	if (requested === "neon" || (!requested && neonReady)) {
		if (!neonReady) {
			const missing = [
				...(apiKey ? [] : ["NEON_API_KEY"]),
				...(projectId ? [] : ["NEON_PROJECT_ID"]),
			];
			return {
				configured: false,
				reason: `neon selected but missing ${missing.join(", ")}.`,
			};
		}
		return {
			configured: true,
			config: {
				provider: "neon",
				apiKey: apiKey as string,
				projectId: projectId as string,
			},
		};
	}

	if (requested === "pg_dump" || (!requested && dumpReady)) {
		if (!dumpReady) {
			const missing = [
				...(outputDir ? [] : ["RESTORE_POINT_DIR"]),
				...(connectionString ? [] : ["DATABASE_URL or DIRECT_URL"]),
			];
			return {
				configured: false,
				reason: `pg_dump selected but missing ${missing.join(", ")}.`,
			};
		}
		return {
			configured: true,
			config: {
				provider: "pg_dump",
				connectionString: connectionString as string,
				outputDir: outputDir as string,
			},
		};
	}

	return {
		configured: false,
		reason: "no provider configured (set NEON_API_KEY + NEON_PROJECT_ID, or RESTORE_POINT_DIR).",
	};
}

/**
 * Unique per attempt. Two promotions of the same commit — a re-run, a retry
 * after a forward fix — would otherwise collide on a Neon branch name and
 * overwrite each other's dump file.
 */
export function restorePointName(
	sha: string | undefined,
	isoTimestamp: string,
): string {
	const shortSha = (sha ?? "unknown").slice(0, 12);
	const stamp = isoTimestamp.replace(/[:.]/g, "-");
	return `pre-migration-${shortSha}-${stamp}`;
}

export interface CreatedBranch {
	id: string;
	name: string;
}

export function parseBranchResponse(body: unknown): CreatedBranch {
	const branch = (body as { branch?: { id?: unknown; name?: unknown } })
		?.branch;
	if (typeof branch?.id !== "string" || typeof branch?.name !== "string") {
		throw new Error(
			`Neon returned no branch in its response: ${JSON.stringify(body)}`,
		);
	}
	return { id: branch.id, name: branch.name };
}

async function captureNeonBranch(
	config: NeonConfig,
	name: string,
): Promise<string> {
	const response = await fetch(
		`${NEON_API}/projects/${config.projectId}/branches`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			// No parent given: Neon branches from the project's primary branch at the
			// current LSN, which is the pre-migration state we want.
			body: JSON.stringify({ branch: { name } }),
		},
	);

	if (!response.ok) {
		// The body can echo request headers on some errors, so report status only.
		throw new Error(
			`Neon branch creation failed: HTTP ${response.status} ${response.statusText}`,
		);
	}

	const branch = parseBranchResponse(await response.json());
	return `Neon branch ${branch.name} (${branch.id}). Read from it to recover the pre-migration state.`;
}

/**
 * Split a connection string into the PG* variables pg_dump reads.
 *
 * pg_dump takes a URI on the command line too, but argv is world-readable
 * through `ps`, and the password is in it. These go in the environment instead.
 */
export function connectionEnv(
	connectionString: string,
): Record<string, string> {
	const url = new URL(connectionString);
	const env: Record<string, string> = {
		PGHOST: url.hostname,
		PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
	};
	if (url.port) {
		env.PGPORT = url.port;
	}
	if (url.username) {
		env.PGUSER = decodeURIComponent(url.username);
	}
	if (url.password) {
		env.PGPASSWORD = decodeURIComponent(url.password);
	}
	const sslmode = url.searchParams.get("sslmode");
	if (sslmode) {
		env.PGSSLMODE = sslmode;
	}
	return env;
}

/** Major version from `pg_dump (PostgreSQL) 16.14 (Ubuntu ...)` or `17.10 (986efc8)`. */
export function majorVersion(versionText: string): number | undefined {
	const match = /(\d+)\.\d+/.exec(versionText);
	return match ? Number(match[1]) : undefined;
}

/**
 * pg_dump refuses to dump a server newer than itself, and says so only after it
 * has connected. Checking first turns a late, terse abort into an actionable
 * message naming both versions and what to install.
 */
export function checkDumpCompatibility(
	clientVersion: string,
	serverVersion: string,
): void {
	const client = majorVersion(clientVersion);
	const server = majorVersion(serverVersion);
	if (client === undefined || server === undefined) {
		return;
	}
	if (client < server) {
		throw new Error(
			`pg_dump ${client} cannot dump a PostgreSQL ${server} server. Install postgresql-client-${server} on the runner, or set RESTORE_POINT_PROVIDER=neon.`,
		);
	}
}

/**
 * Turn pg_dump's failure into something the reader can act on.
 *
 * The row-level-security refusal is the one worth naming. It reads like a
 * permissions mistake and is not: Postgres refuses because the dump would be
 * filtered, and a filtered dump is a corrupt backup. Only a role with the
 * BYPASSRLS attribute (or a superuser) can produce a complete one — a
 * permissive policy is NOT enough, measured on Postgres 17 (2026-08-19), where
 * a role holding a `USING (true)` policy failed with this exact message.
 *
 * That matters here because managed hosts may grant BYPASSRLS to nobody at all;
 * `apply-rls-direct.ts` records that for this deployment, which is why the
 * worker gets permissive policies instead of the attribute. Where that is true,
 * pg_dump cannot produce a valid restore point and the platform's own snapshot
 * or point-in-time recovery is the mechanism to use.
 */
export type UnprovableTable = { schema: string; table: string; reason: string };

/**
 * Tables this role cannot be *proven* to see in full.
 *
 * pg_dump refuses outright when row-level security applies, because a filtered
 * dump is a corrupt backup. `--enable-row-security` lifts the refusal by
 * dumping only what the role can see, which is the same corruption with the
 * error removed. The flag is safe exactly when the role provably sees every
 * row, and that is what this query establishes — before the dump, not after.
 *
 * A table is unprovable when a RESTRICTIVE policy applies to the role, since
 * those AND-combine and can filter whatever the permissive ones allow, or when
 * no PERMISSIVE policy grants it unconditional visibility (`USING (true)`, or
 * no USING clause at all). Anything the query cannot account for stays
 * unprovable, so the failure mode is a refused capture rather than a quiet one.
 *
 * This is the shape `apply-rls-direct.ts` creates on a managed host, where
 * BYPASSRLS is available to nobody: `fabric_app` and `fabric_worker` reach
 * every row through permissive `USING (true)` policies. Verified on Postgres 17
 * (2026-08-19) against four tables — unconditional policy, narrowed policy,
 * restrictive policy, and no RLS — flagging exactly the middle two, and a dump
 * taken after an empty result containing every row.
 */
const UNPROVABLE_TABLES_SQL = `
WITH visible_roles AS (
  SELECT array_agg(rolname::text) AS names
  FROM pg_roles
  WHERE pg_has_role(current_user, oid, 'USAGE')
),
rls AS (
  SELECT n.nspname AS schema, c.relname AS "table"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND c.relrowsecurity
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
),
applies AS (
  SELECT p.schemaname AS schema, p.tablename AS "table", p.permissive, p.qual
  FROM pg_policies p, visible_roles v
  WHERE (p.roles && ARRAY['public']::name[] OR p.roles && v.names::name[])
    AND p.cmd IN ('ALL', 'SELECT')
),
restrictive AS (
  SELECT schema, "table" FROM applies WHERE permissive = 'RESTRICTIVE'
),
unconditional AS (
  SELECT schema, "table" FROM applies
  WHERE permissive = 'PERMISSIVE' AND (qual IS NULL OR btrim(qual) = 'true')
)
SELECT r.schema, r."table",
  CASE
    WHEN EXISTS (SELECT 1 FROM restrictive x WHERE x.schema = r.schema AND x."table" = r."table")
      THEN 'a restrictive policy applies, which can filter rows'
    ELSE 'no permissive policy grants this role unconditional visibility'
  END AS reason
FROM rls r
WHERE EXISTS (SELECT 1 FROM restrictive x WHERE x.schema = r.schema AND x."table" = r."table")
   OR NOT EXISTS (SELECT 1 FROM unconditional u WHERE u.schema = r.schema AND u."table" = r."table")
ORDER BY 1, 2
`;

/**
 * Superuser is checked alongside the attribute because a superuser bypasses RLS
 * whether or not it carries BYPASSRLS — `ALTER ROLE x SUPERUSER NOBYPASSRLS` is
 * legal, and reading the attribute alone would refuse a capture that would in
 * fact have been complete.
 */
async function roleBypassesRls(client: Client): Promise<boolean> {
	const { rows } = await client.query<{ bypasses: boolean | null }>(
		"SELECT (rolsuper OR rolbypassrls) AS bypasses FROM pg_roles WHERE rolname = current_user",
	);
	return rows[0]?.bypasses === true;
}

async function findUnprovableTables(
	client: Client,
): Promise<UnprovableTable[]> {
	const { rows } = await client.query<UnprovableTable>(UNPROVABLE_TABLES_SQL);
	return rows;
}

export function describeUnprovable(tables: UnprovableTable[]): string {
	const listed = tables
		.slice(0, 10)
		.map((t) => `  ${t.schema}.${t.table} — ${t.reason}`)
		.join("\n");
	const more =
		tables.length > 10 ? `\n  ...and ${tables.length - 10} more` : "";
	return (
		"Refusing to capture a restore point: this role cannot be proven to see every row, " +
		"so the dump could silently omit data.\n" +
		`${listed}${more}\n` +
		"Fix by dumping as a role with the BYPASSRLS attribute, by giving this role an " +
		"unconditional permissive policy on those tables, or by using the database platform's " +
		"own snapshot / point-in-time recovery."
	);
}

export function explainDumpFailure(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	if (/row-level security policy/i.test(text)) {
		return (
			"pg_dump cannot produce a complete dump with this connection: the role is subject to " +
			"row-level security, so Postgres refuses rather than write a filtered — that is, corrupt — " +
			"backup. Point the capture at a role with the BYPASSRLS attribute, or use the database " +
			"platform's own snapshot / point-in-time recovery. A permissive policy does not substitute " +
			"for the attribute, and --enable-row-security silently drops rows. " +
			`Original error: ${text}`
		);
	}
	return text;
}

async function capturePgDump(
	config: PgDumpConfig,
	name: string,
): Promise<string> {
	// A missing client otherwise surfaces as a bare ENOENT from execFile, which
	// reads like the database is unreachable rather than like a runner without
	// postgresql-client installed.
	let clientVersion: string;
	try {
		clientVersion = (await execFileAsync("pg_dump", ["--version"])).stdout;
	} catch {
		throw new Error(
			"pg_dump is not on PATH. Install postgresql-client on the runner, or set RESTORE_POINT_PROVIDER=neon.",
		);
	}

	const probe = new Client({ connectionString: config.connectionString });
	let bypassesRls: boolean;
	let unprovable: UnprovableTable[];
	await probe.connect();
	try {
		const { rows } = await probe.query<{ server_version: string }>(
			"SHOW server_version",
		);
		checkDumpCompatibility(clientVersion, rows[0]?.server_version ?? "");
		bypassesRls = await roleBypassesRls(probe);
		unprovable = bypassesRls ? [] : await findUnprovableTables(probe);
	} finally {
		await probe.end();
	}

	if (unprovable.length > 0) {
		throw new Error(describeUnprovable(unprovable));
	}

	mkdirSync(config.outputDir, { recursive: true });
	const target = join(config.outputDir, `${name}.dump`);

	// Custom format, so pg_restore can pull individual objects out of it rather
	// than replaying the whole thing.
	//
	// --enable-row-security is added ONLY for a role that does not bypass RLS,
	// and only after findUnprovableTables came back empty. On its own the flag
	// is a data-loss hazard: it silently dumps just the rows the role can see.
	// Measured on Postgres 17 (2026-08-19) — a two-row table, a role limited by
	// policy to one of them, pg_dump exiting 0, one row in the dump. The check
	// above is what makes it safe, so the two must never be separated.
	const rowSecurity = bypassesRls ? [] : ["--enable-row-security"];
	try {
		await execFileAsync(
			"pg_dump",
			[...rowSecurity, "--format=custom", "--file", target],
			{
				env: {
					...process.env,
					...connectionEnv(config.connectionString),
				},
				maxBuffer: 64 * 1024 * 1024,
			},
		);
	} catch (error) {
		throw new Error(explainDumpFailure(error));
	}

	const bytes = statSync(target).size;
	return `pg_dump written to ${target} (${(bytes / 1024 / 1024).toFixed(1)} MiB). Restore with pg_restore.`;
}

async function main(): Promise<void> {
	const required = process.argv.includes("--require");
	const result = readConfig(process.env);

	if (!result.configured) {
		const message = `Restore-point capture is not configured: ${result.reason}`;
		if (required) {
			console.error(
				`${message} --require was passed, so this is a failure.`,
			);
			process.exit(1);
		}
		console.log(
			`${message} Skipping — pass --require to make this a hard gate.`,
		);
		return;
	}

	const name = restorePointName(
		process.env.GITHUB_SHA,
		new Date().toISOString(),
	);

	let summary: string;
	try {
		summary =
			result.config.provider === "neon"
				? await captureNeonBranch(result.config, name)
				: await capturePgDump(result.config, name);
	} catch (error) {
		// `--require` is the whole gate, for a failed capture as much as for an
		// unconfigured one. Without it, a capture that cannot run must not stop a
		// promotion that is otherwise fine: configuring this on the dev
		// environment failed on the first real attempt and blocked the rollout,
		// which is not what "opt-in, never blocks" should mean.
		const detail = error instanceof Error ? error.message : String(error);
		if (required) {
			console.error(`Restore-point capture failed: ${detail}`);
			process.exit(1);
		}
		console.warn(
			`::warning::Restore-point capture failed and was skipped: ${detail}. Pass --require to make this stop the promotion.`,
		);
		return;
	}

	console.log(
		`Restore point captured via ${result.config.provider}: ${summary}`,
	);

	if (process.env.GITHUB_STEP_SUMMARY) {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`\n**Restore point** (${result.config.provider}): ${summary}\n`,
		);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(
			"capture:restore-point failed:",
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
	});
}
