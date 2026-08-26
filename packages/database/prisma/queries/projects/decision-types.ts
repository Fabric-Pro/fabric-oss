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

export async function listDecisionTypes(input: {
	projectId: string;
}): Promise<DecisionTypeRow[]> {
	return db.decisionType.findMany({
		where: {
			projectId: input.projectId,
			archivedAt: null,
		},
		orderBy: { name: "asc" },
		select: {
			id: true,
			name: true,
			origin: true,
			archivedAt: true,
			createdAt: true,
		},
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

/**
 * Find a live type by (case-insensitive) name or mint one. Returns the existing
 * row when a name collides modulo case/whitespace so concurrent captures and
 * repeated suggestions converge on one taxonomy entry instead of fragmenting.
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
			archivedAt: null,
		},
		select: {
			id: true,
			name: true,
			origin: true,
			archivedAt: true,
			createdAt: true,
		},
	});
	if (existing) {
		return existing;
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
				select: {
					id: true,
					name: true,
					origin: true,
					archivedAt: true,
					createdAt: true,
				},
			});
			if (winner) {
				return winner;
			}
		}
		throw error;
	}
}
