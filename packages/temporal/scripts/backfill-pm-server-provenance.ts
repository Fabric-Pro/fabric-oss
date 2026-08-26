/**
 * C4 enrollment backfill (#1360) — operator-run, dry-run by default.
 *
 * Stamps `externalMcpServerId` on existing PM-linked story/epic/feature rows that
 * pass org/tenant verification, so FLAG_MISSING enrolls them. Run via tsx (no
 * package.json script — a script-only package.json edit trips the dependency
 * audit gate, and this is a one-shot ops tool):
 *
 *   # dry-run (no writes) against an env's DB:
 *   cd packages/temporal && npx dotenv -c -e ../../.env.local -- \
 *     pnpm --filter @repo/temporal exec tsx scripts/backfill-pm-server-provenance.ts
 *
 *   # apply (writes), optionally scoped to one project:
 *   ... exec tsx scripts/backfill-pm-server-provenance.ts -- --apply [--project <id>]
 */
import { db } from "@repo/database";
import { runBackfill } from "../src/activities/pm-integration/pm-server-provenance";

function parseArgs(): { apply: boolean; projectId?: string } {
	let apply = false;
	let projectId: string | undefined;
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if (arg === "--apply") {
			apply = true;
		} else if (
			arg === "--project" &&
			process.argv[i + 1] &&
			!process.argv[i + 1].startsWith("--")
		) {
			projectId = process.argv[++i];
		}
	}
	return { apply, projectId };
}

async function main(): Promise<void> {
	const opts = parseArgs();
	const log = (m: string) => console.log(`[c4-backfill] ${m}`);
	log(
		`mode=${opts.apply ? "APPLY" : "DRY-RUN"}${opts.projectId ? ` project=${opts.projectId}` : ""}`,
	);
	const report = await runBackfill(db, opts, log);
	log("=== summary ===");
	log(`projects scanned: ${report.projects}`);
	log(
		`${opts.apply ? "stamped" : "would-stamp"}: ${opts.apply ? report.stamped : report.wouldStamp}`,
	);
	for (const [k, v] of Object.entries(report.totals).sort()) {
		log(`  ${k}: ${v}`);
	}
}

main()
	.catch((e) => {
		console.error("[c4-backfill] failed:", e);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
