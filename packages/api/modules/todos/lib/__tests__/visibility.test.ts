/**
 * The To Do list's visibility rules (#2340).
 *
 * Three seams, because the rules are decided in three different places and
 * only one of them touches a database:
 *
 *  1. **`deriveTodoVisibility` — pure.** Every rule worth arguing about
 *     (who is a Product Owner here, which projects fall back to their admins,
 *     whose Unassigned bucket opens expanded) is decided from plain rows, so
 *     the scenarios below are ordinary function calls with no mocks at all.
 *  2. **`accessibleProjectWhere` — the Prisma filter.** Asserted structurally:
 *     the soft-delete exclusion and the absence of a bare creator arm are the
 *     two things that must never be edited away, and both are visible in the
 *     object.
 *  3. **`todoVisibilityCondition` — the SQL rendering.** Asserted on its
 *     PARAMETERS, which is where the scope actually reaches Postgres. The
 *     stakeholder arm's two parallel arrays are checked for alignment, since a
 *     mis-zip there is exactly how one project's Product Owner would start
 *     seeing another project's stakeholder rows.
 *  4. **`isTodoVisibleTo` — the same rule in memory.** The form every to-do
 *     WRITE evaluates, so that a row the caller cannot see is a row they cannot
 *     change. The matrix at the end walks one row shape per arm — and one that
 *     matches no arm — through it, and the SQL assertions above pin the same
 *     arms in the other rendering. The two drifting apart is the defect this
 *     pairing exists to prevent: the writes used to ask a different question
 *     and let a member change a to-do assigned to a colleague.
 *
 * Row-level outcomes against real SQL (a snoozed row's absence, the hidden
 * count) belong to `packages/database/prisma/queries/todos/__tests__/`, which
 * pins the statement itself.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dbMock: {
		project: { findMany: vi.fn() },
		projectUserFunctionTag: { findMany: vi.fn() },
	},
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: mocks.dbMock };
});

const {
	TODO_AGE_THRESHOLD_DAYS,
	TODO_RECENCY_FLOOR,
	TODO_RECENT_COMPLETED_LIMIT,
	accessibleProjectWhere,
	deriveTodoVisibility,
	isTodoVisibleTo,
	resolveTodoVisibility,
	todoVisibilityCondition,
} = await import("../visibility");

const VIEWER = "user-viewer";
const ORG = "org-acme";
const NOW = new Date("2026-09-18T12:00:00.000Z");

function project(
	id: string,
	overrides: { createdById?: string; adminUserIds?: string[] } = {},
) {
	return {
		id,
		createdById: overrides.createdById ?? "user-someone-else",
		adminUserIds: overrides.adminUserIds ?? [],
	};
}

function derive(
	projects: ReturnType<typeof project>[],
	confirmedTags: Array<{
		projectId: string;
		userId: string;
		tags: string[];
	}> = [],
) {
	return deriveTodoVisibility({
		viewerUserId: VIEWER,
		organizationId: ORG,
		projects,
		confirmedTags,
	});
}

// ---------------------------------------------------------------------------
// The constants are the product rule, so they are pinned rather than inferred
// ---------------------------------------------------------------------------

describe("visibility constants", () => {
	it("hides a to-do after thirty days and keeps the ten most recent", () => {
		expect(TODO_AGE_THRESHOLD_DAYS).toBe(30);
		expect(TODO_RECENCY_FLOOR).toBe(10);
		expect(TODO_RECENT_COMPLETED_LIMIT).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// accessibleProjectWhere
// ---------------------------------------------------------------------------

describe("accessibleProjectWhere", () => {
	it("excludes soft-deleted projects and pins the organization", () => {
		const where = accessibleProjectWhere(VIEWER, ORG, NOW);

		// A soft delete fires no cascade, so this clause is the only thing
		// keeping a deleted project's to-dos off the page.
		expect(where.deletedAt).toBeNull();
		expect(where.organizationId).toBe(ORG);
	});

	it("offers project membership and organization membership, and nothing else", () => {
		const where = accessibleProjectWhere(VIEWER, ORG, NOW);
		const paths = (where.OR ?? []) as Array<Record<string, unknown>>;

		expect(paths).toHaveLength(2);
		// Deliberately NOT the notification filter's personal-owner arm: a bare
		// `{ userId }` under an org-pinned query keeps a project reachable for
		// someone who created it and has since left the organization.
		expect(paths).not.toContainEqual({ userId: VIEWER });
		expect(paths[0]).toEqual({
			members: {
				some: {
					userId: VIEWER,
					acceptedAt: { not: null },
					OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
				},
			},
		});
		expect(paths[1]).toEqual({
			organization: { members: { some: { userId: VIEWER } } },
		});
	});
});

// ---------------------------------------------------------------------------
// deriveTodoVisibility
// ---------------------------------------------------------------------------

describe("deriveTodoVisibility", () => {
	it("gives a viewer with no projects an empty scope rather than a wide one", () => {
		const visibility = derive([]);

		expect(visibility.accessibleProjectIds).toEqual([]);
		expect(visibility.productOwnerProjects).toEqual([]);
		expect(visibility.contactFallbackProjectIds).toEqual([]);
		expect(visibility.unassignedExpandedProjectIds).toEqual([]);
	});

	it("limits a guest to the one project they were invited to", () => {
		// The guest reaches project-1 through an accepted membership; project-2
		// never enters the fetched set, so nothing downstream can reach it.
		const visibility = derive([project("project-1")]);

		expect(visibility.accessibleProjectIds).toEqual(["project-1"]);
		expect(visibility.productOwnerProjects).toEqual([]);
		// A guest administers nothing, so no contact rows fall to them.
		expect(visibility.contactFallbackProjectIds).toEqual([]);
	});

	it("gives a confirmed Product Owner their project's stakeholders and contacts, and no other project's", () => {
		const visibility = derive(
			[project("project-1"), project("project-2")],
			[
				{
					projectId: "project-1",
					userId: VIEWER,
					tags: ["PRODUCT_OWNER"],
				},
				{
					projectId: "project-1",
					userId: "user-stakeholder",
					tags: ["STAKEHOLDER"],
				},
				// The SAME person is a stakeholder on project-2, where the
				// viewer is nothing in particular. This must not follow them.
				{
					projectId: "project-2",
					userId: "user-stakeholder",
					tags: ["STAKEHOLDER"],
				},
				{
					projectId: "project-2",
					userId: "user-other-po",
					tags: ["PRODUCT_OWNER"],
				},
			],
		);

		expect(visibility.productOwnerProjects).toEqual([
			{
				projectId: "project-1",
				stakeholderUserIds: ["user-stakeholder"],
			},
		]);
		// project-2 has its own confirmed Product Owner, so it does not fall
		// back to anyone either.
		expect(visibility.contactFallbackProjectIds).toEqual([]);
	});

	it("does not grant Product Owner visibility from an UNCONFIRMED tag", () => {
		// `resolveTodoVisibility` never fetches an unconfirmed row (asserted
		// below), so an unconfirmed tag reaches this function as no row at all
		// — which is the correct default for someone who has never confirmed
		// what they do on this project.
		const visibility = derive([project("project-1")], []);

		expect(visibility.productOwnerProjects).toEqual([]);
	});

	it("falls a project's contact rows back to its admins when nobody confirmed a Product Owner", () => {
		const visibility = derive(
			[
				project("project-1", { adminUserIds: [VIEWER] }),
				project("project-2", { createdById: VIEWER }),
				project("project-3"),
			],
			[
				{
					projectId: "project-3",
					userId: "user-other",
					tags: ["PRODUCT_OWNER"],
				},
			],
		);

		// Otherwise a contact's obligations on project-1 and project-2 would be
		// visible to nobody at all.
		expect(visibility.contactFallbackProjectIds).toEqual([
			"project-1",
			"project-2",
		]);
	});

	it("does not fall back on a project that HAS a confirmed Product Owner, even for its admin", () => {
		const visibility = derive(
			[project("project-1", { adminUserIds: [VIEWER] })],
			[
				{
					projectId: "project-1",
					userId: "user-po",
					tags: ["PRODUCT_OWNER"],
				},
			],
		);

		expect(visibility.contactFallbackProjectIds).toEqual([]);
	});

	describe("Unassigned bucket default expansion", () => {
		it("expands for a confirmed PRODUCT_OWNER or PRODUCT_CONTRIBUTOR", () => {
			const visibility = derive(
				[project("project-1"), project("project-2")],
				[
					{
						projectId: "project-1",
						userId: VIEWER,
						tags: ["PRODUCT_OWNER"],
					},
					{
						projectId: "project-2",
						userId: VIEWER,
						tags: ["PRODUCT_CONTRIBUTOR"],
					},
				],
			);

			expect(visibility.unassignedExpandedProjectIds).toEqual([
				"project-1",
				"project-2",
			]);
		});

		it("falls back to admins and creators only where the viewer has no confirmed tag", () => {
			const visibility = derive(
				[
					project("project-1", { adminUserIds: [VIEWER] }),
					project("project-2", { createdById: VIEWER }),
					project("project-3", { adminUserIds: [VIEWER] }),
				],
				[
					// The viewer HAS answered on project-3, and said something
					// else. The admin fallback must not overrule that answer.
					{
						projectId: "project-3",
						userId: VIEWER,
						tags: ["DEVELOPER"],
					},
				],
			);

			expect(visibility.unassignedExpandedProjectIds).toEqual([
				"project-1",
				"project-2",
			]);
		});

		it("leaves it collapsed for a plain member", () => {
			const visibility = derive([project("project-1")]);

			expect(visibility.unassignedExpandedProjectIds).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// todoVisibilityCondition
// ---------------------------------------------------------------------------

/** Flattens the rendered statement so assertions survive re-indentation. */
function sqlText(fragment: { sql: string }): string {
	return fragment.sql.replace(/\s+/g, " ").trim();
}

describe("todoVisibilityCondition", () => {
	it("gates every arm on the accessible projects, so no arm can reach outside them", () => {
		const condition = todoVisibilityCondition(
			derive([project("project-1")]),
		);

		expect(sqlText(condition)).toContain(
			'(t."projectId" IS NULL OR t."projectId" = ANY(',
		);
		// The viewer's own id is the first parameter after the two accessible
		// project arrays — the "own to-dos, always" arm.
		expect(condition.values).toContain(VIEWER);
	});

	it("matches a viewer with no projects against nothing rather than everything", () => {
		const condition = todoVisibilityCondition(derive([]));

		// Empty arrays are safe by construction: `= ANY('{}')` is false and an
		// `unnest` of empty arrays yields no rows. In order: the access gate,
		// the viewer's id for arm 1, the Unassigned arm's gate, the
		// contact-visible projects, the two stakeholder arrays, then the
		// viewer's id again for arm 5.
		expect(condition.values).toEqual([[], VIEWER, [], [], [], [], VIEWER]);
	});

	it("keeps an organization-level row reachable through its writer, not through everyone", () => {
		// A to-do with no project used to be reachable in two wrong ways and one
		// missing one. Assigned to a contact it matched NO arm at all -- arm 1
		// needs the viewer as assignee, arm 2 needed no assignee, arm 4 pairs on
		// a project id, and `NULL = ANY(...)` is NULL rather than true -- so the
		// row vanished from every view for every viewer. Left unassigned it went
		// the other way and showed on every member's page. Arm 5 replaces both:
		// a project-less row is always MANUAL, and it belongs to whoever wrote
		// it.
		const condition = todoVisibilityCondition(
			derive([project("project-1")]),
		);
		const text = sqlText(condition);

		expect(text).toContain('t."source" = \'MANUAL\' AND t."userId" =');
		// And neither of the two project-scoped arms answers for a NULL project
		// any more, which is what kept the row off other people's pages.
		const unassignedArm = text.split('t."assigneeUserId" IS NULL')[1];
		expect(unassignedArm.split("OR (")[0]).not.toContain(
			't."projectId" IS NULL',
		);
		const contactArm = text.split('t."assigneeContactId" IS NOT NULL')[1];
		expect(contactArm.split("OR ")[0]).not.toContain(
			't."projectId" IS NULL',
		);
	});

	it("keeps the stakeholder pairs aligned, so a Product Owner of one project cannot see another's", () => {
		const visibility = derive(
			[project("project-1"), project("project-2")],
			[
				{
					projectId: "project-1",
					userId: VIEWER,
					tags: ["PRODUCT_OWNER"],
				},
				{
					projectId: "project-1",
					userId: "user-a",
					tags: ["STAKEHOLDER"],
				},
				{
					projectId: "project-1",
					userId: "user-b",
					tags: ["STAKEHOLDER"],
				},
				{
					projectId: "project-2",
					userId: VIEWER,
					tags: ["PRODUCT_OWNER"],
				},
				{
					projectId: "project-2",
					userId: "user-c",
					tags: ["STAKEHOLDER"],
				},
			],
		);

		const condition = todoVisibilityCondition(visibility);
		const values = condition.values as unknown[];
		// Positional, not "the last two": arm 5 appends the viewer id after
		// them, and reading from the end silently followed that move.
		const stakeholderProjectIds = values[4] as string[];
		const stakeholderUserIds = values[5] as string[];

		expect(stakeholderProjectIds).toEqual([
			"project-1",
			"project-1",
			"project-2",
		]);
		expect(stakeholderUserIds).toEqual(["user-a", "user-b", "user-c"]);
		expect(sqlText(condition)).toContain(
			'WHERE pair."projectId" = t."projectId" AND pair."userId" = t."assigneeUserId"',
		);
	});

	it("keeps a MANUAL row reachable by whoever wrote it, and only a MANUAL one", () => {
		// Arm 1 asks who a row is assigned TO, so without this arm the person
		// who wrote a to-do and handed it to a colleague matched nothing and
		// could neither see it nor take it back. The MANUAL restriction is the
		// arm's safety: on a meeting-sourced row `userId` is the transcript
		// owner — whose MEETING it was — so an unscoped arm would hand every
		// host their whole meeting's action items whoever owes them.
		const condition = todoVisibilityCondition(
			derive([project("project-1")]),
		);
		const text = sqlText(condition);

		// The owner id is a PARAMETER; only the enum literal is inlined, and
		// only because a text parameter could not be compared to the column
		// without a cast of its own.
		expect(text).toContain(`t."source" = 'MANUAL' AND t."userId" = ?`);
		expect(condition.values.at(-1)).toBe(VIEWER);
		// Inside the project-access gate like every other arm: a creator who
		// has since lost the project loses its rows with it.
		expect(text.indexOf('t."source"')).toBeGreaterThan(
			text.indexOf('(t."projectId" IS NULL OR t."projectId" = ANY('),
		);
	});

	it("offers contact rows on Product Owner projects and on the admin fallback projects together", () => {
		const visibility = derive(
			[
				project("project-1"),
				project("project-2", { adminUserIds: [VIEWER] }),
			],
			[
				{
					projectId: "project-1",
					userId: VIEWER,
					tags: ["PRODUCT_OWNER"],
				},
			],
		);

		const condition = todoVisibilityCondition(visibility);
		const values = condition.values as unknown[];
		// [accessible, viewer, accessible, contactVisible, pairProjects, pairUsers]
		expect(values[3]).toEqual(["project-1", "project-2"]);
		expect(sqlText(condition)).toContain(
			't."assigneeContactId" IS NOT NULL',
		);
	});
});

// ---------------------------------------------------------------------------
// isTodoVisibleTo — the SAME rule, answered about an already-loaded row
// ---------------------------------------------------------------------------

const PO_PROJECT = "project-po";
const FALLBACK_PROJECT = "project-fallback";
const PLAIN_PROJECT = "project-plain";
const OUTSIDE_PROJECT = "project-outside";
const STAKEHOLDER_USER = "user-stakeholder";
const OTHER_USER = "user-other";
const CONTACT = "contact-1";

/**
 * One scope covering every arm at once: a project the viewer owns as Product
 * Owner (with a confirmed stakeholder on it), a project with no Product Owner
 * where the viewer is an admin, a project the viewer merely reaches, and — by
 * omission — a project they do not.
 */
function matrixVisibility() {
	return derive(
		[
			project(PO_PROJECT),
			project(FALLBACK_PROJECT, { adminUserIds: [VIEWER] }),
			project(PLAIN_PROJECT),
		],
		[
			{ projectId: PO_PROJECT, userId: VIEWER, tags: ["PRODUCT_OWNER"] },
			{
				projectId: PO_PROJECT,
				userId: STAKEHOLDER_USER,
				tags: ["STAKEHOLDER"],
			},
			{
				projectId: PLAIN_PROJECT,
				userId: STAKEHOLDER_USER,
				tags: ["STAKEHOLDER"],
			},
		],
	);
}

function row(overrides: Partial<Parameters<typeof isTodoVisibleTo>[0]> = {}) {
	return {
		source: "MEETING_DIGEST" as const,
		projectId: PLAIN_PROJECT,
		userId: "user-transcript-owner",
		assigneeUserId: null,
		assigneeContactId: null,
		...overrides,
	};
}

describe("isTodoVisibleTo", () => {
	const cases: Array<{
		name: string;
		row: ReturnType<typeof row>;
		visible: boolean;
	}> = [
		{
			name: "arm 1 — assigned to the viewer",
			row: row({ assigneeUserId: VIEWER }),
			visible: true,
		},
		{
			name: "arm 2 — unassigned on a reachable project",
			row: row(),
			visible: true,
		},
		{
			// A project-less row is always MANUAL, so arm 5 answers for it and
			// answers for its OWNER. Letting arm 2 answer instead would put one
			// person's not-yet-assigned private to-dos on every member's page.
			name: "arm 2 does not reach a row with no project — that is arm 5's",
			row: row({ projectId: null, source: "MEETING_DIGEST" }),
			visible: false,
		},
		{
			name: "arm 5 — the viewer's own MANUAL row, still unassigned",
			row: row({ projectId: null, source: "MANUAL", userId: VIEWER }),
			visible: true,
		},
		{
			name: "arm 5 does not reach another member's project-less MANUAL row",
			row: row({
				projectId: null,
				source: "MANUAL",
				userId: "user-someone-else",
			}),
			visible: false,
		},
		{
			name: "arm 3 — contact-assigned where the viewer is Product Owner",
			row: row({ projectId: PO_PROJECT, assigneeContactId: CONTACT }),
			visible: true,
		},
		{
			name: "arm 3 — contact-assigned on an admin-fallback project",
			row: row({
				projectId: FALLBACK_PROJECT,
				assigneeContactId: CONTACT,
			}),
			visible: true,
		},
		{
			// Nobody is the Product Owner of "no project". Such a row belongs to
			// whoever wrote it, which arm 5 says; handing it to every member
			// instead would publish their private commitments.
			name: "arm 3 does not reach a contact row with no project to own",
			row: row({
				projectId: null,
				assigneeContactId: CONTACT,
				source: "MANUAL",
				userId: "user-someone-else",
			}),
			visible: false,
		},
		{
			name: "arm 5 keeps the writer's own contact-assigned row reachable",
			row: row({
				projectId: null,
				assigneeContactId: CONTACT,
				source: "MANUAL",
				userId: VIEWER,
			}),
			visible: true,
		},
		{
			name: "arm 3 does not reach a project whose contact rows are someone else's",
			row: row({ projectId: PLAIN_PROJECT, assigneeContactId: CONTACT }),
			visible: false,
		},
		{
			name: "arm 4 — a stakeholder of a project the viewer owns",
			row: row({
				projectId: PO_PROJECT,
				assigneeUserId: STAKEHOLDER_USER,
			}),
			visible: true,
		},
		{
			name: "arm 4 pairs (project, user) — the same person elsewhere is not visible",
			row: row({
				projectId: PLAIN_PROJECT,
				assigneeUserId: STAKEHOLDER_USER,
			}),
			visible: false,
		},
		{
			name: "arm 5 — a MANUAL row the viewer wrote, handed to someone else",
			row: row({
				source: "MANUAL",
				projectId: null,
				userId: VIEWER,
				assigneeUserId: OTHER_USER,
			}),
			visible: true,
		},
		{
			name: "arm 5 is MANUAL-only — a meeting the viewer hosted is not their work",
			row: row({
				userId: VIEWER,
				assigneeUserId: OTHER_USER,
			}),
			visible: false,
		},
		{
			name: "no arm — assigned to another member of a reachable project",
			row: row({ assigneeUserId: OTHER_USER }),
			visible: false,
		},
		{
			name: "the gate beats every arm — assigned to the viewer, outside their projects",
			row: row({ projectId: OUTSIDE_PROJECT, assigneeUserId: VIEWER }),
			visible: false,
		},
		{
			name: "the gate beats arm 5 — a creator who lost the project loses the row",
			row: row({
				source: "MANUAL",
				projectId: OUTSIDE_PROJECT,
				userId: VIEWER,
				assigneeUserId: OTHER_USER,
			}),
			visible: false,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(isTodoVisibleTo(testCase.row, matrixVisibility())).toBe(
				testCase.visible,
			);
		});
	}

	it("admits nothing at all to a viewer whose scope is empty", () => {
		// The same guarantee the empty arrays give the SQL: an empty scope
		// matches nothing rather than everything. Only a project-less row can
		// still pass, and only through an arm that names the viewer.
		const empty = derive([]);

		expect(isTodoVisibleTo(row(), empty)).toBe(false);
		expect(
			isTodoVisibleTo(
				row({ projectId: null, assigneeUserId: OTHER_USER }),
				empty,
			),
		).toBe(false);
	});

	it("reads the assignee columns the way Postgres does, never as a null match", () => {
		// `NULL = anything` is NULL in SQL, never true. A predicate that
		// compared an absent assignee with an absent viewer id — or matched a
		// null-owned row to a null `userId` — would be wider than the statement
		// it is supposed to mirror.
		const visibility = matrixVisibility();

		expect(
			isTodoVisibleTo(
				row({
					source: "MANUAL",
					projectId: PLAIN_PROJECT,
					userId: null,
					assigneeUserId: OTHER_USER,
				}),
				visibility,
			),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// resolveTodoVisibility — the only seam that reads the database
// ---------------------------------------------------------------------------

describe("resolveTodoVisibility", () => {
	beforeEach(() => {
		mocks.dbMock.project.findMany.mockReset();
		mocks.dbMock.projectUserFunctionTag.findMany.mockReset();
	});

	it("asks only for CONFIRMED function tags on the accessible projects", async () => {
		mocks.dbMock.project.findMany.mockResolvedValue([
			{ id: "project-1", userId: "user-creator", members: [] },
		]);
		mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([]);

		await resolveTodoVisibility({
			viewerUserId: VIEWER,
			organizationId: ORG,
			now: NOW,
		});

		expect(
			mocks.dbMock.projectUserFunctionTag.findMany,
		).toHaveBeenCalledWith({
			where: {
				projectId: { in: ["project-1"] },
				// Unconfirmed rows exist because the global-defaults path writes
				// them. Fetching them would turn a guess into an entitlement.
				confirmedAt: { not: null },
			},
			select: { projectId: true, userId: true, tags: true },
		});
	});

	it("does not ask about tags at all when the viewer reaches no project", async () => {
		mocks.dbMock.project.findMany.mockResolvedValue([]);

		const visibility = await resolveTodoVisibility({
			viewerUserId: VIEWER,
			organizationId: ORG,
			now: NOW,
		});

		expect(
			mocks.dbMock.projectUserFunctionTag.findMany,
		).not.toHaveBeenCalled();
		expect(visibility.accessibleProjectIds).toEqual([]);
	});

	it("reads project admins from accepted, unexpired OWNER and PROJECT_ADMIN rows", async () => {
		mocks.dbMock.project.findMany.mockResolvedValue([
			{
				id: "project-1",
				userId: "user-creator",
				members: [{ userId: "user-admin" }],
			},
		]);
		mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([]);

		const visibility = await resolveTodoVisibility({
			viewerUserId: "user-admin",
			organizationId: ORG,
			now: NOW,
		});

		const call = mocks.dbMock.project.findMany.mock.calls[0]?.[0];
		expect(call.select.members.where).toEqual({
			role: { in: ["OWNER", "PROJECT_ADMIN"] },
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
		});
		// No confirmed Product Owner on project-1, so its contact rows fall to
		// the admin rather than to nobody.
		expect(visibility.contactFallbackProjectIds).toEqual(["project-1"]);
	});
});
