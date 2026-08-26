/**
 * List Default-Enabled MCP Servers Activity
 *
 * Reads the global registry of managed-default MCP servers — i.e.
 * `MCPServer` rows flagged `defaultEnabled = true AND isSystemProvided = true`.
 *
 * Used by the generalized default-MCP eager-routing helper
 * (`applyDefaultMcpEagerRouting` in
 * `packages/temporal/src/workflows/orchestrator/phases/iterative-execution.ts`)
 * to drive a deterministic, registry-driven keyword scan against the
 * user's most recent message. The helper iterates the returned array in
 * order (already sorted by `name` ascending — see below) and the first
 * row whose `eagerKeywords` substring-matches (case-insensitive) wins.
 *
 * Determinism / tenant-scoping notes (per
 * `fabric/standards/backend/temporal.md` "Activity Design" and
 * `AGENTS.md` "XOR Pattern"):
 *   - Workflows are deterministic; the database read MUST live in an
 *     activity, not in the workflow itself. This file is that activity.
 *   - There is no tenant filter here. The `MCPServer` registry is global
 *     for `isSystemProvided = true` rows. Tenant filtering happens one
 *     step later — at `MCPConfig` resolution in
 *     `findDefaultMcpConfigActivity`, which DOES apply the XOR filter.
 *   - `orderBy: { name: "asc" }` keeps fixture ordering stable across
 *     replays + makes the first-match-wins behavior trivially auditable.
 */

import { db } from "@repo/database";

export interface DefaultEnabledMcpServerEntry {
	id: string;
	key: string;
	name: string;
	eagerKeywords: string[];
	eagerToolName: string | null;
	suppressOnEager: string[];
}

export async function listDefaultEnabledMcpServersActivity(): Promise<
	DefaultEnabledMcpServerEntry[]
> {
	return db.mCPServer.findMany({
		where: {
			defaultEnabled: true,
			isSystemProvided: true,
		},
		orderBy: { name: "asc" },
		select: {
			id: true,
			key: true,
			name: true,
			eagerKeywords: true,
			eagerToolName: true,
			suppressOnEager: true,
		},
	});
}
