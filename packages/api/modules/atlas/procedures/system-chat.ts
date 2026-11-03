import { AtlasService, systemChatInputSchema } from "@repo/atlas";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { admitAtlasChat } from "../chat-access";
import { atlasChatTurnNote, rethrowAtlasChatError } from "../chat-turn";
import { assertAtlasEnabled } from "../lib";

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
		// Same capability as the single-repository chat (Fizzy #1930): this is
		// AI over the codebase too, and an ungated sibling door would make the
		// gate on the other one a suggestion.
		await admitAtlasChat({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});
		try {
			const { textStream, persistOutcome, getAnswerModel } =
				await service.systemChat({
					projectId: input.projectId,
					repositoryIntegrationIds: input.repositoryIntegrationIds,
					mode: input.mode,
					focusNodeKey: input.focusNodeKey,
					conversationId: input.conversationId,
					messages: input.messages,
				});
			// As in `chat`, after text finishes and persistence settles, emit
			// served-model metadata, then at most one terminal sentinel.
			return (async function* () {
				for await (const delta of textStream) {
					yield delta;
				}
				const note = atlasChatTurnNote(await persistOutcome);
				const model = getAnswerModel();
				if (model) {
					yield { type: "atlas-chat-model" as const, model };
				}
				if (note) {
					yield { type: `atlas-chat-${note}` as const };
				}
			})();
		} catch (error) {
			rethrowAtlasChatError(error);
		}
	});
