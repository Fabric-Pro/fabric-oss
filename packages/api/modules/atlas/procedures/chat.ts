import { ORPCError } from "@orpc/client";
import { AIProviderNotConfiguredError } from "@repo/ai";
import { AtlasService, atlasChatInputSchema } from "@repo/atlas";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Graph-grounded AI chat (streamed). */
export const atlasChatProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/chat",
		tags: ["Atlas"],
		summary: "Ask the AI about the analysed codebase",
	})
	.input(atlasChatInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			const { textStream, persistOutcome } = await service.chat({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				mode: input.mode,
				focusNodeKey: input.focusNodeKey,
				conversationId: input.conversationId,
				messages: input.messages,
			});
			// Compose the event iterator: every text delta (strings, as today),
			// then — once the assistant write settled — at most ONE terminal
			// object sentinel: persist-failed when the write was lost, else
			// interrupted when an abort/error path cut the reply off (the SDK
			// converts provider errors into error parts and closes the text
			// stream NORMALLY, so without this the live client would see an
			// error-before-first-token as an endless empty stream and a
			// mid-stream error as a silently truncated answer). Old clients
			// ignore non-string events, so the channel is backward compatible.
			// On a disconnect the consumer is gone and the sentinel is simply
			// undeliverable (the salvage already persisted server-side).
			return (async function* () {
				for await (const delta of textStream) {
					yield delta;
				}
				const outcome = await persistOutcome;
				if (!outcome.persisted) {
					yield { type: "atlas-chat-persist-failed" };
				} else if (outcome.interrupted) {
					yield { type: "atlas-chat-interrupted" };
				}
			})();
		} catch (error) {
			// Same mapping as `generateTasksProcedure`: PRECONDITION_FAILED
			// carrying the resolver's own message. The hand-written copy this
			// replaces named "Settings → AI Models", a different page from the
			// one that actually fixes it, and BAD_REQUEST reads as "your input
			// was wrong" for a condition the caller's input had no part in.
			if (error instanceof AIProviderNotConfiguredError) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: error.message,
				});
			}
			mapAtlasError(error);
		}
	});
