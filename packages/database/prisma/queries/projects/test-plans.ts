/**
 * Database queries for Test Plans — flat Plan → Cases membership (no ADO
 * "suite"). Plans are Fabric-local in v1 (no PM-sync columns). Mirrors the
 * tenant-XOR + soft-delete pattern used by Architecture Decisions / Test Cases:
 * tenant isolation is enforced by RLS + the procedure layer; these helpers
 * filter by `projectId` (+ `deletedAt: null`). A case can belong to many plans;
 * the `(planId, testCaseId)` unique key forbids duplicate membership.
 */

import { db, type Prisma, type TestPlanState } from "../../client";

// ---------------------------------------------------------------------------
// Identifier generation (TP-NNN, per project)
// ---------------------------------------------------------------------------

/**
 * Compute the next per-project plan identifier (e.g. "TP-001"). Ordered by
 * `createdAt desc` so it never breaks at the 999→1000 padding boundary.
 */
export async function generateTestPlanIdentifier(
	projectId: string,
	client: Prisma.TransactionClient | typeof db = db,
): Promise<string> {
	const last = await client.testPlan.findFirst({
		where: { projectId },
		orderBy: { createdAt: "desc" },
		select: { identifier: true },
	});
	return nextTestPlanIdentifierFrom(last?.identifier);
}

function nextTestPlanIdentifierFrom(
	previous: string | undefined | null,
): string {
	if (!previous) {
		return "TP-001";
	}
	const match = previous.match(/TP-(\d+)/);
	const nextNum = match ? Number.parseInt(match[1], 10) + 1 : 1;
	return `TP-${String(nextNum).padStart(3, "0")}`;
}

function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Object &&
		"code" in error &&
		(error as { code?: string }).code === "P2002"
	);
}

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

const testPlanListSelect = {
	id: true,
	identifier: true,
	name: true,
	description: true,
	state: true,
	order: true,
	createdById: true,
	createdAt: true,
	updatedAt: true,
	// Count only memberships whose case is still live — a soft-deleted case must
	// not inflate a plan's #cases.
	_count: {
		select: { caseLinks: { where: { testCase: { deletedAt: null } } } },
	},
} as const;

const planCaseSelect = {
	id: true,
	testCaseId: true,
	section: true,
	order: true,
	testCase: {
		select: { id: true, identifier: true, title: true, state: true },
	},
} as const;

const testPlanDetailSelect = {
	id: true,
	projectId: true,
	identifier: true,
	name: true,
	description: true,
	state: true,
	order: true,
	createdById: true,
	userId: true,
	organizationId: true,
	createdAt: true,
	updatedAt: true,
	// Exclude memberships of soft-deleted cases — a deleted case must not appear
	// in the plan detail (soft-delete leaves the join row intact; FK cascade only
	// fires on hard delete).
	caseLinks: {
		where: { testCase: { deletedAt: null } },
		orderBy: { order: "asc" },
		select: planCaseSelect,
	},
} as const;

export type TestPlanDetail = Prisma.TestPlanGetPayload<{
	select: typeof testPlanDetailSelect;
}>;

export type TestPlanListItem = Prisma.TestPlanGetPayload<{
	select: typeof testPlanListSelect;
}>;

export type TestPlanCaseLink = Prisma.TestPlanCaseGetPayload<{
	select: typeof planCaseSelect;
}>;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateTestPlanInput {
	projectId: string;
	createdById: string;
	name: string;
	description?: string | null;
	state?: TestPlanState;
	userId?: string | null;
	organizationId?: string | null;
}

export async function createTestPlan(
	input: CreateTestPlanInput,
): Promise<TestPlanDetail> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await db.$transaction(async (tx) => {
				const identifier = await generateTestPlanIdentifier(
					input.projectId,
					tx,
				);
				const last = await tx.testPlan.findFirst({
					where: { projectId: input.projectId },
					orderBy: { order: "desc" },
					select: { order: true },
				});
				const order = (last?.order ?? 0) + 1;

				return await tx.testPlan.create({
					data: {
						projectId: input.projectId,
						identifier,
						createdById: input.createdById,
						name: input.name,
						description: input.description ?? null,
						state: input.state ?? "ACTIVE",
						order,
						userId: input.userId ?? null,
						organizationId: input.organizationId ?? null,
					},
					select: testPlanDetailSelect,
				});
			});
		} catch (error) {
			if (isUniqueViolation(error) && attempt < 3) {
				continue;
			}
			throw error;
		}
	}
}

export async function getTestPlan(input: {
	id: string;
	projectId: string;
}): Promise<TestPlanDetail | null> {
	return db.testPlan.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: testPlanDetailSelect,
	});
}

export interface ListTestPlansOptions {
	projectId: string;
	search?: string;
	state?: TestPlanState;
	limit?: number;
	offset?: number;
}

export async function listTestPlans(options: ListTestPlansOptions): Promise<{
	items: TestPlanListItem[];
	total: number;
}> {
	const { projectId, search, state, limit = 100, offset = 0 } = options;

	const where: Prisma.TestPlanWhereInput = {
		projectId,
		deletedAt: null,
		...(state ? { state } : {}),
		...(search
			? {
					OR: [
						{ name: { contains: search, mode: "insensitive" } },
						{
							identifier: {
								contains: search,
								mode: "insensitive",
							},
						},
					],
				}
			: {}),
	};

	const [items, total] = await Promise.all([
		db.testPlan.findMany({
			where,
			orderBy: { order: "asc" },
			take: limit,
			skip: offset,
			select: testPlanListSelect,
		}),
		db.testPlan.count({ where }),
	]);

	return { items, total };
}

export interface UpdateTestPlanInput {
	id: string;
	projectId: string;
	data: {
		name?: string;
		description?: string | null;
		state?: TestPlanState;
	};
}

/** Update a plan's scalar fields. Returns null if not found within the project. */
export async function updateTestPlan(
	input: UpdateTestPlanInput,
): Promise<TestPlanDetail | null> {
	const existing = await db.testPlan.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: { id: true },
	});
	if (!existing) {
		return null;
	}

	const d = input.data;
	return db.testPlan.update({
		where: { id: input.id },
		data: {
			...(d.name !== undefined ? { name: d.name } : {}),
			...(d.description !== undefined
				? { description: d.description }
				: {}),
			...(d.state !== undefined ? { state: d.state } : {}),
		},
		select: testPlanDetailSelect,
	});
}

/** Soft-delete a plan. Returns `{ id }` or null if not found within the project. */
export async function softDeleteTestPlan(input: {
	id: string;
	projectId: string;
}): Promise<{ id: string } | null> {
	const existing = await db.testPlan.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: { id: true },
	});
	if (!existing) {
		return null;
	}

	await db.testPlan.update({
		where: { id: input.id },
		data: { deletedAt: new Date() },
	});
	return existing;
}

// ---------------------------------------------------------------------------
// Membership (flat Plan → Cases, optional section label)
// ---------------------------------------------------------------------------

/**
 * Add a case to a plan at the end of the list. Throws Prisma P2002 on the
 * `(planId, testCaseId)` unique key when the case is already in the plan so the
 * procedure layer can map it to CONFLICT.
 */
export async function addCaseToPlan(input: {
	planId: string;
	testCaseId: string;
	section?: string | null;
}): Promise<TestPlanCaseLink> {
	const last = await db.testPlanCase.findFirst({
		where: { planId: input.planId },
		orderBy: { order: "desc" },
		select: { order: true },
	});
	const order = (last?.order ?? 0) + 1;

	return db.testPlanCase.create({
		data: {
			planId: input.planId,
			testCaseId: input.testCaseId,
			section: input.section ?? null,
			order,
		},
		select: planCaseSelect,
	});
}

/** Remove a case from a plan. Idempotent — returns the rows removed (0 or 1). */
export async function removeCaseFromPlan(input: {
	planId: string;
	testCaseId: string;
}): Promise<{ removed: number }> {
	const { count } = await db.testPlanCase.deleteMany({
		where: { planId: input.planId, testCaseId: input.testCaseId },
	});
	return { removed: count };
}

/**
 * Reorder the cases within a plan by writing each membership `order`. Scoped per
 * id to the plan so a foreign membership id is a silent no-op.
 */
export async function reorderPlanCases(
	planId: string,
	orders: { id: string; order: number }[],
): Promise<void> {
	await db.$transaction(
		orders.map(({ id, order }) =>
			db.testPlanCase.updateMany({
				where: { id, planId },
				data: { order },
			}),
		),
	);
}

/** List the ordered case memberships for a plan (case id/identifier/title/state). */
export async function listPlanCases(
	planId: string,
): Promise<TestPlanCaseLink[]> {
	return db.testPlanCase.findMany({
		where: { planId, testCase: { deletedAt: null } },
		orderBy: { order: "asc" },
		select: planCaseSelect,
	});
}
