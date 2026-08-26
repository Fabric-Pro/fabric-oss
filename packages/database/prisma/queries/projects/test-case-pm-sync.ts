/**
 * PM-sync selectors + writers for Test Cases (consumed by the Temporal sync
 * activities).
 *
 * Its own module because it serves a different reader than the app: the sync
 * activities need a narrow serialize-to-PM field subset and the external-ref
 * writer, neither of which the authoring path uses. Sibling of `test-cases.ts`
 * behind the same barrel, under the same `projectId` + `deletedAt: null`
 * scoping.
 */

import { db, type Prisma } from "../../client";

// ---------------------------------------------------------------------------
// Select shape
// ---------------------------------------------------------------------------

/**
 * Columns the PM-sync activities need to serialize a case to a PM tool —
 * identifier/title/description/steps + the external-ref + state subset.
 */
const testCaseSyncSelect = {
	id: true,
	identifier: true,
	title: true,
	description: true,
	state: true,
	priority: true,
	tags: true,
	externalId: true,
	externalUrl: true,
	externalMcpServerId: true,
	lastSyncedPmHash: true,
	pmAutoSyncEnabled: true,
	// Denormalized current run result — the execution-sync push reads it
	// to POST the case's outcome to the PM test-run/result API alongside the case.
	currentResult: true,
	steps: {
		orderBy: { order: "asc" },
		select: { id: true, order: true, action: true, expected: true },
	},
} as const;

export type TestCaseForSync = Prisma.TestCaseGetPayload<{
	select: typeof testCaseSyncSelect;
}>;

// ---------------------------------------------------------------------------
// PM-sync selectors + writers (consumed by the Temporal sync activities)
// ---------------------------------------------------------------------------

export async function getTestCaseForSync(input: {
	id: string;
	projectId: string;
}): Promise<TestCaseForSync | null> {
	return db.testCase.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: testCaseSyncSelect,
	});
}

export interface GetTestCasesToSyncInput {
	projectId: string;
	testCaseIds?: string[];
	unsyncedOnly?: boolean;
	direction?: "push" | "pull";
}

export async function getTestCasesToSync(
	input: GetTestCasesToSyncInput,
): Promise<TestCaseForSync[]> {
	const where: Prisma.TestCaseWhereInput = {
		projectId: input.projectId,
		deletedAt: null,
		...(input.testCaseIds && input.testCaseIds.length > 0
			? { id: { in: input.testCaseIds } }
			: {}),
	};
	if (input.direction === "pull") {
		// Pull: only cases already pushed (have an externalId).
		where.externalId = { not: null };
	} else if (input.unsyncedOnly) {
		// Push: only cases not yet synced.
		where.externalId = null;
	}

	return db.testCase.findMany({
		where,
		orderBy: { order: "asc" },
		select: testCaseSyncSelect,
	});
}

/**
 * Write the external PM refs back onto a case after a push/pull (stamps the
 * sync moment). Scoped to `id + projectId` (tenant guard) via `updateMany`.
 */
export async function updateTestCasePmRefs(input: {
	id: string;
	projectId: string;
	externalId: string;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	lastSyncedPmHash?: string | null;
}): Promise<void> {
	await db.testCase.updateMany({
		where: { id: input.id, projectId: input.projectId },
		data: {
			externalId: input.externalId,
			...(input.externalUrl !== undefined
				? { externalUrl: input.externalUrl }
				: {}),
			...(input.externalMcpServerId !== undefined
				? { externalMcpServerId: input.externalMcpServerId }
				: {}),
			...(input.lastSyncedPmHash !== undefined
				? { lastSyncedPmHash: input.lastSyncedPmHash }
				: {}),
			lastSyncedAt: new Date(),
		},
	});
}
