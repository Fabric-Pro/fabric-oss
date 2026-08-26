/**
 * Database queries for authored Test Cases — identifier generation, the case /
 * step select shapes, the automation link, CRUD, and work-item links.
 *
 * Project-scoped test cases with ordered Action/Expected steps, work-item
 * links, plan memberships, and a PM-sync field subset. Mirrors the tenant-XOR
 * pattern used by Architecture Decisions: tenant isolation is enforced by RLS +
 * the procedure layer; these helpers filter by `projectId` (+ `deletedAt: null`
 * for the soft-delete guard). Steps / links / plan memberships are child rows
 * reachable only through the parent case (no tenant columns of their own).
 *
 * The paths that serve their own readers live in siblings behind the same
 * barrel: `test-case-list.ts` (filters, sort, the paginated list),
 * `test-case-results.ts` (run results + rollups), `test-case-bulk.ts` (bulk
 * operations over a selection), and `test-case-pm-sync.ts` (PM-sync selectors +
 * writers).
 */

import {
	type AutomationStatus,
	db,
	type Prisma,
	type QaCoverageType,
	type TestCasePriority,
	type TestCaseScriptRevisionOrigin,
	type TestCaseState,
} from "../../client";
/**
 * The closed set of case states, in lifecycle order.
 *
 * Exported so the five procedures that validate a state, the coverage rollups
 * that exclude one, and the UI that renders them all read from ONE list. They
 * previously each restated `["DRAFT", "READY", "CLOSED"]`, which is how adding
 * PROPOSED could have shipped as a state the API silently rejected.
 */
export const TEST_CASE_STATES = [
	"PROPOSED",
	"DRAFT",
	"READY",
	"CLOSED",
] as const;

/**
 * States that do NOT count as coverage.
 *
 * Only PROPOSED. Nobody has agreed to a proposed case yet, so counting it would
 * make "tested by N cases" rise the moment an AI suggested something — the one
 * thing a coverage number must not do.
 *
 * CLOSED is deliberately NOT excluded, even though a retired case arguably tests
 * nothing. Excluding it would drop the number for every existing project, which
 * is a product change nobody asked for and has no business riding along with a
 * new state. Written as an exclusion rather than an inclusion precisely so that
 * stays visible: this list is what changed, and it contains one value that no
 * existing row can hold.
 */
export const NON_COVERAGE_STATES = ["PROPOSED"] as const;

import {
	diffTestCaseActivities,
	recordTestCaseActivities,
	recordTestCaseActivity,
} from "./test-case-activity";

// ---------------------------------------------------------------------------
// Identifier generation (TC-NNN, per project)
// ---------------------------------------------------------------------------

/**
 * Compute the next per-project test-case identifier (e.g. "TC-001"). Ordered by
 * `createdAt desc` (not the string) so it never breaks at the 999→1000 padding
 * boundary — numbers are assigned monotonically with creation. Mirrors
 * `generateArchitectureDecisionIdentifier`.
 *
 * Accepts an optional transaction client so the create path can allocate the
 * identifier inside the same `$transaction` as the insert (the
 * `@@unique([projectId, identifier])` constraint is the integrity backstop, with
 * a P2002 retry loop on the rare race).
 */
export async function generateTestCaseIdentifier(
	projectId: string,
	client: Prisma.TransactionClient | typeof db = db,
): Promise<string> {
	const last = await client.testCase.findFirst({
		where: { projectId },
		orderBy: { createdAt: "desc" },
		select: { identifier: true },
	});
	return nextTestCaseIdentifierFrom(last?.identifier);
}

function nextTestCaseIdentifierFrom(
	previous: string | undefined | null,
): string {
	if (!previous) {
		return "TC-001";
	}
	const match = previous.match(/TC-(\d+)/);
	const nextNum = match ? Number.parseInt(match[1], 10) + 1 : 1;
	return `TC-${String(nextNum).padStart(3, "0")}`;
}

function isUniqueIdentifierViolation(error: unknown): boolean {
	if (
		!(error instanceof Object) ||
		!("code" in error) ||
		(error as { code?: string }).code !== "P2002"
	) {
		return false;
	}
	// Only the (projectId, identifier) unique should drive the allocate-retry
	// loop. A P2002 from a different unique (e.g. duplicate work-item links on
	// the same case) must NOT be retried — it surfaces and maps to CONFLICT.
	const target = (error as { meta?: { target?: unknown } }).meta?.target;
	if (target == null) {
		// No constraint info — preserve the original allocate-retry behavior.
		return true;
	}
	const targetStr = Array.isArray(target) ? target.join(",") : String(target);
	return targetStr.includes("identifier");
}

// ---------------------------------------------------------------------------
// Select shapes
// ---------------------------------------------------------------------------

const testCaseStepSelect = {
	id: true,
	order: true,
	action: true,
	expected: true,
	data: true,
	sharedStepId: true,
} as const;

const testCaseDetailSelect = {
	id: true,
	projectId: true,
	identifier: true,
	title: true,
	description: true,
	state: true,
	priority: true,
	ownerId: true,
	tags: true,
	automationStatus: true,
	automationRef: true,
	automationFilePath: true,
	automationExternalUrl: true,
	playwrightScript: true,
	// Denormalized current run result — the drawer header Result pill.
	// Full provenance history is a separate read (`listTestCaseResultHistory`).
	currentResult: true,
	lastRunAt: true,
	lastRunSource: true,
	lastRunByLabel: true,
	order: true,
	createdById: true,
	externalId: true,
	externalUrl: true,
	externalMcpServerId: true,
	pmAutoSyncEnabled: true,
	lastSyncedPmHash: true,
	lastSyncedAt: true,
	lastPmSyncStatus: true,
	lastPmSyncError: true,
	lastPmSyncAttemptAt: true,
	contextId: true,
	userId: true,
	organizationId: true,
	createdAt: true,
	updatedAt: true,
	steps: { orderBy: { order: "asc" }, select: testCaseStepSelect },
	workItemLinks: {
		select: {
			id: true,
			userStoryId: true,
			acceptanceCriterionRefs: true,
			linkType: true,
			userStory: {
				select: { id: true, identifier: true, title: true, kind: true },
			},
		},
	},
	planLinks: {
		// Hide memberships whose plan was soft-deleted (the join row survives a
		// soft delete; FK cascade only fires on hard delete).
		where: { plan: { deletedAt: null } },
		select: {
			id: true,
			planId: true,
			section: true,
			order: true,
			plan: { select: { id: true, identifier: true, name: true } },
		},
	},
} as const;

export type TestCaseDetail = Prisma.TestCaseGetPayload<{
	select: typeof testCaseDetailSelect;
}>;

// ---------------------------------------------------------------------------
// Step input shape (shared by create / update / clone)
// ---------------------------------------------------------------------------

export interface TestCaseStepInput {
	/** Present when updating an existing step; omit for a new step. */
	id?: string;
	action: string;
	expected: string;
	/** Parameter hook (unused v1). */
	data?: Prisma.InputJsonValue;
	/** Shared-step hook (unused v1). */
	sharedStepId?: string | null;
}

/**
 * Clean a criterion-reference list before it is stored.
 *
 * Trims, drops blanks, and de-duplicates. All three matter and none is
 * cosmetic: a whitespace-only entry is a box somebody left empty rather than a
 * reference, and the same criterion listed twice would count as two covered
 * criteria in the coverage figure. Written once here so every writer agrees
 * rather than each remembering.
 */
export function normaliseCriterionRefs(
	refs: string[] | null | undefined,
): string[] {
	const seen = new Set<string>();
	for (const raw of refs ?? []) {
		const ref = raw.trim();
		if (ref) {
			seen.add(ref);
		}
	}
	return [...seen];
}

export interface TestCaseWorkItemLinkInput {
	userStoryId: string;
	/** Every criterion this case covers. Absent and empty both mean none. */
	acceptanceCriterionRefs?: string[] | null;
	linkType?: string;
}

// ---------------------------------------------------------------------------
// Automation link
// ---------------------------------------------------------------------------

/**
 * The automation fields accepted by create/update. `automationRef` is the
 * identifier the team links by; the others locate it (spec file, CI/report link).
 */
export interface TestCaseAutomationInput {
	automationRef?: string | null;
	automationFilePath?: string | null;
	automationExternalUrl?: string | null;
}

/**
 * Trim an automation field, collapsing blank input to null. `undefined` (field
 * absent) is preserved and distinct from null (explicit clear), so a partial
 * update never wipes a field the caller didn't mention. Blank and null collapse
 * to the same state so "cleared" and "never set" are indistinguishable — which
 * is what lets the automation stat key on NULL alone.
 */
function normalizeAutomationField(
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	return value?.trim() || null;
}

/**
 * Resolve the automationStatus that accompanies an automation-link write.
 *
 * A non-empty ref means the case IS automated, so the status follows the ref
 * automatically — this holds for every caller (procedures, AI-draft bulk, PM
 * sync), not just the ones that remember to set it. An explicitly supplied
 * status always wins, which is the escape hatch for recording a ref while the
 * case is still only PLANNED.
 *
 * Clearing the ref deliberately leaves the status alone: the status is intent a
 * user may have set on purpose, and silently downgrading it would be a
 * surprising side effect of editing a text field. The stat stays honest anyway,
 * because it counts refs rather than trusting the enum.
 */
function resolveAutomationStatus(
	explicit: AutomationStatus | undefined,
	normalizedRef: string | null | undefined,
): AutomationStatus | undefined {
	if (explicit !== undefined) {
		return explicit;
	}
	return normalizedRef ? "AUTOMATED" : undefined;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateTestCaseInput extends TestCaseAutomationInput {
	projectId: string;
	createdById: string;
	title: string;
	description?: string | null;
	state?: TestCaseState;
	priority?: TestCasePriority;
	ownerId?: string | null;
	tags?: string[];
	automationStatus?: AutomationStatus;
	/**
	 * Which level of the test pyramid the case sits at, when it is known at
	 * creation. Optional and nullable: a hand-authored case leaves it unset and
	 * the coverage matrix shows UNSET until somebody classifies it there.
	 */
	coverageType?: QaCoverageType | null;
	/** Ordered Action/Expected steps; the array order becomes `step.order`. */
	steps?: TestCaseStepInput[];
	/** Optional work-item links created atomically with the case. */
	workItemLinks?: TestCaseWorkItemLinkInput[];
	userId?: string | null;
	organizationId?: string | null;
	/**
	 * PM sync refs, stamped in the SAME insert as the case (the pull/import path).
	 * Creating a linked case in one statement avoids the create-then-link window
	 * that could otherwise orphan an `externalId`-null draft on a mid-op failure.
	 */
	externalId?: string | null;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	lastSyncedPmHash?: string | null;
	lastSyncedAt?: Date | null;
}

export async function createTestCase(
	input: CreateTestCaseInput,
): Promise<TestCaseDetail> {
	// Retry on the rare identifier race (two concurrent creates) — the
	// @@unique([projectId, identifier]) constraint is the integrity backstop.
	for (let attempt = 0; ; attempt++) {
		try {
			return await db.$transaction(async (tx) => {
				const identifier = await generateTestCaseIdentifier(
					input.projectId,
					tx,
				);
				const last = await tx.testCase.findFirst({
					where: { projectId: input.projectId },
					orderBy: { order: "desc" },
					select: { order: true },
				});
				const order = (last?.order ?? 0) + 1;

				const automationRef = normalizeAutomationField(
					input.automationRef,
				);

				const testCase = await tx.testCase.create({
					data: {
						projectId: input.projectId,
						identifier,
						createdById: input.createdById,
						title: input.title,
						description: input.description ?? null,
						state: input.state ?? "DRAFT",
						priority: input.priority ?? "MEDIUM",
						ownerId: input.ownerId ?? null,
						tags: input.tags ?? [],
						automationStatus:
							resolveAutomationStatus(
								input.automationStatus,
								automationRef,
							) ?? "NOT_AUTOMATED",
						automationRef: automationRef ?? null,
						automationFilePath:
							normalizeAutomationField(
								input.automationFilePath,
							) ?? null,
						automationExternalUrl:
							normalizeAutomationField(
								input.automationExternalUrl,
							) ?? null,
						order,
						userId: input.userId ?? null,
						organizationId: input.organizationId ?? null,
						// PM refs (import path) — set atomically with the insert.
						...(input.externalId
							? { externalId: input.externalId }
							: {}),
						...(input.externalUrl !== undefined
							? { externalUrl: input.externalUrl }
							: {}),
						...(input.externalMcpServerId !== undefined
							? { externalMcpServerId: input.externalMcpServerId }
							: {}),
						...(input.lastSyncedPmHash !== undefined
							? { lastSyncedPmHash: input.lastSyncedPmHash }
							: {}),
						...(input.lastSyncedAt
							? { lastSyncedAt: input.lastSyncedAt }
							: {}),
						steps: input.steps
							? {
									create: input.steps.map((s, i) => ({
										order: i,
										action: s.action,
										expected: s.expected,
										data: s.data ?? undefined,
										sharedStepId: s.sharedStepId ?? null,
									})),
								}
							: undefined,
						workItemLinks:
							input.workItemLinks &&
							input.workItemLinks.length > 0
								? {
										create: input.workItemLinks.map(
											(l) => ({
												userStoryId: l.userStoryId,
												acceptanceCriterionRefs:
													normaliseCriterionRefs(
														l.acceptanceCriterionRefs,
													),
												linkType: l.linkType ?? "TESTS",
											}),
										),
									}
								: undefined,
					},
					select: testCaseDetailSelect,
				});

				// Birth event — provenance for the case's activity timeline. An
				// import (PM refs present) is machine-created; otherwise it is
				// the authoring user.
				await recordTestCaseActivity(tx, {
					testCaseId: testCase.id,
					type: "CREATED",
					actorUserId: input.externalId ? null : input.createdById,
					actorLabel: input.externalId ? "Imported" : null,
				});

				return testCase;
			});
		} catch (error) {
			if (isUniqueIdentifierViolation(error) && attempt < 3) {
				continue;
			}
			throw error;
		}
	}
}

/**
 * Bulk-create cases in a single transaction with an in-loop identifier counter
 * (mirrors `generateTaskIdentifier`'s bulk path) — used by the AI-draft flow so
 * N cases get sequential `TC-NNN` ids + links without N round-trips. The whole
 * transaction retries on the rare identifier race.
 */
export async function bulkCreateTestCases(input: {
	projectId: string;
	createdById: string;
	userId?: string | null;
	organizationId?: string | null;
	cases: Array<
		Omit<
			CreateTestCaseInput,
			"projectId" | "createdById" | "userId" | "organizationId"
		>
	>;
	/**
	 * Provenance for the birth event on each case's activity timeline. The AI
	 * draft flow passes `{ label: "AI draft", draftJobId }` so the timeline
	 * shows the case was drafted (not hand-authored) and by which run. Absent =
	 * a plain CREATED with `createdById` as the actor.
	 */
	createdVia?: { label: string; draftJobId?: string };
	/**
	 * Fingerprint of the feature text these cases were drafted from, so the case
	 * can later be told apart from the feature as it stands now. A per-call field
	 * rather than per-case: one draft reads one feature, so every case it
	 * produces shares the same source text. Absent for hand-authored cases —
	 * which cannot drift from text they never came from.
	 */
	draftedFromSpecHash?: string | null;
}): Promise<TestCaseDetail[]> {
	if (input.cases.length === 0) {
		return [];
	}
	for (let attempt = 0; ; attempt++) {
		try {
			return await db.$transaction(async (tx) => {
				const lastId = await tx.testCase.findFirst({
					where: { projectId: input.projectId },
					orderBy: { createdAt: "desc" },
					select: { identifier: true },
				});
				const lastOrder = await tx.testCase.findFirst({
					where: { projectId: input.projectId },
					orderBy: { order: "desc" },
					select: { order: true },
				});
				const startMatch = lastId?.identifier?.match(/TC-(\d+)/);
				let nextNum = startMatch
					? Number.parseInt(startMatch[1], 10) + 1
					: 1;
				let order = lastOrder?.order ?? 0;

				const created: TestCaseDetail[] = [];
				for (const c of input.cases) {
					order += 1;
					const identifier = `TC-${String(nextNum).padStart(3, "0")}`;
					nextNum += 1;
					const automationRef = normalizeAutomationField(
						c.automationRef,
					);
					created.push(
						await tx.testCase.create({
							data: {
								projectId: input.projectId,
								identifier,
								createdById: input.createdById,
								title: c.title,
								description: c.description ?? null,
								state: c.state ?? "DRAFT",
								priority: c.priority ?? "MEDIUM",
								coverageType: c.coverageType ?? null,
								draftedFromSpecHash:
									input.draftedFromSpecHash ?? null,
								ownerId: c.ownerId ?? null,
								tags: c.tags ?? [],
								automationStatus:
									resolveAutomationStatus(
										c.automationStatus,
										automationRef,
									) ?? "NOT_AUTOMATED",
								automationRef: automationRef ?? null,
								automationFilePath:
									normalizeAutomationField(
										c.automationFilePath,
									) ?? null,
								automationExternalUrl:
									normalizeAutomationField(
										c.automationExternalUrl,
									) ?? null,
								order,
								userId: input.userId ?? null,
								organizationId: input.organizationId ?? null,
								steps: c.steps
									? {
											create: c.steps.map((s, i) => ({
												order: i,
												action: s.action,
												expected: s.expected,
												data: s.data ?? undefined,
												sharedStepId:
													s.sharedStepId ?? null,
											})),
										}
									: undefined,
								workItemLinks:
									c.workItemLinks &&
									c.workItemLinks.length > 0
										? {
												create: c.workItemLinks.map(
													(l) => ({
														userStoryId:
															l.userStoryId,
														acceptanceCriterionRefs:
															normaliseCriterionRefs(
																l.acceptanceCriterionRefs,
															),
														linkType:
															l.linkType ??
															"TESTS",
													}),
												),
											}
										: undefined,
							},
							select: testCaseDetailSelect,
						}),
					);
				}

				// Birth events for the whole batch in one write. AI-drafted
				// cases carry the drafter label + run id; a plain bulk create
				// records the authoring user.
				await recordTestCaseActivities(
					tx,
					created.map((testCase) => ({
						testCaseId: testCase.id,
						type: "CREATED" as const,
						actorUserId: input.createdVia
							? null
							: input.createdById,
						actorLabel: input.createdVia?.label ?? null,
						...(input.createdVia?.draftJobId
							? {
									metadata: {
										draftJobId: input.createdVia.draftJobId,
									},
								}
							: {}),
					})),
				);
				return created;
			});
		} catch (error) {
			if (isUniqueIdentifierViolation(error) && attempt < 3) {
				continue;
			}
			throw error;
		}
	}
}

export async function getTestCase(input: {
	id: string;
	projectId: string;
}): Promise<TestCaseDetail | null> {
	return db.testCase.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: testCaseDetailSelect,
	});
}

export interface UpdateTestCaseInput {
	id: string;
	projectId: string;
	data: TestCaseAutomationInput & {
		title?: string;
		description?: string | null;
		state?: TestCaseState;
		priority?: TestCasePriority;
		ownerId?: string | null;
		tags?: string[];
		automationStatus?: AutomationStatus;
		playwrightScript?: string | null;
		pmAutoSyncEnabled?: boolean;
		/**
		 * Full ordered step list (replace semantics): steps with an `id` that
		 * still exists are updated in place, omitted ids are deleted, and
		 * id-less entries are created. The array order becomes `step.order`.
		 */
		steps?: TestCaseStepInput[];
	};
	/** The Fabric user making the edit — recorded on each activity event. */
	actorUserId?: string | null;
	/** Provenance for a changed Mode B script; omitted means a manual edit. */
	scriptRevision?: {
		origin: TestCaseScriptRevisionOrigin;
		sourceResultEventId?: string | null;
		restoredFromRevisionId?: string | null;
	};
}

/**
 * Update a case's scalar fields and (optionally) replace its step list. Returns
 * null when the case does not exist (or is soft-deleted) within the project.
 *
 * Every field that genuinely changes is recorded on the case's activity
 * timeline (state / priority / title / automation / step-count), diffed against
 * the row as it was before this write — a no-op save records nothing.
 */
export async function updateTestCase(
	input: UpdateTestCaseInput,
): Promise<TestCaseDetail | null> {
	return db.$transaction(async (tx) => {
		const existing = await tx.testCase.findFirst({
			where: {
				id: input.id,
				projectId: input.projectId,
				deletedAt: null,
			},
			select: {
				id: true,
				state: true,
				priority: true,
				title: true,
				automationStatus: true,
				playwrightScript: true,
				_count: { select: { steps: true } },
			},
		});
		if (!existing) {
			return null;
		}

		const d = input.data;
		const automationRef = normalizeAutomationField(d.automationRef);
		const automationFilePath = normalizeAutomationField(
			d.automationFilePath,
		);
		const automationExternalUrl = normalizeAutomationField(
			d.automationExternalUrl,
		);
		const automationStatus = resolveAutomationStatus(
			d.automationStatus,
			automationRef,
		);
		const playwrightScript =
			d.playwrightScript === undefined
				? undefined
				: d.playwrightScript?.trim()
					? d.playwrightScript
					: null;
		const scriptChanged =
			playwrightScript !== undefined &&
			playwrightScript !== existing.playwrightScript;
		const resolvedAutomationStatus =
			automationStatus ??
			(scriptChanged
				? playwrightScript
					? "AUTOMATED"
					: "NOT_AUTOMATED"
				: undefined);
		await tx.testCase.update({
			where: { id: input.id },
			data: {
				...(d.title !== undefined ? { title: d.title } : {}),
				...(d.description !== undefined
					? { description: d.description }
					: {}),
				...(d.state !== undefined ? { state: d.state } : {}),
				...(d.priority !== undefined ? { priority: d.priority } : {}),
				...(d.ownerId !== undefined ? { ownerId: d.ownerId } : {}),
				...(d.tags !== undefined ? { tags: d.tags } : {}),
				...(resolvedAutomationStatus !== undefined
					? { automationStatus: resolvedAutomationStatus }
					: {}),
				...(automationRef !== undefined ? { automationRef } : {}),
				...(automationFilePath !== undefined
					? { automationFilePath }
					: {}),
				...(automationExternalUrl !== undefined
					? { automationExternalUrl }
					: {}),
				...(playwrightScript !== undefined ? { playwrightScript } : {}),
				...(d.pmAutoSyncEnabled !== undefined
					? { pmAutoSyncEnabled: d.pmAutoSyncEnabled }
					: {}),
			},
		});

		if (d.steps !== undefined) {
			await replaceTestCaseSteps(tx, input.id, d.steps);
		}

		if (scriptChanged) {
			const author = input.actorUserId
				? await tx.user.findUnique({
						where: { id: input.actorUserId },
						select: { name: true, email: true },
					})
				: null;
			await tx.testCaseScriptRevision.create({
				data: {
					projectId: input.projectId,
					testCaseId: input.id,
					script: playwrightScript ?? "",
					origin: input.scriptRevision?.origin ?? "MANUAL",
					authoredByUserId: input.actorUserId ?? null,
					authorNameSnapshot: author?.name ?? null,
					authorEmailSnapshot: author?.email ?? null,
					sourceResultEventId:
						input.scriptRevision?.sourceResultEventId ?? null,
					restoredFromRevisionId:
						input.scriptRevision?.restoredFromRevisionId ?? null,
				},
			});
		}

		// Diff the tracked fields against the pre-update row and record every
		// real change. `after` falls back to the existing value wherever the
		// caller didn't send a field, so an untouched field never looks changed.
		await recordTestCaseActivities(
			tx,
			diffTestCaseActivities({
				testCaseId: input.id,
				actorUserId: input.actorUserId,
				before: {
					state: existing.state,
					priority: existing.priority,
					title: existing.title,
					automationStatus: existing.automationStatus,
					stepCount: existing._count.steps,
				},
				after: {
					state: d.state ?? existing.state,
					priority: d.priority ?? existing.priority,
					title: d.title ?? existing.title,
					automationStatus:
						automationStatus ?? existing.automationStatus,
					stepCount:
						d.steps !== undefined
							? d.steps.length
							: existing._count.steps,
				},
			}),
		);

		return tx.testCase.findFirst({
			where: { id: input.id, projectId: input.projectId },
			select: testCaseDetailSelect,
		});
	});
}

/**
 * Replace a case's steps to match `incoming` exactly (delete-missing,
 * update-by-id, create-the-rest), re-numbering `order` to the array position.
 * Update/delete are scoped to `testCaseId` so a foreign step id can never be
 * touched.
 */
async function replaceTestCaseSteps(
	tx: Prisma.TransactionClient,
	testCaseId: string,
	incoming: TestCaseStepInput[],
): Promise<void> {
	const existing = await tx.testCaseStep.findMany({
		where: { testCaseId },
		select: { id: true },
	});
	const existingIds = new Set(existing.map((s) => s.id));
	const keepIds = incoming
		.map((s) => s.id)
		.filter(
			(id): id is string => Boolean(id) && existingIds.has(id as string),
		);

	await tx.testCaseStep.deleteMany({
		where: {
			testCaseId,
			...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
		},
	});

	for (let i = 0; i < incoming.length; i++) {
		const s = incoming[i];
		if (s.id && existingIds.has(s.id)) {
			await tx.testCaseStep.update({
				where: { id: s.id },
				data: {
					order: i,
					action: s.action,
					expected: s.expected,
					data: s.data ?? undefined,
					sharedStepId: s.sharedStepId ?? null,
				},
			});
		} else {
			await tx.testCaseStep.create({
				data: {
					testCaseId,
					order: i,
					action: s.action,
					expected: s.expected,
					data: s.data ?? undefined,
					sharedStepId: s.sharedStepId ?? null,
				},
			});
		}
	}
}

/**
 * Reorder cases within a project by writing each `order`. Scoped per id to the
 * project + live rows (tenant + soft-delete guard) so a foreign/deleted id is a
 * silent no-op.
 */
export async function reorderTestCases(
	projectId: string,
	orders: { id: string; order: number }[],
): Promise<void> {
	await db.$transaction(
		orders.map(({ id, order }) =>
			db.testCase.updateMany({
				where: { id, projectId, deletedAt: null },
				data: { order },
			}),
		),
	);
}

/**
 * Soft-delete a case. Returns `{ id, contextId }` so the caller can clean up the
 * mirrored RAG ProjectContext + its embedding, or null if not found. Mirrors
 * `softDeleteArchitectureDecision`.
 */
export async function softDeleteTestCase(input: {
	id: string;
	projectId: string;
}): Promise<{ id: string; contextId: string | null } | null> {
	const existing = await db.testCase.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: { id: true, contextId: true },
	});
	if (!existing) {
		return null;
	}

	await db.testCase.update({
		where: { id: input.id },
		data: { deletedAt: new Date() },
	});
	return existing;
}

/**
 * Deep-copy a case (+ steps) into a new DRAFT case with a fresh identifier. The
 * clone is local-only: `externalId`/PM-sync refs are dropped and `contextId` is
 * null (the new case mirrors into its own ProjectContext on first save).
 * Returns null if the source case is missing within the project.
 */
export async function cloneTestCase(input: {
	id: string;
	projectId: string;
	actorUserId: string;
}): Promise<TestCaseDetail | null> {
	const source = await db.testCase.findFirst({
		where: { id: input.id, projectId: input.projectId, deletedAt: null },
		select: {
			title: true,
			description: true,
			priority: true,
			ownerId: true,
			tags: true,
			automationStatus: true,
			userId: true,
			organizationId: true,
			steps: {
				orderBy: { order: "asc" },
				select: {
					order: true,
					action: true,
					expected: true,
					data: true,
					sharedStepId: true,
				},
			},
		},
	});
	if (!source) {
		return null;
	}

	for (let attempt = 0; ; attempt++) {
		try {
			return await db.$transaction(async (tx) => {
				const identifier = await generateTestCaseIdentifier(
					input.projectId,
					tx,
				);
				const last = await tx.testCase.findFirst({
					where: { projectId: input.projectId },
					orderBy: { order: "desc" },
					select: { order: true },
				});
				const order = (last?.order ?? 0) + 1;

				const clone = await tx.testCase.create({
					data: {
						projectId: input.projectId,
						identifier,
						createdById: input.actorUserId,
						title: source.title,
						description: source.description,
						state: "DRAFT",
						priority: source.priority,
						ownerId: source.ownerId,
						tags: source.tags,
						automationStatus: source.automationStatus,
						order,
						userId: source.userId,
						organizationId: source.organizationId,
						steps: {
							create: source.steps.map((s) => ({
								order: s.order,
								action: s.action,
								expected: s.expected,
								data: s.data ?? undefined,
								sharedStepId: s.sharedStepId,
							})),
						},
					},
					select: testCaseDetailSelect,
				});

				// Birth event for the clone, tagged with its source case.
				await recordTestCaseActivity(tx, {
					testCaseId: clone.id,
					type: "CREATED",
					actorUserId: input.actorUserId,
					actorLabel: "Cloned",
					metadata: { clonedFromId: input.id },
				});
				return clone;
			});
		} catch (error) {
			if (isUniqueIdentifierViolation(error) && attempt < 3) {
				continue;
			}
			throw error;
		}
	}
}

/** Persist the mirrored ProjectContext id back onto the case (AC7 RAG link). */
export async function setTestCaseContextId(input: {
	id: string;
	contextId: string | null;
}) {
	return db.testCase.update({
		where: { id: input.id },
		data: { contextId: input.contextId },
		select: { id: true, contextId: true },
	});
}

// ---------------------------------------------------------------------------
// Work-item links + coverage rollup
// ---------------------------------------------------------------------------

/**
 * Link a case to a feature/bug (idempotent upsert on the
 * `(testCaseId, userStoryId)` unique key). Re-linking updates the optional
 * `acceptanceCriterionRefs` / `linkType`. The caller (procedure layer) verifies
 * the story belongs to the project.
 */
export async function linkTestCaseToWorkItem(input: {
	testCaseId: string;
	userStoryId: string;
	acceptanceCriterionRefs?: string[] | null;
	linkType?: string;
}) {
	return db.testCaseWorkItemLink.upsert({
		where: {
			testCaseId_userStoryId: {
				testCaseId: input.testCaseId,
				userStoryId: input.userStoryId,
			},
		},
		create: {
			testCaseId: input.testCaseId,
			userStoryId: input.userStoryId,
			acceptanceCriterionRefs: normaliseCriterionRefs(
				input.acceptanceCriterionRefs,
			),
			linkType: input.linkType ?? "TESTS",
		},
		update: {
			acceptanceCriterionRefs: normaliseCriterionRefs(
				input.acceptanceCriterionRefs,
			),
			...(input.linkType ? { linkType: input.linkType } : {}),
		},
	});
}

/** Remove a case↔work-item link. Idempotent — returns the rows removed (0 or 1). */
export async function unlinkTestCaseFromWorkItem(input: {
	testCaseId: string;
	userStoryId: string;
}): Promise<{ removed: number }> {
	const { count } = await db.testCaseWorkItemLink.deleteMany({
		where: {
			testCaseId: input.testCaseId,
			userStoryId: input.userStoryId,
		},
	});
	return { removed: count };
}

/**
 * Light coverage rollup: how many live cases are linked to a story. Backs the
 * read-only "Tested by N cases" line on the feature (R5) — not the coverage
 * engine.
 */
export async function countTestCasesForStory(input: {
	storyId: string;
	projectId: string;
}): Promise<number> {
	return db.testCase.count({
		where: {
			projectId: input.projectId,
			deletedAt: null,
			// A PROPOSED case is a suggestion nobody has accepted. Counting it
			// would make this number rise because an AI spoke, not because
			// anything is more tested.
			state: { notIn: [...NON_COVERAGE_STATES] },
			workItemLinks: { some: { userStoryId: input.storyId } },
		},
	});
}
