/**
 * Project-level Read-only mode lookup.
 *
 * Called by every outbound write-gate (Temporal chokepoint, PM sync push,
 * attachment uploads, direct-chat tool wrapper, API sync procedures) right
 * before an external write would dispatch — so the answer must be a FRESH
 * read, never cached: enabling the toggle has to stop writes that are
 * already queued or in-flight.
 *
 * Raw SQL on purpose: the Temporal worker image can ship a Prisma client
 * generated before this column existed (`prisma generate || true` in its
 * Dockerfile), and a typed `select { readOnlyMode }` would throw on that
 * stale client. `$queryRaw` only needs the column to exist in the database.
 *
 * Fail-open on error: if the lookup itself fails the write proceeds, logged
 * loudly. This is a deliberate availability-over-strictness tradeoff — making
 * a transient DB error (connection blip, pre-migration missing column) block
 * every connector's writes across every read-only lookup would turn a safety
 * toggle into an outage. The window is narrow (a single-column lookup on a
 * primary key) and the argument value at each gate is always the real write
 * target, tenant-authorized upstream, so this is not attacker-inducible. If a
 * project genuinely needs writes to NEVER escape during onboarding, the enum
 * of connectors it can reach is the stronger control; this gate is the
 * everyday one.
 */

import { db } from "../../client";

export async function isProjectReadOnly(projectId: string): Promise<boolean> {
	try {
		const rows = await db.$queryRaw<Array<{ readOnlyMode: boolean }>>`
			SELECT "readOnlyMode" FROM "project" WHERE "id" = ${projectId}
		`;
		return rows[0]?.readOnlyMode === true;
	} catch (error) {
		console.warn(
			`[read-only-mode] lookup failed for project ${projectId}; allowing write (fail-open)`,
			error instanceof Error ? error.message : error,
		);
		return false;
	}
}
