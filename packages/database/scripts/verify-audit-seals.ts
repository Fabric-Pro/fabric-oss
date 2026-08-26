/**
 * Audit-log seal-chain verification.
 *
 * Re-derives every seal in `audit_log_seal` from the current `audit_log`
 * contents and checks the chain, the covered content, the seal headers, and the
 * HMAC signatures. This is the on-demand tool an auditor (or an operator, or
 * CI) runs to PROVE the audit trail has not been tampered with since it was
 * sealed. Exits 0 when the whole chain verifies, non-zero (with a reason) on the
 * first failure or when no signing key is configured.
 *
 * Run with:
 *   pnpm --filter @repo/database verify:audit-seals            # local
 *   pnpm --filter @repo/database verify:audit-seals:staging    # staging
 *   pnpm --filter @repo/database verify:audit-seals:prod       # production
 *
 * Requires the same signing key material the sealing job used:
 * `AUDIT_LOG_SIGNING_KEY` (preferred) or `BETTER_AUTH_SECRET`.
 */

import { verifyAllAuditSeals } from "../prisma/queries/audit-log-seal-store";

async function main(): Promise<void> {
	console.log("[verify-audit-seals] Verifying audit_log seal chain...\n");

	const report = await verifyAllAuditSeals();

	console.log(`  seals checked : ${report.totalSeals}`);
	console.log(`  rows covered  : ${report.rowsCovered}`);
	console.log(
		`  coverage      : ${report.coverageStart ?? "—"} → ${report.coverageEnd ?? "—"}`,
	);

	if (report.totalSeals === 0) {
		console.log(
			"\n⚠ No seals found. Sealing is opt-in: set FABRIC_AUDIT_LOG_SEALING_ENABLED=true\n" +
				"  and let the hourly `audit-log-seal` schedule run at least once.",
		);
		// Nothing to verify is not a tamper failure — exit clean.
		process.exit(0);
	}

	if (report.ok) {
		console.log(
			`\n✓ PASS — the seal chain is intact. All ${report.totalSeals} seals verify against the current audit_log.`,
		);
		process.exit(0);
	}

	console.error(
		`\n✗ FAIL — verification failed at seal #${report.failedSequence}: ${report.reason}` +
			(report.detail ? `\n  ${report.detail}` : ""),
	);
	console.error(
		"\n  This means the audit_log or the seal chain was altered after sealing,\n" +
			"  the signing key does not match, or a seal is missing. Investigate before\n" +
			"  relying on the audit trail.",
	);
	process.exit(1);
}

main().catch((err) => {
	console.error("[verify-audit-seals] Unexpected error:", err);
	process.exit(2);
});
