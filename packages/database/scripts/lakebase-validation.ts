#!/usr/bin/env npx tsx
/**
 * Databricks Lakebase (Managed Postgres 17) Capability Probe
 *
 * A non-destructive script that tests whether the target database supports the
 * features Fabric's RLS deployment pipeline requires. Run this against a scratch
 * Lakebase branch before deploying to confirm which WORKER_RLS_MODE to use.
 *
 * Usage:
 *   DATABRICKS_LAKEBASE_TEST_URL=postgresql://... pnpm --filter @repo/database test:lakebase
 *
 *   # Password has URL-special characters (@ : / ? # %)? Skip percent-encoding —
 *   # pass it out-of-band and it is folded into the URL for you:
 *   DATABRICKS_LAKEBASE_TEST_URL=postgresql://fabric_app@host/db?sslmode=require \
 *     DATABRICKS_LAKEBASE_TEST_PASSWORD='p@ss:w/rd!' pnpm --filter @repo/database test:lakebase
 *
 * Exit codes:
 *   0 — all REQUIRED probes passed (informational failures are allowed)
 *   1 — one or more REQUIRED probes failed, or connection could not be established
 *
 * After running, follow the recommendation printed in the summary block and
 * execute the full spike (prisma migrate deploy + deploy:rls + tenant-isolation
 * tests) against a scratch Lakebase branch per docs/deployment/DATABRICKS.md.
 */

import pg from "pg";

const connectionString = process.env.DATABRICKS_LAKEBASE_TEST_URL;

if (!connectionString) {
	console.log(
		"ℹ  DATABRICKS_LAKEBASE_TEST_URL is not set — skipping Lakebase validation.",
	);
	console.log(
		"   Set this env var to a Databricks Lakebase (or any Postgres) connection string to run probes.",
	);
	process.exit(0);
}

// Optional out-of-band password. Passwords with URL-special characters
// (@ : / ? # %) are painful to percent-encode by hand inside the connection
// string, so allow supplying it separately (falls back to the standard
// PGPASSWORD). It is folded into the URL via the WHATWG URL setter, which
// percent-encodes it correctly, and overrides any password already in the URL.
// NB: a `password` field on pg.Client is IGNORED when a connectionString is
// given — the parsed connection string always wins — so it must go in the URL.
const separatePassword =
	process.env.DATABRICKS_LAKEBASE_TEST_PASSWORD ?? process.env.PGPASSWORD;

// Narrowed copy — TS can't carry the module-level guard into main()'s closure.
let targetUrl: string = connectionString;

if (separatePassword) {
	try {
		const url = new URL(connectionString);
		url.password = separatePassword; // setter percent-encodes for us
		targetUrl = url.toString();
	} catch (err) {
		console.error(
			`✗ DATABRICKS_LAKEBASE_TEST_URL is not a valid URL — cannot fold in DATABRICKS_LAKEBASE_TEST_PASSWORD: ${(err as Error).message}`,
		);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

type ProbeResult = {
	label: string;
	required: boolean;
	passed: boolean;
	detail: string;
};

const results: ProbeResult[] = [];

function record(
	label: string,
	required: boolean,
	passed: boolean,
	detail: string,
): void {
	const icon = passed ? "✓" : "✗";
	const tag = required ? "[REQUIRED]" : "[info]    ";
	console.log(`  ${icon} ${tag} ${label}`);
	if (detail) {
		console.log(`           ${detail}`);
	}
	results.push({ label, required, passed, detail });
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

async function runInTransaction(
	client: pg.Client,
	fn: (client: pg.Client) => Promise<void>,
): Promise<void> {
	await client.query("BEGIN");
	try {
		await fn(client);
	} finally {
		// Always roll back so probes leave no persistent state.
		await client.query("ROLLBACK");
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("🔍 Databricks Lakebase Capability Probe\n");
	console.log(
		`   Target: ${targetUrl.replace(/:\/\/[^@]*@/, "://<credentials>@")}\n`,
	);

	const client = new pg.Client({ connectionString: targetUrl });

	// -----------------------------------------------------------------------
	// Probe 1 — Connect + SELECT version() [REQUIRED]
	// -----------------------------------------------------------------------
	console.log("Probe 1 — Connect + server version");
	try {
		await client.connect();
		const res = await client.query<{ version: string }>("SELECT version()");
		const version = res.rows[0]?.version ?? "(unknown)";
		record("Connect + SELECT version()", true, true, version);
	} catch (err: any) {
		record(
			"Connect + SELECT version()",
			true,
			false,
			err.message ?? String(err),
		);
		// Cannot continue without a connection.
		console.log("\n❌ Cannot connect — aborting remaining probes.\n");
		printSummary(null);
		process.exit(1);
	}

	// -----------------------------------------------------------------------
	// Probe 2 — Superuser status [informational]
	// -----------------------------------------------------------------------
	console.log("\nProbe 2 — Superuser status (informational)");
	try {
		const res = await client.query<{ is_superuser: string }>(
			"SELECT current_setting('is_superuser') AS is_superuser",
		);
		const value = res.rows[0]?.is_superuser ?? "(unknown)";
		record(
			"current_setting('is_superuser')",
			false,
			true,
			`is_superuser = ${value}`,
		);
	} catch (err: any) {
		record(
			"current_setting('is_superuser')",
			false,
			false,
			err.message ?? String(err),
		);
	}

	// -----------------------------------------------------------------------
	// Probe 3 — set_config round-trip [REQUIRED]
	// -----------------------------------------------------------------------
	console.log("\nProbe 3 — set_config round-trip inside transaction");
	try {
		let readBack: string | null = null;
		await runInTransaction(client, async (c) => {
			await c.query(
				"SELECT set_config('app.tenant_type', 'organization', true)",
			);
			const res = await c.query<{ val: string }>(
				"SELECT current_setting('app.tenant_type', true) AS val",
			);
			readBack = res.rows[0]?.val ?? null;
		});
		const passed = readBack === "organization";
		record(
			"set_config round-trip (app.tenant_type)",
			true,
			passed,
			passed
				? `read back: "${readBack}"`
				: `expected "organization", got "${readBack}"`,
		);
	} catch (err: any) {
		record(
			"set_config round-trip (app.tenant_type)",
			true,
			false,
			err.message ?? String(err),
		);
	}

	// -----------------------------------------------------------------------
	// Probe 4 — ENUM support [REQUIRED]
	// -----------------------------------------------------------------------
	console.log("\nProbe 4 — ENUM type creation");
	try {
		await runInTransaction(client, async (c) => {
			await c.query(
				"CREATE TYPE _lakebase_probe_enum AS ENUM ('a', 'b')",
			);
		});
		record(
			"CREATE TYPE ... AS ENUM",
			true,
			true,
			"ENUM creation and rollback succeeded",
		);
	} catch (err: any) {
		record(
			"CREATE TYPE ... AS ENUM",
			true,
			false,
			err.message ?? String(err),
		);
	}

	// -----------------------------------------------------------------------
	// Probe 5 — ON CONFLICT upsert [REQUIRED]
	// -----------------------------------------------------------------------
	console.log("\nProbe 5 — ON CONFLICT upsert");
	try {
		await runInTransaction(client, async (c) => {
			await c.query(
				"CREATE TEMP TABLE _lakebase_probe(k TEXT PRIMARY KEY, v TEXT)",
			);
			await c.query(
				"INSERT INTO _lakebase_probe(k, v) VALUES ('x', 'first') ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
			);
			await c.query(
				"INSERT INTO _lakebase_probe(k, v) VALUES ('x', 'second') ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
			);
			const res = await c.query<{ v: string }>(
				"SELECT v FROM _lakebase_probe WHERE k = 'x'",
			);
			const val = res.rows[0]?.v;
			if (val !== "second") {
				throw new Error(`upsert did not take effect — got "${val}"`);
			}
		});
		record(
			"ON CONFLICT DO UPDATE",
			true,
			true,
			"upsert round-trip succeeded",
		);
	} catch (err: any) {
		record(
			"ON CONFLICT DO UPDATE",
			true,
			false,
			err.message ?? String(err),
		);
	}

	// -----------------------------------------------------------------------
	// Probe 6 — BYPASSRLS role attribute [informational — decides WORKER_RLS_MODE]
	// -----------------------------------------------------------------------
	console.log(
		"\nProbe 6 — BYPASSRLS role attribute capability (decides WORKER_RLS_MODE)",
	);
	let bypassRlsAvailable = false;
	try {
		try {
			await client.query(
				"CREATE ROLE _lakebase_probe_role NOLOGIN BYPASSRLS",
			);
			bypassRlsAvailable = true;
		} finally {
			// Always clean up, even if CREATE failed.
			try {
				await client.query("DROP ROLE IF EXISTS _lakebase_probe_role");
			} catch {
				// Ignore drop errors — role may not exist if CREATE failed.
			}
		}
		record(
			"CREATE ROLE ... BYPASSRLS",
			false,
			true,
			"BYPASSRLS available → WORKER_RLS_MODE=bypassrls OK",
		);
	} catch (err: any) {
		record(
			"CREATE ROLE ... BYPASSRLS",
			false,
			false,
			`${err.message ?? String(err)} → use WORKER_RLS_MODE=policy`,
		);
	}

	// -----------------------------------------------------------------------
	// Probe 7 — CREATE POLICY capability [informational]
	// -----------------------------------------------------------------------
	console.log("\nProbe 7 — CREATE POLICY capability");
	try {
		await runInTransaction(client, async (c) => {
			await c.query("CREATE TABLE _lakebase_probe_rls(id INT)");
			await c.query(
				"ALTER TABLE _lakebase_probe_rls ENABLE ROW LEVEL SECURITY",
			);
			await c.query(
				"CREATE POLICY p ON _lakebase_probe_rls USING (true)",
			);
			await c.query("DROP TABLE _lakebase_probe_rls");
		});
		record(
			"CREATE POLICY on regular table",
			false,
			true,
			"RLS policy creation and rollback succeeded",
		);
	} catch (err: any) {
		record(
			"CREATE POLICY on regular table",
			false,
			false,
			err.message ?? String(err),
		);
	}

	// -----------------------------------------------------------------------
	// Summary
	// -----------------------------------------------------------------------
	await client.end();
	printSummary(bypassRlsAvailable);

	const anyRequiredFailed = results.some((r) => r.required && !r.passed);
	process.exit(anyRequiredFailed ? 1 : 0);
}

function printSummary(bypassRlsAvailable: boolean | null): void {
	console.log(`\n${"─".repeat(60)}`);
	console.log("Summary");
	console.log("─".repeat(60));

	const required = results.filter((r) => r.required);
	const informational = results.filter((r) => !r.required);
	const requiredPassed = required.filter((r) => r.passed).length;
	const infoPassed = informational.filter((r) => r.passed).length;

	console.log(
		`  Required probes:     ${requiredPassed}/${required.length} passed`,
	);
	console.log(
		`  Informational:       ${infoPassed}/${informational.length} passed`,
	);

	console.log();
	if (bypassRlsAvailable === true) {
		console.log(
			"  Recommendation: WORKER_RLS_MODE=bypassrls  (default — no change needed)",
		);
	} else if (bypassRlsAvailable === false) {
		console.log(
			"  Recommendation: WORKER_RLS_MODE=policy      (set this in your deploy env)",
		);
	} else {
		console.log(
			"  Recommendation: (connection failed — could not determine WORKER_RLS_MODE)",
		);
	}

	const anyRequiredFailed = results.some((r) => r.required && !r.passed);
	if (anyRequiredFailed) {
		console.log();
		console.log(
			"  ❌ One or more REQUIRED probes failed — Lakebase may not be compatible.",
		);
		console.log("     Review the failed probes above before proceeding.");
	} else if (results.length > 0) {
		console.log();
		console.log("  ✓ All REQUIRED probes passed.");
	}

	console.log();
	console.log(
		"  Next step: run the full spike (prisma migrate deploy + deploy:rls +",
	);
	console.log(
		"  tenant-isolation tests) against a scratch Lakebase branch per",
	);
	console.log("  docs/deployment/DATABRICKS.md.");
	console.log("─".repeat(60));
}

main().catch((err) => {
	console.error("\n❌ Unexpected error:", err);
	process.exit(1);
});
