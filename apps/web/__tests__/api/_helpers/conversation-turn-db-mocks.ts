/**
 * Default `@repo/database` turn-record mocks for suites that drive the
 * orchestrator chat starters (the stream route and its non-stream sibling)
 * but are not about turns. Every new message is admitted as a fresh
 * START_PENDING turn with the execution id the route proposed; nothing is
 * cancelled; no turn row exists for a reattach.
 *
 * Spread into a `vi.mock("@repo/database", async () => ({ ... }))` factory:
 *
 *   ...(await import("./_helpers/conversation-turn-db-mocks")).conversationTurnDbMocks(),
 */

import { vi } from "vitest";

export function conversationTurnDbMocks() {
	return {
		hasOrganizationTie: vi.fn(async () => true),
		admitConversationTurn: vi.fn(
			async (args: {
				userId: string;
				organizationId: string;
				conversationId?: string | null;
				clientRequestKey: string;
				executionId: string;
				executionMode: string;
			}) => ({
				outcome: "created",
				turn: {
					id: "turn-example-1",
					userId: args.userId,
					organizationId: args.organizationId,
					conversationId: args.conversationId ?? null,
					scopeConversationId: args.conversationId ?? null,
					clientRequestKey: args.clientRequestKey,
					executionId: args.executionId,
					generation: args.conversationId ? 1 : null,
					executionMode: args.executionMode,
					status: "START_PENDING",
					// This request created the turn, so it holds the start token.
					startToken: "start-token-example",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			}),
		),
		markConversationTurnActive: vi.fn(async () => true),
		markConversationTurnStartFailed: vi.fn(async () => true),
		abandonConversationTurnStart: vi.fn(async () => true),
		finalizeOrphanedConversationTurn: vi.fn(async () => ({
			outcome: "changed",
		})),
		requestConversationTurnCancel: vi.fn(async () => ({
			outcome: "not_found",
		})),
		finalizeConversationTurn: vi.fn(async () => ({ outcome: "not_found" })),
		getConversationTurnForExecution: vi.fn(async () => null),
		getConversationTurnOwnerForExecution: vi.fn(async () => null),
	};
}
