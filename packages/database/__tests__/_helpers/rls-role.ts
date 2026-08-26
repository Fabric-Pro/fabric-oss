import { db } from "../../prisma/client";
import type { Prisma } from "../../prisma/generated/client";

const RLS_TEST_ROLE = "fabric_rls_test";

export type TenantCtx =
	| { type: "personal"; tenantId: string; userId: string }
	| { type: "organization"; tenantId: string; userId?: string }
	| { type: "none" };

/**
 * Provision the restricted test role. **Requires a superuser connection**
 * (CI's `postgres` service and Aspire's local `postgres` both are). Idempotent.
 * NOSUPERUSER *and* NOBYPASSRLS are both required: a superuser bypasses RLS
 * independently of the BYPASSRLS attribute.
 */
export async function ensureRlsTestRole(): Promise<void> {
	await db.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fabric_rls_test') THEN
        CREATE ROLE fabric_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;`);
	await db.$executeRawUnsafe(
		"ALTER ROLE fabric_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS",
	);
	await db.$executeRawUnsafe(
		"GRANT USAGE ON SCHEMA public TO fabric_rls_test",
	);
	await db.$executeRawUnsafe(
		"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fabric_rls_test",
	);
	await db.$executeRawUnsafe(
		"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fabric_rls_test",
	);
}

/**
 * Pure no-false-pass predicate (unit-testable without touching the DB).
 * Throws unless the session runs as the restricted role with BOTH bypass
 * mechanisms off. rolsuper and rolbypassrls are INDEPENDENT bypass
 * mechanisms — a superuser bypasses RLS even with BYPASSRLS=false.
 */
export function assertSubjectToRls(
	row: { who: string; is_super: boolean; bypass: boolean } | undefined,
): void {
	if (!row || row.who !== RLS_TEST_ROLE || row.is_super || row.bypass) {
		throw new Error(
			`RLS harness misconfigured: running as ${row?.who} ` +
				`(super=${row?.is_super}, bypass=${row?.bypass}) — assertions would be a false pass`,
		);
	}
}

/**
 * Runs `fn` on a connection dropped to the NOBYPASSRLS `fabric_rls_test`
 * role with the given tenant GUCs — so tenant_isolation is ACTUALLY enforced.
 * Role + GUCs are SET LOCAL and revert at transaction end.
 */
export async function asRlsRole<T>(
	ctx: TenantCtx,
	fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return db.$transaction(async (tx) => {
		await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);

		const rows = await tx.$queryRaw<
			{ who: string; is_super: boolean; bypass: boolean }[]
		>`
      SELECT current_user::text AS who, rolsuper AS is_super, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`;
		assertSubjectToRls(rows[0]);

		const tenantId = ctx.type === "none" ? "" : ctx.tenantId;
		const userId =
			ctx.type === "personal"
				? ctx.userId
				: ctx.type === "organization"
					? (ctx.userId ?? "")
					: "";
		await tx.$executeRaw`SELECT set_config('app.tenant_type', ${ctx.type}, true)`;
		await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
		await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;

		return fn(tx);
	});
}
