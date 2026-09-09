/**
 * Get Teams Context Access
 *
 * Probes every Microsoft Teams chat/channel linked to a project with the
 * CALLING user's own Microsoft Graph credentials, so the Context tab can
 * flag a context that this particular viewer can't read.
 *
 * Teams contexts are read under the viewing user's own Microsoft token
 * (see getRecentTeamsMessagesProcedure, live-integration-context.ts,
 * search-project-teams-messages.ts) — access to a chat/channel is per-user,
 * not per-project. A Graph 403 ("UnknownError" / Forbidden) for one member
 * doesn't mean the context is broken; it means that member's Microsoft
 * account can't read that specific chat, while everyone else with access
 * still can. Before this, that condition was invisible: the row rendered
 * like a healthy one and the viewer's document editor / story workspace /
 * RAG reads silently got nothing from it (Fizzy #2450).
 *
 * This is deliberately per-viewer, in-memory state — no persisted health
 * column, no schema change, no notification. It answers "can *I* read this
 * right now", nothing more.
 */

import { ORPCError } from "@orpc/server";
import { db, getProjectAccessContext } from "@repo/database";
import type { ProjectContextType } from "@repo/database/prisma/client";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftAccessDeniedError,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { parseTeamsContexts } from "../lib/teams-contexts";

// Error text is for a small inline tooltip, not a debug console — cap it so
// a pathological Graph error body can't blow up the response or the UI.
const MAX_ERROR_LENGTH = 500;

function truncateError(message: string): string {
	return message.length > MAX_ERROR_LENGTH
		? `${message.slice(0, MAX_ERROR_LENGTH)}…`
		: message;
}

interface ContextAccessEntry {
	/** ProjectContext row id — the UI matches rows by this. */
	contextId: string;
	readable: boolean;
	error: string | null;
}

export const getTeamsContextAccessProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/integrations/teams/context-access",
		tags: ["Integrations", "Teams"],
		summary: "Check per-viewer read access to a project's Teams contexts",
		description:
			"Probes each Teams chat/channel linked to a project with the caller's own Microsoft Graph credentials, so the UI can flag a context this particular viewer can't read.",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Still accepted — the client sends it and the tenant middleware
			// (tenantContextMiddleware, ahead of requireProjectPermission in
			// tenantProtectedProcedure) reads it for tenant-XOR resolution.
			// It is NOT used below to pick Graph credentials: the project's own
			// stored organizationId is, so a caller can't point this probe at
			// a different tenant's Microsoft account by passing a mismatched
			// value (Fizzy #2450 review).
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const { projectId } = input;

		// AUTHORIZATION: requireProjectPermission (above) already gated the
		// call on CONTEXT_READ for this project. This second lookup is not
		// for authorization — it's the only source of the organizationId
		// that's actually safe to hand to executeMicrosoftTeamsTool: the
		// project's OWN stored tenant, never whatever `input.organizationId`
		// the caller passed. A legacy row can hold `""` rather than `null`,
		// hence the `|| undefined` normalization.
		const accessContext = await getProjectAccessContext(projectId, userId);
		if (!accessContext) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const organizationId = accessContext.organizationId || undefined;

		// Find Teams integration contexts for this project
		const integrationContexts = await db.projectContext.findMany({
			where: {
				projectId,
				type: "INTEGRATION" as ProjectContextType,
			},
			select: {
				id: true,
				metadata: true,
			},
		});

		const teamsContexts = parseTeamsContexts(integrationContexts, {
			projectId,
			logTag: "getTeamsContextAccess",
		});

		if (teamsContexts.length === 0) {
			return { connected: true, contexts: [] as ContextAccessEntry[] };
		}

		// Probe each context with the SAME Graph calls the real read makes,
		// just capped to 1 message — enough to prove read access without
		// pulling real content across the wire.
		const results = await Promise.allSettled(
			teamsContexts.map(async (ctx) => {
				if (ctx.type === "chat" && ctx.chatId) {
					await executeMicrosoftTeamsTool(
						"get_chat_messages",
						{ chatId: ctx.chatId, limit: 1 },
						userId,
						organizationId,
					);
					return;
				}
				if (ctx.type === "channel" && ctx.teamId && ctx.channelId) {
					await executeMicrosoftTeamsTool(
						"list_messages",
						{
							teamId: ctx.teamId,
							channelId: ctx.channelId,
							limit: 1,
						},
						userId,
						organizationId,
					);
					return;
				}
				// Shouldn't happen — parseTeamsContexts only emits ids matching
				// the declared type — but fail the probe defensively rather
				// than silently reporting a malformed row as readable.
				throw new Error(
					"Malformed Teams context: missing required identifiers",
				);
			}),
		);

		let accountNotConnected = false;
		const contexts: ContextAccessEntry[] = [];

		for (let i = 0; i < results.length; i++) {
			const settled = results[i];
			const ctx = teamsContexts[i];

			if (settled.status === "fulfilled") {
				contexts.push({
					contextId: ctx.id,
					readable: true,
					error: null,
				});
				continue;
			}

			const errorMessage =
				settled.reason instanceof Error
					? settled.reason.message
					: String(settled.reason);

			// Classify in order:
			//  1. The Microsoft account isn't connected at all — account-wide,
			//     not per-context, so it's reported separately
			//     (`connected: false`) rather than as N failed rows.
			if (isMicrosoftNotConnectedError(errorMessage)) {
				accountNotConnected = true;
				continue;
			}

			//  2. A genuine per-resource Graph 403 — THIS user can't read
			//     THIS chat/channel. That's the condition this procedure
			//     exists to surface.
			if (isMicrosoftAccessDeniedError(errorMessage)) {
				contexts.push({
					contextId: ctx.id,
					readable: false,
					error: truncateError(errorMessage),
				});
				continue;
			}

			//  3. Anything else (429 rate limit, 500, timeout, network
			//     hiccup, …) is a transient/operational failure, not proof
			//     the viewer lacks access. Reporting it as `readable: false`
			//     would render — and, at staleTime: 60_000, cache — a wrong
			//     "Not readable by you" for something that may well succeed
			//     on the very next probe. Warn and omit the row entirely so
			//     the UI shows nothing for it, matching the "loading /
			//     errored" no-op state.
			console.warn(
				`[getTeamsContextAccess] Probe failed for ${ctx.displayName}:`,
				errorMessage,
			);
		}

		if (accountNotConnected) {
			return { connected: false, contexts: [] as ContextAccessEntry[] };
		}

		return { connected: true, contexts };
	});
