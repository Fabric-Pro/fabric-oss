/**
 * Next.js Instrumentation
 *
 * This file is loaded at server startup and initializes OpenTelemetry
 * for comprehensive observability (traces, metrics, logs).
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

/**
 * Emit a non-fatal warning if FABRIC_AUDIT_LOG_RETENTION_DAYS is set
 * below the 90-day documented floor. Mirrors the Temporal worker check
 * (`packages/temporal/src/lib/audit-log-env.ts`) — both are deliberate
 * so the warning lands on whichever process the operator boots first.
 *
 * See: docs/audit-log/README.md §9.5
 */
function warnIfAuditRetentionBelowFloor(): void {
	const raw = process.env.FABRIC_AUDIT_LOG_RETENTION_DAYS;
	if (raw === undefined || raw === "") {
		return;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		return;
	}
	if (value >= 90) {
		return;
	}
	console.warn(
		`[env] FABRIC_AUDIT_LOG_RETENTION_DAYS=${value} is below the documented minimum (90). Audit retention is configurable but compliance-sensitive deployments expect at least 90 days for diagnostic coverage.`,
	);
}

export async function register() {
	// Only run on server-side (Node.js runtime)
	if (process.env.NEXT_RUNTIME === "nodejs") {
		// Report a production deployment that cannot run its cron schedule
		// because CRON_SECRET is missing. Deliberately first: the cron gate has
		// no fallback any more, so this is the only signal that those jobs are
		// silently dead, and every check below it can throw.
		const { describeMissingCronSecret } = await import(
			"./app/api/cron/lib/cron-auth"
		);
		const missingCronSecret = describeMissingCronSecret();
		if (missingCronSecret) {
			console.error(`[env] ${missingCronSecret}`);
		}

		// Fail fast on invalid PartyKit/collaboration configuration before the
		// app starts serving — see Fizzy #1722 (FR-9/FR-10).
		const { validatePartykitConfig } = await import(
			"@shared/lib/partykit-config"
		);
		validatePartykitConfig();

		const { initObservability } = await import("@repo/observability");

		initObservability({
			serviceName: process.env.OTEL_SERVICE_NAME || "fabric-web",
			serviceVersion: process.env.npm_package_version || "1.0.0",
			environment: process.env.NODE_ENV,
			// Use 30 second metric export for better visibility
			metricExportInterval: 30000,
		});

		// Surface a non-fatal warning if the audit-log retention window
		// is set below the 90-day documented floor. Mirrors the worker
		// startup check so the warning lands wherever the operator runs
		// first. See spec §9.5.
		warnIfAuditRetentionBelowFloor();

		// Key material is read lazily at the first encrypt or decrypt, so a
		// deployment holding an active key version it has no material for boots
		// cleanly and then fails every stored-credential read until someone
		// notices — which last time meant weeks, and a raw key-version error in
		// a product toast. Logged rather than thrown even when fatal, unlike the
		// worker: this app serves plenty of surfaces that never touch a stored
		// credential, and it does not compete for work off a shared queue, so a
		// broken one degrades only the pages that need a credential.
		const { describeEncryptionKeyMisconfiguration } = await import(
			"@repo/utils"
		);
		const encryptionProblem = describeEncryptionKeyMisconfiguration();
		if (encryptionProblem?.severity === "fatal") {
			console.error(
				`[env] Encryption is misconfigured — every stored-credential read will fail. ${encryptionProblem.message}`,
			);
		} else if (encryptionProblem) {
			console.warn(`[env] ${encryptionProblem.message}`);
		}

		// Ensure all required storage buckets exist
		try {
			const { ensureBuckets } = await import("@repo/storage");
			const { config } = await import("@repo/config");
			await ensureBuckets(Object.values(config.storage.bucketNames));
		} catch (e) {
			console.error("Failed to ensure storage buckets:", e);
		}
	}
}
