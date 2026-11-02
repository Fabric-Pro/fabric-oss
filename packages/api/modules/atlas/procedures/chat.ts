import { atlasChatInputSchema } from "@repo/atlas";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { admitAtlasChat } from "../chat-access";
import { atlasChatTurnNote, startAtlasChat } from "../chat-turn";
import { assertAtlasEnabled } from "../lib";

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
		// Above the chat's error mapping on purpose: `mapAtlasError` would
		// rewrite this refusal into an Atlas code and lose the gate it carries.
		await admitAtlasChat({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
		});
		const { textStream, persistOutcome } = await startAtlasChat(
			{ userId: context.user.id, organizationId },
			{
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				mode: input.mode,
				focusNodeKey: input.focusNodeKey,
				conversationId: input.conversationId,
				messages: input.messages,
			},
		);
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
			const note = atlasChatTurnNote(await persistOutcome);
			if (note) {
				yield { type: `atlas-chat-${note}` as const };
			}
		})();
	});
