import { getSession } from "@saas/auth/lib/server";
import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";
import { loadDocumentAssistantHydration } from "@saas/projects/lib/hydration/load-document-assistant-hydration";
import { redirect } from "next/navigation";
import { Suspense } from "react";

type Props = {
	params: Promise<{
		id: string;
		documentId: string;
	}>;
};

/**
 * Document editor (personal context — no active organization).
 *
 * Hydrates the AI assistant sidebar in a single SSR pass. Personal context
 * passes `organizationId: null` so the tenant XOR filter resolves to
 * `{ organizationId: null, userId: <session> }`.
 *
 * Uses an in-process DB call (`loadDocumentAssistantHydration`) instead of
 * the HTTP-fetched oRPC client to avoid `TypeError: fetch failed
 * [ECONNREFUSED]` on Node prod builds (Windows IPv6/IPv4 mismatch) and on
 * Vercel serverless (function-fetches-itself restrictions). See the helper's
 * docblock for the full root-cause / fix narrative.
 *
 * Falls back to an empty conversation on hydration error rather than 500ing.
 */
export default async function Page({ params }: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	const { id: projectId, documentId } = await params;

	const activeAssistantConversation = await loadDocumentAssistantHydration({
		userId: session.user.id,
		organizationId: null,
		documentRefKind: "PROJECT_DOCUMENT",
		documentRefId: documentId,
	});

	return (
		<Suspense
			fallback={
				<div className="flex items-center justify-center h-96">
					<div className="text-muted-foreground">
						Loading editor...
					</div>
				</div>
			}
		>
			<DocumentEditorPage
				projectId={projectId}
				documentId={documentId}
				documentRefKind="PROJECT_DOCUMENT"
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
