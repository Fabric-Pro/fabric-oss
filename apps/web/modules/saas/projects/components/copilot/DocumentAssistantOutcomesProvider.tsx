"use client";

/**
 * `DocumentAssistantOutcomesProvider` — bridges the persisted diff-outcome
 * stamps (acceptedAt / rejectedAt) to the live `CopilotAssistantMessage`
 * bubble so the outcome chips appear in the LIVE chat, not only in the
 * History drawer's read-only viewer.
 *
 * # Why this exists
 *
 * The live chat renders messages from CopilotKit's runtime store
 * (`useCopilotChatInternal().messages`) — those are AGUI-shape plain
 * objects `{id, role, content}` and carry NO persisted state like
 * `acceptedAt` / `rejectedAt`. The drawer renders from the persisted
 * `getActiveForDocument` payload, which DOES carry those stamps. Result:
 * "Accepted / Rejected / View version" was visible only in the drawer.
 *
 * This provider subscribes to `useActiveDocumentAssistantConversation`
 * (the persisted conversation) and exposes a `getOutcomesForMessageId(id)`
 * lookup. Mounted by `DocumentEditor` and `StoryWorkspace` around
 * `<CopilotSidebar>` so the shared `CopilotAssistantMessage` can read it
 * via context without needing project-specific props.
 *
 * Surfaces without the provider (Fabric AI, BacklogChat, anything not
 * a document/feature editor) get `null` from the hook and degrade
 * gracefully — the assistant message just doesn't render the outcome
 * chip, same behavior as before this provider existed.
 *
 * After `recordDiffOutcome` mutation resolves, the existing query
 * invalidation in `useRecordDocumentAssistantDiffOutcome` refreshes
 * `getActiveForDocument`, this provider re-renders with the new
 * outcomes map, and `CopilotAssistantMessage` re-renders the chip.
 * No additional plumbing required — React Query does the heavy lifting.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useActiveDocumentAssistantConversation } from "../../hooks/useDocumentAssistantHistory";
import type { DiffOutcomeChipToolCall } from "./DiffOutcomeChip";

interface OutcomeEntry extends DiffOutcomeChipToolCall {
	id: string;
	name?: string;
}

type OutcomesByMessageId = ReadonlyMap<string, ReadonlyArray<OutcomeEntry>>;

interface DocumentAssistantOutcomesApi {
	getOutcomesForMessageId: (
		messageId: string,
	) => ReadonlyArray<OutcomeEntry> | undefined;
}

const DocumentAssistantOutcomesContext =
	createContext<DocumentAssistantOutcomesApi | null>(null);

interface ProviderProps {
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
	children: ReactNode;
}

export function DocumentAssistantOutcomesProvider({
	documentRefKind,
	documentRefId,
	projectId,
	organizationId,
	children,
}: ProviderProps) {
	const { data } = useActiveDocumentAssistantConversation({
		documentRefKind,
		documentRefId,
		projectId,
		organizationId,
	});

	const map = useMemo<OutcomesByMessageId>(() => {
		const m = new Map<string, ReadonlyArray<OutcomeEntry>>();
		const messages = data?.conversation?.messages;
		if (!Array.isArray(messages)) {
			return m;
		}
		for (const raw of messages) {
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const msg = raw as {
				id?: unknown;
				role?: unknown;
				toolCalls?: unknown;
			};
			if (typeof msg.id !== "string") {
				continue;
			}
			if (msg.role !== "assistant") {
				continue;
			}
			if (!Array.isArray(msg.toolCalls)) {
				continue;
			}
			const entries: OutcomeEntry[] = [];
			for (const tc of msg.toolCalls) {
				if (!tc || typeof tc !== "object") {
					continue;
				}
				const t = tc as {
					id?: unknown;
					name?: unknown;
					acceptedAt?: unknown;
					rejectedAt?: unknown;
				};
				if (typeof t.id !== "string") {
					continue;
				}
				// Surface ALL diff-producing toolCalls — including
				// Pending (no acceptedAt/rejectedAt). Previously this
				// branch filtered them out, which meant a user who
				// reloaded mid-review (TipTap state lost, DiffReviewBar
				// gone) saw NO indication of the orphaned decision.
				// The `DiffOutcomeChip` already renders the "Pending"
				// badge variant when both stamps are null, so showing
				// it here closes the UX gap without any chip changes.
				entries.push({
					id: t.id,
					name: typeof t.name === "string" ? t.name : undefined,
					acceptedAt:
						typeof t.acceptedAt === "string" ? t.acceptedAt : null,
					rejectedAt:
						typeof t.rejectedAt === "string" ? t.rejectedAt : null,
				});
			}
			if (entries.length > 0) {
				m.set(msg.id, entries);
			}
		}
		return m;
	}, [data]);

	const api = useMemo<DocumentAssistantOutcomesApi>(
		() => ({
			getOutcomesForMessageId: (id: string) => map.get(id),
		}),
		[map],
	);

	return (
		<DocumentAssistantOutcomesContext.Provider value={api}>
			{children}
		</DocumentAssistantOutcomesContext.Provider>
	);
}

/**
 * Read-only hook for consumers (currently `CopilotAssistantMessage`).
 * Returns `null` when no provider is mounted above (e.g. Fabric AI page,
 * BacklogChat) so the caller can degrade gracefully — the bubble simply
 * doesn't render the outcome chip in those contexts.
 */
export function useDocumentAssistantOutcomes(): DocumentAssistantOutcomesApi | null {
	return useContext(DocumentAssistantOutcomesContext);
}
