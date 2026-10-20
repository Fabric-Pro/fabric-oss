import { db } from "@repo/database";

/**
 * Seed managed-default `MCPConfig` sentinel rows for a given tenant tuple.
 *
 * Adding the next default-enabled server (e.g. Mermaid) costs zero new hook
 * code — the helper iterates every `MCPServer` row flagged
 * `defaultEnabled = true` AND `isSystemProvided = true`, so flipping the seed
 * in `packages/database/prisma/seed-enterprise-mcp.ts` is sufficient. This is
 * the single source of truth that all three Better Auth hooks call (post
 * user-create, post org-create, post member-add / invite-accept) so the
 * post-backfill invariant is maintained going forward.
 *
 * Idempotent — checks `(userId, organizationId, mcpServerId)` for an existing
 * row before each insert and skips if present. Safe to call repeatedly from
 * any hook without producing duplicates (or to call after the backfill SQL).
 *
 * Tenant XOR: `organizationId` is either a string (org context) or `null`
 * (personal context) — never both, never `undefined`. Per
 * `fabric/standards/backend/queries.md` and `AGENTS.md`. The existence check
 * AND the insert both pass the literal value.
 *
 * Sentinel row shape: `authType: "NONE"`, `enabled: true`,
 * `isManagedDefault: true`. The migration's backfill produces identical rows.
 *
 * Best-effort: callers wrap in try/catch and SWALLOW errors (the next signin
 * / next eager-load defends downstream).
 */
export async function seedDefaultMcpConfigsForTenant(params: {
	userId: string;
	organizationId: string | null;
}): Promise<void> {
	const { userId, organizationId } = params;

	const defaultServers = await db.mCPServer.findMany({
		where: { defaultEnabled: true, isSystemProvided: true },
		select: { id: true, key: true },
	});

	if (defaultServers.length === 0) {
		return;
	}

	for (const server of defaultServers) {
		const existing = await db.mCPConfig.findFirst({
			where: {
				userId,
				organizationId: organizationId ?? null,
				mcpServerId: server.id,
			},
			select: { id: true },
		});
		if (existing) {
			continue;
		}

		await db.mCPConfig.create({
			data: {
				mcpServerId: server.id,
				userId,
				organizationId: organizationId ?? null,
				authType: "NONE",
				enabled: true,
				isManagedDefault: true,
			},
		});

		console.info("[seedDefaultMcpConfigsForTenant] Seeded sentinel row", {
			serverKey: server.key,
			userId,
			organizationId: organizationId ?? null,
		});
	}
}
