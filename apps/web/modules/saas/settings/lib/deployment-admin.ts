/**
 * Server-side helper to decide whether an email is in the
 * `FABRIC_DEPLOYMENT_ADMIN_EMAILS` env list.
 *
 * Mirrors the parsing rules of
 * `packages/api/orpc/middleware/require-audit-log-read.ts` so the layout
 * (and any other server component) can compute the same boolean. Never
 * expose the raw env to the browser; only the resolved boolean is
 * injected into client props or layout context.
 *
 * Spec: docs/audit-log/README.md §5.3,
 * §5.4.
 */

export function isDeploymentAdminEmail(
	email: string | null | undefined,
): boolean {
	if (!email || typeof email !== "string") {
		return false;
	}
	const raw = process.env.FABRIC_DEPLOYMENT_ADMIN_EMAILS ?? "";
	if (!raw.trim()) {
		return false;
	}

	const normalized = email.trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	const entries = raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);

	return entries.includes(normalized);
}
