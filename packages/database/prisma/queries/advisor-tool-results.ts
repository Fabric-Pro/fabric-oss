import { db } from "../client";
import { Prisma } from "../generated/client";

export const ADVISOR_RESULT_MAX_BYTES = 1024 * 1024;
const CONVERSATION_MAX_BYTES = 16 * ADVISOR_RESULT_MAX_BYTES;
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 5_000;

interface WriteInput {
	attempt: number;
	userId: string;
	organizationId: string;
	conversationId: string;
	turnId: string;
	sourceKey: string;
	toolName: string;
	text: string;
}
type WriteOutcome =
	| "stored"
	| "duplicate"
	| "scope_mismatch"
	| "row_limit"
	| "conversation_limit";

interface AdvisorResultReadScope {
	userId: string;
	organizationId: string;
	conversationId: string;
	beforeTurnGeneration: number;
}

interface AdvisorResultListingRow {
	id: string;
	toolName: string;
	createdAt: Date;
	sizeBytes: number;
	excerpt: string;
	valid: boolean;
}

/** Shared exclusive owner/tenant, expiry and earlier-turn fence for both readers. */
function readScope(input: AdvisorResultReadScope) {
	return Prisma.sql`r."conversationId"=${input.conversationId}
	 AND r."userId"=${input.userId} AND r."organizationId"=${input.organizationId}
	 AND r."expiresAt">clock_timestamp()
	 AND EXISTS (SELECT 1 FROM "conversation_turn" t WHERE t."id"=r."turnId"
	   AND t."generation"<${input.beforeTurnGeneration})`;
}

type ReadKind = "list" | "page";

/** Content-free classification shared with activity callers. */
export class AdvisorResultReadTimeoutError extends Error {
	readonly code = "ADVISOR_RESULT_READ_TIMEOUT";
	constructor() {
		super("Advisor result read timed out");
		this.name = "AdvisorResultReadTimeoutError";
	}
}

function isReadTimeLimit(error: unknown, started: boolean): boolean {
	if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
		return false;
	}
	if (error.code === "P2028") {
		return !started || typeof error.meta?.timeout === "number";
	}
	if (error.code !== "P2010" && error.code !== "P2039") {
		return false;
	}
	const adapter = error.meta?.driverAdapterError as
		| { cause?: { code?: unknown } }
		| undefined;
	return adapter?.cause?.code === "57014" || adapter?.cause?.code === "55P03";
}

/** Authorization and row access share these pool, transaction and server bounds. */
async function boundedRead<T>(
	kind: ReadKind,
	read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	const timeout = kind === "list" ? 350 : 1300;
	const statementTimeout = kind === "list" ? "200ms" : "1000ms";
	let started = false;
	try {
		return await db.$transaction(
			async (tx) => {
				started = true;
				// Prisma's timeout alone does not settle a callback that never resolves.
				// Reject inside the callback so rollback closes its client as well.
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						(async () => {
							await tx.$queryRaw`SELECT set_config('statement_timeout', ${statementTimeout}, true), set_config('lock_timeout', '100ms', true), set_config('idle_in_transaction_session_timeout', ${`${timeout}ms`}, true)`;
							return read(tx);
						})(),
						new Promise<T>((_resolve, reject) => {
							timer = setTimeout(
								() =>
									reject(new AdvisorResultReadTimeoutError()),
								timeout,
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			},
			{ maxWait: 100, timeout },
		);
	} catch (error) {
		if (isReadTimeLimit(error, started)) {
			throw new AdvisorResultReadTimeoutError();
		}
		throw error;
	}
}

async function listRows(
	tx: Prisma.TransactionClient,
	input: AdvisorResultReadScope,
): Promise<AdvisorResultListingRow[]> {
	// Byte size is stored metadata. Only the excerpt requires a JSON text projection;
	// no regular expression or character-length scan walks each full result.
	return tx.$queryRaw<AdvisorResultListingRow[]>`
	 WITH rows AS (
	  SELECT r."id", r."toolName", r."createdAt", r."sizeBytes", r."content"
	  FROM "advisor_tool_result" r WHERE ${readScope(input)}
	  ORDER BY r."createdAt" DESC, r."id" DESC LIMIT 30
	 ) SELECT "id", "toolName", "createdAt", "sizeBytes",
	  left("content"->>'text', 200) AS "excerpt",
	  ("content"->'v' = '1'::jsonb AND jsonb_typeof("content"->'text') = 'string') AS "valid"
	 FROM rows ORDER BY "createdAt" DESC, "id" DESC`;
}

async function readRow(
	tx: Prisma.TransactionClient,
	input: AdvisorResultReadScope & { id: string },
) {
	const rows = await tx.$queryRaw<{ toolName: string; content: unknown }[]>`
	 SELECT r."toolName", r."content" FROM "advisor_tool_result" r
	 WHERE ${readScope(input)} AND r."id"=${input.id} LIMIT 1`;
	return rows[0] ?? null;
}

interface AdvisorToolResultStorage {
	readTransaction<T>(
		kind: ReadKind,
		read: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T>;
	list(
		input: AdvisorResultReadScope,
		tx?: Prisma.TransactionClient,
	): Promise<AdvisorResultListingRow[]>;
	read(
		input: AdvisorResultReadScope & { id: string },
		tx?: Prisma.TransactionClient,
	): Promise<{ toolName: string; content: unknown } | null>;
	write(input: WriteInput): Promise<WriteOutcome>;
	deleteExpired(): Promise<number>;
}

/** Content location and v1 encoding belong here; callers pass only the text. */
export const advisorToolResultStorage: AdvisorToolResultStorage = {
	readTransaction: boundedRead,
	async list(input, tx) {
		return tx
			? listRows(tx, input)
			: boundedRead("list", (client) => listRows(client, input));
	},
	async read(input, tx) {
		return tx
			? readRow(tx, input)
			: boundedRead("page", (client) => readRow(client, input));
	},
	async write(input) {
		const sizeBytes = Buffer.byteLength(input.text, "utf8");
		if (sizeBytes > ADVISOR_RESULT_MAX_BYTES) {
			return "row_limit";
		}
		return db.$transaction(
			async (tx) => {
				// Bound the one attempt, including a competing writer's conversation lock.
				await tx.$queryRaw`SELECT set_config('statement_timeout', '200ms', true), set_config('lock_timeout', '100ms', true)`;
				const conversations = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "agent_conversation"
    WHERE "id"=${input.conversationId} AND "userId"=${input.userId}
      AND "organizationId"=${input.organizationId} FOR UPDATE`;
				if (conversations.length === 0) {
					return "scope_mismatch";
				}
				const turn = await tx.conversationTurn.findFirst({
					where: {
						id: input.turnId,
						conversationId: input.conversationId,
						userId: input.userId,
						organizationId: input.organizationId,
					},
					select: { id: true },
				});
				if (!turn) {
					return "scope_mismatch";
				}
				const existing = await tx.advisorToolResult.findUnique({
					where: {
						turnId_sourceKey: {
							turnId: input.turnId,
							sourceKey: input.sourceKey,
						},
					},
					select: {
						id: true,
						attempt: true,
						sizeBytes: true,
						expiresAt: true,
					},
				});
				if (existing && input.attempt <= existing.attempt) {
					return "duplicate";
				}
				const now = new Date();
				const usage = await tx.advisorToolResult.aggregate({
					where: {
						conversationId: input.conversationId,
						expiresAt: { gt: now },
					},
					_sum: { sizeBytes: true },
				});
				const replacedBytes =
					existing && existing.expiresAt > now
						? existing.sizeBytes
						: 0;
				if (
					(usage._sum.sizeBytes ?? 0) - replacedBytes + sizeBytes >
					CONVERSATION_MAX_BYTES
				) {
					return "conversation_limit";
				}

				const content = {
					attempt: input.attempt,
					sizeBytes,
					content: { v: 1, text: input.text },
					expiresAt: new Date(now.getTime() + RETENTION_MS),
				};
				if (existing) {
					await tx.advisorToolResult.update({
						where: { id: existing.id },
						data: content,
					});
				} else {
					await tx.advisorToolResult.create({
						data: {
							userId: input.userId,
							organizationId: input.organizationId,
							conversationId: input.conversationId,
							turnId: input.turnId,
							sourceKey: input.sourceKey,
							toolName: input.toolName,
							createdAt: now,
							...content,
						},
					});
				}
				return "stored";
			},
			{ maxWait: 250, timeout: 1000 },
		);
	},
	async deleteExpired() {
		return db.$executeRaw`
   DELETE FROM "advisor_tool_result" WHERE "expiresAt" <= NOW() AND "id" IN (
    SELECT "id" FROM "advisor_tool_result" WHERE "expiresAt" <= NOW()
    ORDER BY "expiresAt", "id" LIMIT ${PURGE_BATCH_SIZE}
   )`;
	},
};
