import { z } from "zod";
import { db, Prisma } from "../client";
import type { AIProvider } from "../generated/client";
import { getTaskDefaultModelUncached } from "./ai-models";

export const TEXT_TASK_TYPES = [
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EVAL",
] as const;

const snapshotModelSchema = z.string().min(1).nullable();
const snapshotScopeSchema = z.object({
	SIMPLE: snapshotModelSchema,
	COMPLEX: snapshotModelSchema,
	REASONING: snapshotModelSchema,
	CHAT: snapshotModelSchema,
	TOOL_CALLING: snapshotModelSchema,
	EVAL: snapshotModelSchema,
});
const taskDefaultsSnapshotSchema = z.object({
	version: z.literal(1),
	capturedAt: z.string().datetime({ offset: true }),
	scoped: snapshotScopeSchema,
	unscoped: snapshotScopeSchema,
});
export type TaskDefaultsSnapshot = z.infer<typeof taskDefaultsSnapshotSchema>;
export interface TaskDefaultsConnection {
	provider?: string | null;
	configId?: string | null;
	taskDefaultsSnapshot?: unknown;
}

export function readTaskDefaultsSnapshot(
	value: unknown,
	configId?: string | null,
) {
	if (value == null) {
		return null;
	}
	const parsed = taskDefaultsSnapshotSchema.safeParse(value);
	if (!parsed.success) {
		console.warn("[AI defaults] Invalid connection snapshot", { configId });
		return null;
	}
	return parsed.data;
}

// Capture the template currently in the database. A rollout-era NULL is filled
// at its first read: before deploy:seeds it captures the previous template;
// after seeding it captures the new one. A platform gateway key has no
// connection row or snapshot and follows the live template.
export async function captureTaskDefaultsSnapshot(
	provider: AIProvider,
	tx: Prisma.TransactionClient = db,
): Promise<TaskDefaultsSnapshot> {
	const scoped = {} as TaskDefaultsSnapshot["scoped"];
	const unscoped = {} as TaskDefaultsSnapshot["unscoped"];
	for (const task of TEXT_TASK_TYPES) {
		scoped[task] =
			(await getTaskDefaultModelUncached(task, "MEDIUM", provider, tx))
				?.canonicalName ?? null;
		unscoped[task] =
			(await getTaskDefaultModelUncached(task, "MEDIUM", undefined, tx))
				?.canonicalName ?? null;
	}
	return {
		version: 1,
		capturedAt: new Date().toISOString(),
		scoped,
		unscoped,
	};
}

/** Creates and default-role transitions capture; other edits preserve the column. */
export async function taskDefaultsSnapshotMutation(
	provider: AIProvider,
	existing: { isDefault: boolean } | null,
	isDefault: boolean,
	tx: Prisma.TransactionClient = db,
) {
	return !existing || (isDefault && !existing.isDefault)
		? {
				taskDefaultsSnapshot: await captureTaskDefaultsSnapshot(
					provider,
					tx,
				),
			}
		: {};
}

/** Fill a rollout-era SQL NULL once, then read the winning writer's value. */
export async function materializeTaskDefaultsSnapshot(
	row: { id: string; provider: AIProvider; taskDefaultsSnapshot: unknown },
	source: "organization" | "user",
) {
	if (row.taskDefaultsSnapshot !== null) {
		return readTaskDefaultsSnapshot(row.taskDefaultsSnapshot, row.id);
	}
	const snapshot = await captureTaskDefaultsSnapshot(row.provider);
	const where = {
		id: row.id,
		taskDefaultsSnapshot: { equals: Prisma.DbNull },
	};
	const data = { taskDefaultsSnapshot: snapshot };
	if (source === "organization") {
		await db.cloudProviderConfig.updateMany({ where, data });
		const winner = await db.cloudProviderConfig.findUniqueOrThrow({
			where: { id: row.id },
			select: { taskDefaultsSnapshot: true },
		});
		return readTaskDefaultsSnapshot(winner.taskDefaultsSnapshot, row.id);
	}
	await db.userCloudProviderConfig.updateMany({ where, data });
	const winner = await db.userCloudProviderConfig.findUniqueOrThrow({
		where: { id: row.id },
		select: { taskDefaultsSnapshot: true },
	});
	return readTaskDefaultsSnapshot(winner.taskDefaultsSnapshot, row.id);
}
