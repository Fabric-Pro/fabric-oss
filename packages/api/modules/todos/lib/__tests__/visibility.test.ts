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
 *  2. **The two Prisma filters.** Asserted structurally, because the whole of
 *     #2615 is the difference between them: `organizationProjectWhere` says
 *     which projects may put rows on the page, `openableProjectWhere` says
 *     which the viewer can actually OPEN. The strict one's access arms are
 *     pinned against a literal copy of `buildProjectAccessWhere`'s shape, so
 *     the two cannot drift into disagreeing about the same question.
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
	openableProjectWhere,
	organizationProjectWhere,
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
	overrides: {
		createdById?: string;
		adminUserIds?: string[];
		/**
		 * Defaults TRUE because every scenario written before #2615 is about a
		 * project the viewer can open — the Product Owner rules, the contact
		 * fallback, the bucket expansion. Passing `false` is how a test says
		 * "this is the project the reporter could see rows from and could not
		 * open".
		 */
		isOpenable?: boolean;
	} = {},
) {
	return {
		id,
		createdById: overrides.createdById ?? "user-someone-else",
		adminUserIds: overrides.adminUserIds ?? [],
		isOpenable: overrides.isOpenable ?? true,
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
// organizationProjectWhere / openableProjectWhere
// ---------------------------------------------------------------------------

/**
 * `buildProjectAccessWhere`'s access arms, written out by hand.
 *
 * A literal and not an import, deliberately: that function is not exported, and
 * importing it would make this test pass by construction. Written out, the test
 * fails the day somebody edits either rule — which is exactly the day someone
 * needs to be told, because the two answering differently is #2615.
 */
const PROJECT_PAGE_ACCESS_ARMS = [
	{ userId: VIEWER },
	{
		members: {
			some: {
				userId: VIEWER,
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
			},
		},
	},
];

describe("organizationProjectWhere", () => {
	it("excludes soft-deleted projects and pins the organization", () => {
		const where = organizationProjectWhere(VIEWER, ORG, NOW);

		// A soft delete fires no cascade, so this clause is the only thing
		// keeping a deleted project's to-dos off the page.
		expect(where.deletedAt).toBeNull();
		expect(where.organizationId).toBe(ORG);
	});

	it("offers project membership and organization membership, and nothing else", () => {
		const where = organizationProjectWhere(VIEWER, ORG, NOW);
		const paths = (where.OR ?? []) as Array<Record<string, unknown>>;

		expect(paths).toHaveLength(2);
		// No creator arm here, and none is wanted: this is the tenant-scoping
		// question, an organization member already reaches every project of the
		// organization through the second arm, and a creator who has left the
		// organization is not a member of it. The ACCESS question is
		// `openableProjectWhere` below, and that one does carry the arm.
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

describe("openableProjectWhere", () => {
	it("pins the organization and excludes soft-deleted projects", () => {
		const where = openableProjectWhere(VIEWER, ORG, NOW);

		expect(where.organizationId).toBe(ORG);
		// The one clause `buildProjectAccessWhere` does not have. It resolves a
		// soft-deleted project so its owner can reach the restore screen; this
		// page has no such screen, so a link to one would go nowhere useful.
		expect(where.deletedAt).toBeNull();
	});

	it("is the project page's own rule, arm for arm", () => {
		const where = openableProjectWhere(VIEWER, ORG, NOW);

		// THE CONTRACT OF THIS FILE. If this assertion is ever relaxed rather
		// than fixed, the To Do list goes back to offering links whose
		// destination refuses to load.
		expect(where.OR).toEqual(PROJECT_PAGE_ACCESS_ARMS);
	});

	it("does not grant reach from organization membership alone", () => {
		const where = openableProjectWhere(VIEWER, ORG, NOW);
		const paths = (where.OR ?? []) as Array<Record<string, unknown>>;

		// The arm that was #2615. `listProjects` and `getProjectById` both say
		// it in words -- "Organization membership alone does NOT grant access
		// to projects" -- and this is that sentence as a test.
		expect(paths).not.toContainEqual({
			organization: { members: { some: { userId: VIEWER } } },
		});
	});

	it("keeps the creator arm, because a project's creator gets no membership row", () => {
		const paths = (openableProjectWhere(VIEWER, ORG, NOW).OR ??
			[]) as Array<Record<string, unknown>>;

		// `createProject` writes no `ProjectMember` row for the creator, so
		// without this arm a project's own creator would lose their own
		// project's rows. Safe here because `todos.list` has already proved
		// tenant membership before the predicate runs.
		expect(paths).toContainEqual({ userId: VIEWER });
	});

	it("honours an expiry and an unaccepted invitation exactly as the wide rule does", () => {
		const paths = (openableProjectWhere(VIEWER, ORG, NOW).OR ??
			[]) as Array<Record<string, unknown>>;

		// A pending invitation is not access, and an expired one is not access
		// any more. Both halves live in the membership arm; dropping either is
		// a silent widening.
		expect(paths[1]).toEqual({
			members: {
				some: {
					userId: VIEWER,
					acceptedAt: { not: null },
					OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
				},
			},
		});
	});
});

// ---------------------------------------------------------------------------
// deriveTodoVisibility
// ---------------------------------------------------------------------------

describe("deriveTodoVisibility", () => {
	it("gives a viewer with no projects an empty scope rather than a wide one", () => {
		const visibility = derive([]);

		expect(visibility.organizationProjectIds).toEqual([]);
		expect(visibility.productOwnerProjects).toEqual([]);
		expect(visibility.contactFallbackProjectIds).toEqual([]);
		expect(visibility.unassignedExpandedProjectIds).toEqual([]);
	});

	it("limits a guest to the one project they were invited to", () => {
		// The guest reaches project-1 through an accepted membership; project-2
		// never enters the fetched set, so nothing downstream can reach it.
		const visibility = derive([project("project-1")]);

		expect(visibility.organizationProjectIds).toEqual(["project-1"]);
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

		it("never expands, or even names, a project the viewer cannot open", () => {
			// `unassignedExpandedProjectIds` travels to the client, so a
			// project the viewer cannot open appearing here would both expand
			// a bucket that now has no rows and hand over an id they have no
			// business holding. It falls out of the derivation skipping
			// unopenable projects entirely — pinned because that is incidental
			// to how the skip is written, and the next edit could lose it.
			const visibility = derive(
				[
					project("project-shut", {
						isOpenable: false,
						adminUserIds: [VIEWER],
					}),
				],
				[
					{
						projectId: "project-shut",
						userId: VIEWER,
						tags: ["PRODUCT_OWNER"],
					},
				],
			);

			expect(visibility.unassignedExpandedProjectIds).toEqual([]);
			expect(visibility.openableProjectIds).toEqual([]);
			expect(visibility.organizationProjectIds).toEqual(["project-shut"]);
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
	it("binds the WIDE set to the gate and the STRICT set to the Unassigned arm", () => {
		// The positional halves of #2615. Value 0 is the outer gate and value 2
		// is arm 2's project array; before the fix both were the same array,
		// which is why a bucket the viewer could not open still rendered.
		const visibility = derive([
			project("project-open"),
			project("project-shut", { isOpenable: false }),
		]);
		const values = todoVisibilityCondition(visibility).values as unknown[];

		expect(values[0]).toEqual(["project-open", "project-shut"]);
		expect(values[2]).toEqual(["project-open"]);
	});

	it("gives arms 3 and 4 nothing to stand on for a project the viewer cannot open", () => {
		// Their arrays are built from `productOwnerProjects` and
		// `contactFallbackProjectIds`, not from an `openable` parameter of their
		// own — so this is the assertion that catches a narrowing applied only
		// at the arm.
		const visibility = derive(
			[
				project("project-shut", {
					isOpenable: true,
					adminUserIds: [VIEWER],
				}),
			],
			[],
		);
		const openValues = todoVisibilityCondition(visibility)
			.values as unknown[];
		// Openable and admin-with-no-Product-Owner: the contact fallback fires.
		expect(openValues[3]).toEqual(["project-shut"]);

		const shut = derive(
			[
				project("project-shut", {
					isOpenable: false,
					adminUserIds: [VIEWER],
				}),
			],
			[
				{
					projectId: "project-shut",
					userId: VIEWER,
					tags: ["PRODUCT_OWNER"],
				},
				{
					projectId: "project-shut",
					userId: "user-stake",
					tags: ["STAKEHOLDER"],
				},
			],
		);
		const shutValues = todoVisibilityCondition(shut).values as unknown[];

		expect(shutValues[3]).toEqual([]);
		expect(shutValues[4]).toEqual([]);
		expect(shutValues[5]).toEqual([]);
	});

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
/**
 * In the tenant, and NOT openable — the shape that produced #2615.
 *
 * The reporter was a member of the organization but not of this project, so
 * every rule keyed on organization membership admitted its rows and the project
 * page then answered "Project not found" for every link on them.
 */
const UNOPENABLE_PROJECT = "project-unopenable";
const STAKEHOLDER_USER = "user-stakeholder";
const OTHER_USER = "user-other";
const CONTACT = "contact-1";

/**
 * One scope covering every arm at once: a project the viewer owns as Product
 * Owner (with a confirmed stakeholder on it), a project with no Product Owner
 * where the viewer is an admin, a project the viewer merely reaches, a project
 * in the tenant that they cannot OPEN, and — by omission — a project they do
 * not reach at all.
 *
 * The unopenable project is deliberately loaded with every entitlement that
 * would otherwise fire: the viewer is a confirmed Product Owner on it, there is
 * a confirmed stakeholder on it, and the viewer administers it. If any of arms
 * 2, 3 or 4 still reached it, one of those would be the door.
 */
function matrixVisibility() {
	return derive(
		[
			project(PO_PROJECT),
			project(FALLBACK_PROJECT, { adminUserIds: [VIEWER] }),
			project(PLAIN_PROJECT),
			project(UNOPENABLE_PROJECT, {
				isOpenable: false,
				adminUserIds: [VIEWER],
			}),
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
			{
				projectId: UNOPENABLE_PROJECT,
				userId: VIEWER,
				tags: ["PRODUCT_OWNER"],
			},
			{
				projectId: UNOPENABLE_PROJECT,
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

		// ---- #2615: in the tenant, not openable -------------------------
		//
		// The viewer's OWN commitments survive here, and only those. The owner
		// matcher picks from every member of the organization, so being handed
		// work on a project you were never added to is a reachable state, and
		// hiding that work would be the page failing at its one job. What the
		// row must not do is offer a link, which `canOpenProject` settles.
		{
			name: "arm 1 still reaches the viewer's own row on a project they cannot open",
			row: row({
				projectId: UNOPENABLE_PROJECT,
				assigneeUserId: VIEWER,
			}),
			visible: true,
		},
		{
			name: "arm 5 still reaches a MANUAL row the viewer wrote against a project they cannot open",
			row: row({
				source: "MANUAL",
				projectId: UNOPENABLE_PROJECT,
				userId: VIEWER,
				assigneeUserId: OTHER_USER,
			}),
			visible: true,
		},
		{
			name: "arm 2 does not open the Unassigned bucket of a project the viewer cannot open",
			row: row({ projectId: UNOPENABLE_PROJECT }),
			visible: false,
		},
		{
			// The viewer IS a confirmed Product Owner here. The narrowing has to
			// happen where `productOwnerProjects` is built, or this passes.
			name: "arm 3 does not reach contact rows of a project the viewer cannot open, Product Owner or not",
			row: row({
				projectId: UNOPENABLE_PROJECT,
				assigneeContactId: CONTACT,
			}),
			visible: false,
		},
		{
			// Same door, other arm: the stakeholder pair is built from
			// `productOwnerProjects` too.
			name: "arm 4 does not reach a stakeholder pair on a project the viewer cannot open",
			row: row({
				projectId: UNOPENABLE_PROJECT,
				assigneeUserId: STAKEHOLDER_USER,
			}),
			visible: false,
		},
		{
			name: "no arm — a colleague's row on a project the viewer cannot open",
			row: row({
				projectId: UNOPENABLE_PROJECT,
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

	it("asks about tags for the OPENABLE projects only", async () => {
		// Every list a tag can feed is built inside a loop that skips a
		// non-openable project first, so tags fetched for the rest are read by
		// nothing. Pinned because the waste is invisible — it costs rows, not
		// correctness, so no other assertion would ever notice it coming back.
		mocks.dbMock.project.findMany
			.mockResolvedValueOnce([
				{ id: "project-open", userId: "user-creator", members: [] },
				{ id: "project-shut", userId: "user-creator", members: [] },
			])
			.mockResolvedValueOnce([{ id: "project-open" }]);
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
				projectId: { in: ["project-open"] },
				confirmedAt: { not: null },
			},
			select: { projectId: true, userId: true, tags: true },
		});
	});

	it("does not ask about tags when the viewer can open nothing, however much they can see", async () => {
		// The wide set is non-empty and the strict one is not. There is nothing
		// a tag could grant, so the query is skipped entirely rather than asked
		// with an empty list.
		mocks.dbMock.project.findMany
			.mockResolvedValueOnce([
				{ id: "project-shut", userId: "user-creator", members: [] },
			])
			.mockResolvedValueOnce([]);

		const visibility = await resolveTodoVisibility({
			viewerUserId: VIEWER,
			organizationId: ORG,
			now: NOW,
		});

		expect(
			mocks.dbMock.projectUserFunctionTag.findMany,
		).not.toHaveBeenCalled();
		// The row is still in the tenant set — it may still reach the viewer
		// through arm 1 or arm 5.
		expect(visibility.organizationProjectIds).toEqual(["project-shut"]);
		expect(visibility.openableProjectIds).toEqual([]);
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
		expect(visibility.organizationProjectIds).toEqual([]);
	});

	it("asks BOTH predicates, and marks only the projects the strict one returned", async () => {
		// The wiring #2615 turns on. The wide query decides which projects may
		// put rows on the page; the strict one decides which of them the viewer
		// can open. Reconstructing the second from the first is not possible —
		// the wide select's `members` relation is filtered to OWNER and
		// PROJECT_ADMIN, so an Editor's membership is simply absent from it.
		mocks.dbMock.project.findMany
			.mockResolvedValueOnce([
				{ id: "project-open", userId: "user-creator", members: [] },
				{ id: "project-shut", userId: "user-creator", members: [] },
			])
			.mockResolvedValueOnce([{ id: "project-open" }]);
		mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([]);

		const visibility = await resolveTodoVisibility({
			viewerUserId: VIEWER,
			organizationId: ORG,
			now: NOW,
		});

		expect(visibility.organizationProjectIds).toEqual([
			"project-open",
			"project-shut",
		]);
		expect(visibility.openableProjectIds).toEqual(["project-open"]);

		// Matched on the predicates themselves rather than on call order: the
		// two run concurrently, and an index would keep passing if they were
		// ever swapped.
		const wheres = mocks.dbMock.project.findMany.mock.calls.map(
			(call: [{ where: unknown }]) => call[0].where,
		);
		expect(wheres).toContainEqual(
			organizationProjectWhere(VIEWER, ORG, NOW),
		);
		expect(wheres).toContainEqual(openableProjectWhere(VIEWER, ORG, NOW));
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
