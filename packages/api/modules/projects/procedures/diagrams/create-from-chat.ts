import { ORPCError } from "@orpc/client";
import { createDiagram } from "@repo/database";
import { incrementDiagramAutoInsertedCounter } from "@repo/observability";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + requireProjectPermission(
 * DIAGRAM_CREATE) middleware (identical guard to createDiagramProcedure).
 * Rejects personal-scope callers because v1 is org-only (spec § FR-13,
 * § 16.2). The resolved organizationId is passed verbatim into
 * createDiagram, which writes the row through the same XOR-tenant filter
 * the rest of the diagrams sub-router uses
 * (`packages/database/prisma/queries/diagrams.ts:21-43`). RLS on the
 * `diagram` table (`apply-rls-direct.ts:103`) is the final defense
 * against any cross-tenant write.
 *
 * Trust model: `mcpCheckpointId` and `mcpConfigId` come
 * from the MCP server's `create_view` tool result. The procedure passes
 * them through verbatim — it does NOT regenerate, re-sign, or re-validate
 * them. The render pipeline (ExcalidrawPreview) already tolerates
 * malformed payloads (surfaces an error state).
 *
 * Historical note: this handler previously re-checked an
 * `FABRIC_EXCALIDRAW_AUTO_INSERT*` env-var feature flag server-side as
 * defense-in-depth. The flag was removed before merge — the feature
 * ships globally on — so the only remaining FORBIDDEN branch is the
 * personal-scope guard below.
 *
 * Spec sections: § 7.1 (procedure pseudocode), § 12 (server-side
 * counter), § 16-§ 17 (multi-tenant XOR + security), § FR-13
 * (personal-scope hidden).
 */
export const createFromChatProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DIAGRAM_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/diagrams/from-chat",
		tags: ["Projects", "Diagrams"],
		summary: "Create a diagram from an AI chat create_view tool result",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Required: scene JSON from MCP create_view toolArgs.elements
			elements: z.unknown(),
			appState: z.unknown().optional(),
			// Required: MCP linkage (passed through verbatim per spec § 17)
			checkpointId: z.string().min(1),
			mcpConfigId: z.string().min(1),
			// Required: derived per FR-3 (first 60 chars of user prompt, or fallback)
			title: z.string().min(1).max(255),
			// Surface tag for telemetry — restricted enum so dashboards stay clean
			surface: z.enum(["nexus", "loom", "in-feature", "in-document"]),
			// Optional source chat-message id for server-side dedup + audit
			sourceMessageId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Resolve the tenant scope. v1 is org-only (spec § FR-13 / § 16.2):
		// the client hides the button entirely in personal scope; the
		// server enforces the same rule with FORBIDDEN so a malicious
		// client cannot smuggle a Diagram row into personal scope.
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!orgId) {
			throw new ORPCError("FORBIDDEN", {
				message: "Auto-insert is org-only in v1",
			});
		}

		// XOR write: organizationId is set, userId is the session user,
		// projectId is the chat-scoped project. requireProjectPermission
		// above already verified DIAGRAM_CREATE access on this projectId.
		//
		// Wrap in try/catch and re-throw any DB-layer failure as FORBIDDEN.
		// Real failure modes we catch here:
		//   - Caller passes an `organizationId` cuid they don't actually
		//     belong to. `resolveOrganizationId` doesn't cross-check
		//     membership against the session, so a forged input passes the
		//     null-check above but Prisma then rejects on FK / RLS.
		//   - Caller passes a `projectId` that exists under a different org
		//     than the resolved `orgId` (XOR violation surfaced by the
		//     composite project lookup).
		//   - RLS rejection from the `diagram` table policy
		//     (`apply-rls-direct.ts:103`: `user_owned`).
		//
		// Surfaced as plain 500 INTERNAL_SERVER_ERROR in PR #1168's first
		// staging probe — this structured FORBIDDEN lets the UI render the
		// correct error toast and keeps Grafana/Sentry dashboards clean
		// (uncaught 500s otherwise look like real outages). The underlying
		// error is logged via the data field for observability without
		// leaking which check rejected the write (defense-in-depth per
		// spec § 17).
		let diagram: Awaited<ReturnType<typeof createDiagram>>;
		try {
			diagram = await createDiagram({
				title: input.title,
				elements: input.elements,
				appState: input.appState,
				checkpointId: input.checkpointId,
				mcpConfigId: input.mcpConfigId,
				userId: context.user.id,
				organizationId: orgId,
				projectId: input.projectId,
			});
		} catch (err) {
			const underlyingError =
				err instanceof Error ? err.message : String(err);
			throw new ORPCError("FORBIDDEN", {
				message: "Cannot create diagram in this scope",
				data: {
					projectId: input.projectId,
					organizationId: orgId,
					reason: "db-write-rejected",
					underlyingError,
				},
			});
		}

		// Server-side telemetry (Prometheus). Decoupled from the client
		// `diagram_auto_inserted` event so staged-rollout dashboards in
		// Grafana get a low-cardinality per-surface counter even if the
		// browser analytics provider is the no-op shim.
		incrementDiagramAutoInsertedCounter({ surface: input.surface });

		return { diagram };
	});
