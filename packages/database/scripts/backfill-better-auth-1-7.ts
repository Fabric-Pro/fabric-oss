/**
 * Expand the schema first, then run this with the deployment's application URL.
 * Dry run: pnpm --filter @repo/database exec tsx scripts/backfill-better-auth-1-7.ts --app-url https://example.com
 * Apply: add --apply. Readiness only: add --check.
 * Promotion gate: --check-installed reads the installer's stored configuration
 * without an application URL. It never applies or repairs the backfill.
 * DATABASE_URL must name the intended database. This script loads no env file.
 * The SQL transaction validates clients, installs compatibility triggers and
 * backfills resource arrays without changing token values, bindings or consent.
 * Rollback keeps this schema, bridge and revoked-token verifier. Revert the
 * provider dependency/configuration separately; 1.6 cannot read revoked flags.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	OAUTH_API_RESOURCE_PATH,
	OAUTH_GATEWAY_RESOURCE_PATH,
} from "@repo/utils/oauth-project-resource";
import { Client } from "pg";

export function oauthUpgradeAudiences(appUrl: string): string[] {
	const url = new URL(appUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new Error("Application URL must be an HTTP(S) origin");
	}
	return [
		`${url.origin}${OAUTH_GATEWAY_RESOURCE_PATH}`,
		`${url.origin}${OAUTH_GATEWAY_RESOURCE_PATH}/`,
		`${url.origin}${OAUTH_API_RESOURCE_PATH}`,
	];
}

export async function isBetterAuth17Ready(
	client: Client,
	audiences?: string[],
): Promise<boolean> {
	const exists = await client.query(
		"SELECT COALESCE((SELECT prorettype = 'boolean'::regtype FROM pg_proc WHERE oid = to_regprocedure($1)), false) AS installed",
		[
			audiences
				? "fabric_oauth_1_7_ready(text[])"
				: "fabric_oauth_1_7_ready()",
		],
	);
	if (exists.rows.length !== 1 || exists.rows[0]?.installed !== true) {
		return false;
	}
	const ready = await client.query(
		audiences
			? "SELECT fabric_oauth_1_7_ready($1::text[]) AS ready"
			: "SELECT fabric_oauth_1_7_ready() AS ready",
		audiences ? [audiences] : [],
	);
	return ready.rows.length === 1 && ready.rows[0]?.ready === true;
}

export async function backfillBetterAuth17(
	client: Client,
	audiences: string[],
	apply = false,
): Promise<void> {
	await client.query(
		"SELECT set_config('app.oauth_upgrade_audiences', $1, false)",
		[JSON.stringify(audiences)],
	);
	const sql = readFileSync(
		new URL("./backfill-better-auth-1-7.sql", import.meta.url),
		"utf8",
	);
	try {
		await client.query(
			apply ? sql : sql.replace(/\nCOMMIT;\s*$/, "\nROLLBACK;\n"),
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function main() {
	const { values } = parseArgs({
		options: {
			"app-url": { type: "string" },
			apply: { type: "boolean", default: false },
			check: { type: "boolean", default: false },
			"check-installed": { type: "boolean", default: false },
		},
	});
	if (
		!process.env.DATABASE_URL ||
		(values.check && values.apply) ||
		(values["check-installed"]
			? values.check || values.apply || values["app-url"]
			: !values["app-url"])
	) {
		throw new Error(
			"Set DATABASE_URL; use --check-installed alone, or supply --app-url with --check or --apply",
		);
	}
	const audiences = values["app-url"]
		? oauthUpgradeAudiences(values["app-url"])
		: undefined;
	const client = new Client({
		connectionString: process.env.DATABASE_URL,
		connectionTimeoutMillis: 5000,
		query_timeout: 30000,
	});
	await client.connect();
	try {
		if (values.check || values["check-installed"]) {
			await client.query("BEGIN READ ONLY");
			if (!(await isBetterAuth17Ready(client, audiences))) {
				throw new Error("Better Auth 1.7 backfill is not ready");
			}
			await client.query("ROLLBACK");
			console.info("Better Auth 1.7 compatibility is ready.");
			return;
		}
		if (!audiences) {
			throw new Error("Application URL is required to backfill");
		}
		await backfillBetterAuth17(client, audiences, values.apply);
		console.info(
			values.apply
				? "Better Auth 1.7 compatibility installed and backfilled."
				: "Dry run passed; all changes rolled back. Add --apply to install compatibility.",
		);
	} finally {
		await client.end();
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch(() => {
		// PostgreSQL error details can contain row data or environment identifiers.
		console.error(
			"OAuth upgrade verification failed. Inspect the database privately; no unsupported rows are guessed.",
		);
		process.exitCode = 1;
	});
}
