import {
	deleteChatAgentSelection,
	getChatAgentSelection,
	type PersistedSelectedAgent,
} from "@repo/database";
import { resolveDefaultChatAgent } from "./default-agent";
import { validatePersistedAgents } from "./validator";

/**
 * Plain-async port of the GET-procedure handler. Used for SSR `initialData`
 * hydration of the picker so the first paint already shows the user's saved
 * chips instead of "blank → pop after 200ms" — same data the GET endpoint
 * returns, including the read-time empty cleanup (Decision 7 / spec §5.4).
 *
 * This function and `getChatAgentSelectionProcedure.handler` MUST stay in
 * lockstep — `get.ts` delegates to this so they share one implementation.
 */
export interface ChatAgentSelectionGetResult {
	exists: boolean;
	version: number;
	selectedAgents: PersistedSelectedAgent[];
	droppedCount: number;
	/**
	 * The agent to use when `selectedAgents` is empty, or null if this tenant
	 * cannot run it (#2040 § Scope).
	 *
	 * Deliberately a separate field rather than a synthetic entry inside
	 * `selectedAgents`: existing consumers read that array as "what the user
	 * chose", and quietly seeding it with something they never picked would
	 * change their behaviour — including whether a later write persists a
	 * choice the user never made. Callers opt in.
	 */
	defaultAgent: PersistedSelectedAgent | null;
}

export async function fetchChatAgentSelectionForUser(
	userId: string,
	organizationId: string | null,
): Promise<ChatAgentSelectionGetResult> {
	const row = await getChatAgentSelection(userId, organizationId);

	if (!row) {
		return {
			exists: false,
			version: 1,
			selectedAgents: [],
			droppedCount: 0,
			defaultAgent: await resolveDefaultChatAgent(userId, organizationId),
		};
	}

	const { kept, droppedCount } = await validatePersistedAgents({
		entries: row.selectedAgents,
		userId,
		organizationId,
	});

	if (kept.length === 0) {
		void deleteChatAgentSelection(userId, organizationId);
		return {
			exists: false,
			version: row.version,
			selectedAgents: [],
			droppedCount,
			// Everything the user had saved is gone. This is the case FR13
			// describes — fall back to the default, and the non-zero
			// droppedCount is what lets the client say why.
			defaultAgent: await resolveDefaultChatAgent(userId, organizationId),
		};
	}

	return {
		exists: true,
		version: row.version,
		selectedAgents: kept,
		droppedCount,
		// The user has a live selection; a default would be noise.
		defaultAgent: null,
	};
}
