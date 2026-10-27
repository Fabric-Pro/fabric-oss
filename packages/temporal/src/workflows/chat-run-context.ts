import { defineQuery, setHandler } from "@temporalio/workflow";

interface ChatRunContext {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
}

const contextQuery = defineQuery<ChatRunContext>("chatRunContext");

/** Immutable execution provenance, also available when replaying older runs. */
export function installChatRunContext(input: ChatRunContext) {
	const context = {
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		projectId: input.projectId ?? null,
	};
	setHandler(contextQuery, () => context);
}
