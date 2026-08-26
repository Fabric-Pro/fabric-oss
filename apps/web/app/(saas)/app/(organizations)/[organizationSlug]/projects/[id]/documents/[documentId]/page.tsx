import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";
import { loadDocumentAssistantHydration } from "@saas/projects/lib/hydration/load-document-assistant-hydration";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		id: string;
		documentId: string;
		organizationSlug: string;
	}>;
};

/**
 * Document editor (organization context).
 *
 * Hydrates the AI assistant sidebar in a single SSR pass per spec
 * §3.2 FR-7 / §6.1: fetches the caller's most recent ACTIVE document-assistant
 * conversation alongside auth + org resolution (parallel `Promise.all`) so the
 * client wrapper receives `initialAssistantMessages` on first paint and
 * `<HydratedMessagesProvider>` + `<CustomMessages>` render historical
 * turns immediately, without ever touching CopilotKit's `agent.messages`.
 *
 * Hydration failures fall back to an empty conversation rather than crashing
 * the editor — opening the document is the higher-priority user goal; chat
 * history is value-add.
 */
export default async function Page({ params }: Props) {
	const session = await getSession();
	const { id, documentId, organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// In-process hydration load. Replaces a previously-broken HTTP fetch
	// to `/api/rpc/agents/conversations/getActiveForDocument` which
	// reliably failed with ECONNREFUSED on Node prod builds (Windows
	// IPv6/IPv4 mismatch) and on Vercel serverless (functions can't
	// fetch their own deployment URL). See the helper's docblock for
	// the full root-cause / fix narrative.
	const activeAssistantConversation = await loadDocumentAssistantHydration({
		userId: session.user.id,
		organizationId: organization.id,
		documentRefKind: "PROJECT_DOCUMENT",
		documentRefId: documentId,
	});

	return (
		<DocumentEditorPage
			projectId={id}
			documentId={documentId}
			organizationSlug={organizationSlug}
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
				activeAssistantConversation?.conversation?.visibilityLockedAt ??
				null
			}
		/>
	);
}
