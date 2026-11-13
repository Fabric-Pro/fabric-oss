import type { Prisma } from "@repo/database";
import { advisorToolResultStorage } from "@repo/database/prisma/queries/advisor-tool-results";
import { isOrganizationMember } from "@repo/database/prisma/queries/verify-organization-membership";
import { logger } from "@repo/logs";
import {
	pageAdvisorText,
	parseResultReadArgs,
	safeEnd,
	UNAVAILABLE,
} from "../workflows/orchestrator/advisor-result-read";
import {
	type StoredResultEntry,
	storedResultId,
} from "../workflows/orchestrator/advisor-result-reuse";

export interface AdvisorResultReuseScope {
	userId: string;
	organizationId?: string;
	conversationId: string;
	turnId: string;
}

/** One shared live access check for listing and paging. No project-guest fallback. */
async function authorize(
	input: AdvisorResultReuseScope,
	tx: Prisma.TransactionClient,
) {
	if (
		!input.userId ||
		!input.organizationId ||
		!input.conversationId ||
		!input.turnId
	) {
		return undefined;
	}
	const [conversation, member, turn] = await Promise.all([
		tx.agentConversation.findFirst({
			where: {
				id: input.conversationId,
				userId: input.userId,
				organizationId: input.organizationId,
			},
			select: { id: true },
		}),
		isOrganizationMember(input.userId, input.organizationId, tx),
		tx.conversationTurn.findFirst({
			where: {
				id: input.turnId,
				userId: input.userId,
				organizationId: input.organizationId,
				conversationId: input.conversationId,
			},
			select: { generation: true },
		}),
	]);
	if (!conversation || !member || !turn) {
		return undefined;
	}
	if (typeof turn.generation !== "number") {
		return undefined;
	}

	return {
		userId: input.userId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		beforeTurnGeneration: turn.generation,
	};
}

/** Bound the entire lookup, including authorization/pool wait; late work cannot return data. */
async function bestEffort<T>(
	input: AdvisorResultReuseScope,
	fallback: T,
	deadlineMs: number,
	read: () => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<T>((resolve) => {
				timer = setTimeout(() => {
					logger.warn("[AdvisorResultReuse] Read timed out", {
						userId: input.userId,
						organizationId: input.organizationId,
						conversationId: input.conversationId,
						turnId: input.turnId,
						outcome: "timeout",
					});
					resolve(fallback);
				}, deadlineMs);
			}),
		]);
	} catch (error) {
		const timeout =
			(error as { code?: unknown } | null)?.code ===
			"ADVISOR_RESULT_READ_TIMEOUT";
		logger.warn(
			timeout
				? "[AdvisorResultReuse] Read timed out"
				: "[AdvisorResultReuse] Read failed",
			{
				userId: input.userId,
				organizationId: input.organizationId,
				conversationId: input.conversationId,
				turnId: input.turnId,
				outcome: timeout ? "timeout" : "error",
			},
		);
		return fallback;
	} finally {
		clearTimeout(timer);
	}
}

/** Called within the existing preload activity; only bounded metadata leaves it. */
export async function loadAdvisorStoredResults(
	input: AdvisorResultReuseScope,
): Promise<StoredResultEntry[]> {
	return bestEffort(input, [], 500, () =>
		advisorToolResultStorage.readTransaction("list", async (tx) => {
			const scope = await authorize(input, tx);
			if (!scope) {
				return [];
			}
			const rows = await advisorToolResultStorage.list(scope, tx);
			if (rows.some((row) => row.valid !== true)) {
				return [];
			}
			return rows.map((row) => ({
				ref: `s:${row.id}`,
				tool: row.toolName,
				storedAt: row.createdAt.toISOString(),
				sizeBytes: row.sizeBytes,
				excerpt: row.excerpt.slice(
					0,
					safeEnd(row.excerpt, Math.min(200, row.excerpt.length)),
				),
			}));
		}),
	);
}

/** Registered activity: the full row stays here; only the exact page enters history. */
export async function readAdvisorStoredResult(
	input: AdvisorResultReuseScope & { args: unknown; cap: number },
): Promise<string> {
	return bestEffort(input, UNAVAILABLE, 1500, async () => {
		const args = parseResultReadArgs(input.args);
		if (!args) {
			return UNAVAILABLE;
		}
		const id = storedResultId(args.ref);
		if (!id) {
			return UNAVAILABLE;
		}
		return advisorToolResultStorage.readTransaction("page", async (tx) => {
			const scope = await authorize(input, tx);
			if (!scope) {
				return UNAVAILABLE;
			}
			const row = await advisorToolResultStorage.read(
				{ ...scope, id },
				tx,
			);
			if (!row) {
				return UNAVAILABLE;
			}
			const content = row.content as {
				v?: unknown;
				text?: unknown;
			} | null;
			if (content?.v !== 1 || typeof content.text !== "string") {
				return UNAVAILABLE;
			}
			return pageAdvisorText(content.text, row.toolName, args, input.cap);
		});
	});
}
