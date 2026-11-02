import { db } from "../client";
import { Prisma } from "../generated/client";

export const MCP_DURABLE_TOOL_CALL_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_DURABLE_RUNNING_TIMEOUT_MS = 10 * 60 * 1000;

export interface McpDurableToolCallClaimInput {
	organizationId: string;
	userId: string;
	credentialKind: string;
	credentialId: string;
	projectBinding: string | null;
	serverBinding: string;
	toolName: string;
	idempotencyKey: string;
	argsHash: string;
	now?: Date;
	runningTimeoutMs?: number;
}

type DurableCallRow = Awaited<
	ReturnType<typeof db.mcpDurableToolCall.findUnique>
> & {};

export type McpDurableToolCallClaim =
	| { kind: "claimed"; call: NonNullable<DurableCallRow> }
	| { kind: "replay"; call: NonNullable<DurableCallRow> }
	| { kind: "conflict"; call: NonNullable<DurableCallRow> }
	| { kind: "in_progress"; call: NonNullable<DurableCallRow> };

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2002"
	);
}

function uniqueWhere(input: McpDurableToolCallClaimInput) {
	return {
		replayKey: {
			organizationId: input.organizationId,
			userId: input.userId,
			credentialKind: input.credentialKind,
			credentialId: input.credentialId,
			projectBinding: input.projectBinding ?? "",
			serverBinding: input.serverBinding,
			toolName: input.toolName,
			idempotencyKey: input.idempotencyKey,
		},
	};
}

/**
 * Claim an idempotency key before the side effect runs.
 *
 * A create wins the first claim. A unique collision reads the existing row;
 * FAILED, expired, or stale RUNNING rows are reclaimed with an updatedAt CAS so
 * only one caller can move the row back to RUNNING. The returned updatedAt is
 * the completion fence: a worker that finishes after its stale claim was
 * reclaimed cannot overwrite the newer attempt.
 */
export async function claimMcpDurableToolCall(
	input: McpDurableToolCallClaimInput,
): Promise<McpDurableToolCallClaim> {
	const now = input.now ?? new Date();
	const expiresAt = new Date(now.getTime() + MCP_DURABLE_TOOL_CALL_TTL_MS);
	try {
		const call = await db.mcpDurableToolCall.create({
			data: {
				organizationId: input.organizationId,
				userId: input.userId,
				credentialKind: input.credentialKind,
				credentialId: input.credentialId,
				projectBinding: input.projectBinding ?? "",
				serverBinding: input.serverBinding,
				toolName: input.toolName,
				idempotencyKey: input.idempotencyKey,
				argsHash: input.argsHash,
				status: "RUNNING",
				expiresAt,
			},
		});
		return { kind: "claimed", call };
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
	}

	for (let attempt = 0; attempt < 4; attempt++) {
		const existing = await db.mcpDurableToolCall.findUnique({
			where: uniqueWhere(input),
		});
		if (!existing) {
			// The conflicting row was purged between the insert and read.
			return claimMcpDurableToolCall({ ...input, now });
		}
		const expired = existing.expiresAt <= now;
		if (!expired && existing.argsHash !== input.argsHash) {
			return { kind: "conflict", call: existing };
		}
		if (existing.status === "COMPLETED" && !expired) {
			return { kind: "replay", call: existing };
		}
		const staleBefore = new Date(
			now.getTime() -
				(input.runningTimeoutMs ?? MCP_DURABLE_RUNNING_TIMEOUT_MS),
		);
		if (
			existing.status === "RUNNING" &&
			existing.expiresAt > now &&
			existing.updatedAt > staleBefore
		) {
			return { kind: "in_progress", call: existing };
		}

		const reclaimed = await db.mcpDurableToolCall.updateMany({
			where: {
				id: existing.id,
				updatedAt: existing.updatedAt,
				OR: [
					{ status: "FAILED" },
					{ expiresAt: { lte: now } },
					{ status: "RUNNING", updatedAt: { lte: staleBefore } },
				],
			},
			data: {
				argsHash: input.argsHash,
				status: "RUNNING",
				result: Prisma.DbNull,
				completedAt: null,
				expiresAt,
				updatedAt: now,
			},
		});
		if (reclaimed.count === 1) {
			const call = await db.mcpDurableToolCall.findUnique({
				where: { id: existing.id },
			});
			if (call) {
				return { kind: "claimed", call };
			}
		}
	}

	const current = await db.mcpDurableToolCall.findUnique({
		where: uniqueWhere(input),
	});
	if (!current) {
		return claimMcpDurableToolCall({ ...input, now });
	}
	if (current.expiresAt > now && current.argsHash !== input.argsHash) {
		return { kind: "conflict", call: current };
	}
	return { kind: "in_progress", call: current };
}

export async function completeMcpDurableToolCall(input: {
	executionId: string;
	claimUpdatedAt: Date;
	status: "COMPLETED" | "FAILED";
	result: Prisma.InputJsonValue;
	completedAt?: Date;
}): Promise<void> {
	const completedAt = input.completedAt ?? new Date();
	const updated = await db.mcpDurableToolCall.updateMany({
		where: {
			id: input.executionId,
			status: "RUNNING",
			updatedAt: input.claimUpdatedAt,
		},
		data: {
			status: input.status,
			result: input.result,
			completedAt,
		},
	});
	if (updated.count !== 1) {
		throw new Error("MCP durable tool call claim is no longer current");
	}
}

/** Bounded cleanup; expired rows are ignored by claims even before purge. */
export async function purgeExpiredMcpDurableToolCalls(): Promise<number> {
	return db.$executeRaw`DELETE FROM "mcp_durable_tool_call" WHERE "id" IN (
		SELECT "id" FROM "mcp_durable_tool_call" WHERE "expiresAt" <= NOW()
		ORDER BY "expiresAt", "id" LIMIT 5000
	)`;
}
