import { getSession } from "@saas/auth/lib/server";
import { StoryWorkspacePage } from "@saas/projects/components/stories/StoryWorkspacePage";
import { loadDocumentAssistantHydration } from "@saas/projects/lib/hydration/load-document-assistant-hydration";
import { redirect } from "next/navigation";
import { Suspense } from "react";

type Props = {
	params: Promise<{
		id: string;
		storyId: string;
	}>;
};

/**
 * Story (feature) workspace — personal context (no active organization).
 *
 * Hydrates the AI feature-assistant sidebar in a single SSR pass per spec
 * §3.2 FR-7 / §6.1. Personal context passes `organizationId: null` so the
 * tenant XOR filter resolves to `{ organizationId: null, userId: <session> }`.
 *
 * Uses an in-process DB call (`loadDocumentAssistantHydration`) instead of
 * the HTTP-fetched oRPC client — see the helper's docblock for the
 * root-cause / fix narrative.
 */
export default async function Page({ params }: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	const { id: projectId, storyId } = await params;

	const activeAssistantConversation = await loadDocumentAssistantHydration({
		userId: session.user.id,
		organizationId: null,
		documentRefKind: "USER_STORY",
		documentRefId: storyId,
	});

	return (
		<Suspense
			fallback={
				<div className="flex items-center justify-center h-96">
					<div className="text-muted-foreground">
						Loading story workspace...
					</div>
				</div>
			}
		>
			<StoryWorkspacePage
				projectId={projectId}
				storyId={storyId}
				documentRefKind="USER_STORY"
				initialAssistantMessages={
					activeAssistantConversation?.conversation?.messages ?? []
				}
				initialAssistantConversationId={
					activeAssistantConversation?.conversation?.conversationId ??
					null
				}
				initialAssistantVisibility={
					activeAssistantConversation?.conversation?.visibility ??
					"SHARED"
				}
				initialAssistantVisibilityLockedAt={
					activeAssistantConversation?.conversation
						?.visibilityLockedAt ?? null
				}
			/>
		</Suspense>
	);
}
