/**
 * Database queries for the per-project decision-type taxonomy backing the
 * Architecture Decision Log's tagging metadata.
 *
 * The taxonomy is deliberately NOT a fixed enum: the AI suggestion flow reuses
 * an existing type when one fits and mints a new row only when nothing does,
 * so it grows with the project's actual decisions instead of being finalized
 * up front. Archived types stay resolvable on decisions that reference them.
 */

import { db } from "../../client";

export interface DecisionTypeRow {
	id: string;
	name: string;
	origin: "AI" | "HUMAN";
	archivedAt: Date | null;
	createdAt: Date;
}

const decisionTypeSelect = {
	id: true,
	name: true,
	origin: true,
	archivedAt: true,
	createdAt: true,
} as const;

export async function listDecisionTypes(input: {
	projectId: string;
}): Promise<DecisionTypeRow[]> {
	return db.decisionType.findMany({
		where: {
			projectId: input.projectId,
			archivedAt: null,
		},
		orderBy: { name: "asc" },
		select: decisionTypeSelect,
	});
}

/**
 * Retire a type from the picker without touching the decisions that carry it.
 * Decision and version reads resolve `decisionType` through a plain relation,
 * so an archived type keeps rendering its historical label wherever it was
 * already applied — only new tagging stops offering it.
 *
 * Returns null when the id does not belong to the project, so the caller can
 * answer NOT_FOUND rather than silently succeeding.
 */
export async function archiveDecisionType(input: {
	id: string;
	projectId: string;
}): Promise<DecisionTypeRow | null> {
	const result = await db.decisionType.updateMany({
		where: {
			id: input.id,
			projectId: input.projectId,
			archivedAt: null,
		},
		data: { archivedAt: new Date() },
	});
	if (result.count === 0) {
		return null;
	}
	return db.decisionType.findUnique({
		where: { id: input.id },
		select: decisionTypeSelect,
	});
}

async function createDecisionType(input: {
	projectId: string;
	name: string;
	origin?: "AI" | "HUMAN";
	// Tenant isolation (mirrors every other project-scoped table's create).
	userId?: string | null;
	organizationId?: string | null;
}): Promise<DecisionTypeRow> {
	return db.decisionType.create({
		data: {
			projectId: input.projectId,
			name: input.name.trim(),
			origin: input.origin ?? "HUMAN",
			userId: input.userId ?? null,
			organizationId: input.organizationId ?? null,
		},
		select: {
			id: true,
			name: true,
			origin: true,
			archivedAt: true,
			createdAt: true,
		},
	});
}

async function revive(id: string): Promise<DecisionTypeRow> {
	return db.decisionType.update({
		where: { id },
		data: { archivedAt: null },
		select: decisionTypeSelect,
	});
}

/**
 * Undo an archive. Scoped by projectId for the same reason archiveDecisionType
 * is: an id alone must not let one project reach into another's taxonomy.
 * Returns null when the id does not belong to the project or was never archived.
 */
export async function restoreDecisionType(input: {
	id: string;
	projectId: string;
}): Promise<DecisionTypeRow | null> {
	const result = await db.decisionType.updateMany({
		where: {
			id: input.id,
			projectId: input.projectId,
			archivedAt: { not: null },
		},
		data: { archivedAt: null },
	});
	if (result.count === 0) {
		return null;
	}
	return db.decisionType.findUnique({
		where: { id: input.id },
		select: decisionTypeSelect,
	});
}

/**
 * Find a type by (case-insensitive) name or mint one. Returns the existing row
 * when a name collides modulo case/whitespace so concurrent captures and
 * repeated suggestions converge on one taxonomy entry instead of fragmenting.
 *
 * The lookup deliberately spans archived rows: `@@unique([projectId, name])`
 * covers them too, so a name that survives only as an archived row cannot be
 * re-created. Applying that name again revives the original row, which is also
 * what the user means by it — rather than failing, or handing back an archived
 * row that no picker would ever show again.
 */
export async function ensureDecisionType(input: {
	projectId: string;
	name: string;
	origin?: "AI" | "HUMAN";
	userId?: string | null;
	organizationId?: string | null;
}): Promise<DecisionTypeRow> {
	const name = input.name.trim();
	const existing = await db.decisionType.findFirst({
		where: {
			projectId: input.projectId,
			name: { equals: name, mode: "insensitive" },
		},
		select: decisionTypeSelect,
	});
	if (existing) {
		return existing.archivedAt === null ? existing : revive(existing.id);
	}
	try {
		return await createDecisionType({
			projectId: input.projectId,
			name,
			origin: input.origin ?? "AI",
			userId: input.userId,
			organizationId: input.organizationId,
		});
	} catch (error) {
		// Lost a race to create the same name — re-read the winner's row.
		if (
			error instanceof Object &&
			"code" in error &&
			(error as { code?: string }).code === "P2002"
		) {
			const winner = await db.decisionType.findFirst({
				where: {
					projectId: input.projectId,
					name: { equals: name, mode: "insensitive" },
				},
				select: decisionTypeSelect,
			});
			if (winner) {
				return winner.archivedAt === null ? winner : revive(winner.id);
			}
		}
		throw error;
	}
}
