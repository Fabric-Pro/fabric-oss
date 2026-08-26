import { ORPCError } from "@orpc/client";
import { AIProviderNotConfiguredError } from "@repo/ai";
import { AtlasService, systemChatInputSchema } from "@repo/atlas";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Multi-repository (System map) AI chat, streamed — mirrors `chat`. */
export const systemChatProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/system-chat",
		tags: ["Atlas"],
		summary: "Ask the AI across multiple repositories (System map)",
	})
	.input(systemChatInputSchema)
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
			const { textStream, persistOutcome } = await service.systemChat({
				projectId: input.projectId,
				repositoryIntegrationIds: input.repositoryIntegrationIds,
				mode: input.mode,
				focusNodeKey: input.focusNodeKey,
				conversationId: input.conversationId,
				messages: input.messages,
			});
			// Same event-iterator contract as `chat`: string deltas, then at most
			// one terminal sentinel once the assistant write settles.
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
			if (error instanceof AIProviderNotConfiguredError) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"No AI model is configured. Add one in Settings → AI Models.",
				});
			}
			mapAtlasError(error);
		}
	});
