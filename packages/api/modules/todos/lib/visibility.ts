/**
 * Who may see which to-do, and for how long (#2340).
 *
 * This is the ONE place the To Do list's access rules are written, and every
 * to-do read composes what it exports. The reason it is one place rather than
 * a predicate copied into each procedure is the shape of the query itself: the
 * To Do page is a single organization-level read that crosses every project
 * the viewer can reach, so unlike almost every other surface in Fabric there
 * is no `projectId` in the input for `requireProjectPermission` to authorize
 * against. The organization check the procedure declares
 * (`requireInputOrgPermission(TODO_READ, { requireOrganization: true })`) proves
 * the caller belongs to the tenant and nothing more; it says nothing about
 * which of that tenant's projects they may read. The predicate below is what
 * says that, and a second to-do read that built its own would be a
 * cross-project leak the first read's tests would still pass.
 *
 * THE PROJECT-ACCESS PATHS mirror `modules/notifications/lib/access-filter.ts`,
 * with one deliberate difference. That filter's first path is the
 * personal-project owner (`{ userId, organizationId: null }`); this one has no
 * such path, because an organization is the only tenant context here
 * (ADR-018) and the To Do page is org-only. Dropping it is not a
 * simplification — a bare `{ userId }` creator arm under an org-pinned query
 * would keep a project reachable for someone who CREATED it and has since been
 * removed from the organization, which is precisely the membership change the
 * notifications filter exists to honour. Access is therefore an accepted,
 * unexpired project membership or membership of the host organization, and
 * nothing else.
 *
 * THE SAME PREDICATE IN EVERY VIEW. `todos.list` answers for four scopes —
 * the working list, the completed archive, what is still snoozed, and what the
 * age cutoff removed — and all four compose the ONE condition this file
 * exports. Snooze, completion and age decide which of the rows a viewer may
 * already see are kept; they never decide who may see a row. A scope that
 * built its own predicate "because those rows are hidden anyway" would be a
 * cross-project leak in a view nobody thought of as a read.
 *
 * SOFT-DELETED PROJECTS are excluded at read time by `deletedAt: null`. A soft
 * delete fires no cascade, so the to-dos of a deleted project are still in the
 * table with their organization intact; this predicate is the only thing
 * keeping them off the page.
 *
 * FUNCTION TAGS ARE PER PROJECT, and only a CONFIRMED one grants anything.
 * `ProjectUserFunctionTag` rows are written unconfirmed by the global-defaults
 * path, so an unconfirmed row means "this is what we guessed you do here", not
 * "this is what you do here". Granting Product Owner visibility on a guess
 * would show one person's stakeholder commitments to whoever happened to
 * inherit a default.
 */

import { db, Prisma } from "@repo/database";

/**
 * How old a to-do may get, in days, before the list stops showing it.
 *
 * A constant and not a stored setting. A per-organization threshold makes "why
 * can I not see it any more" a question with a different answer per tenant,
 * and support cannot answer it without looking the tenant up. Thirty days is
 * the number the page explains to the user; when it moves, it moves here and
 * the explanation moves with it.
 */
export const TODO_AGE_THRESHOLD_DAYS = 30;

/**
 * How many of the most recent rows stay visible however old they are.
 *
 * Without a floor, an organization that has been quiet for six weeks opens the
 * To Do page onto nothing at all and has no way to tell an empty list from a
 * broken one. The floor guarantees the page always has something to render and
 * something to explain the hidden count against.
 */
export const TODO_RECENCY_FLOOR = 10;

/**
 * How many completed rows the default view keeps.
 *
 * Enough to confirm "I just ticked that off" without turning a live list into
 * an archive. The rest of the history is not hidden, it is a different
 * question: `view: "completed"` answers it in full, uncapped and with no age
 * cutoff, so nothing a user finished is unreachable.
 */
export const TODO_RECENT_COMPLETED_LIMIT = 2;

/** The project-shaped facts the rules below are decided from. */
export interface VisibilityProjectRow {
	id: string;
	/** `Project.userId` — the creator. */
	createdById: string;
	/** Accepted, unexpired members holding OWNER or PROJECT_ADMIN. */
	adminUserIds: string[];
}

/** One confirmed `ProjectUserFunctionTag` row. Unconfirmed rows never reach here. */
export interface VisibilityFunctionTagRow {
	projectId: string;
	userId: string;
	tags: string[];
}

/**
 * One project on which the viewer holds a confirmed PRODUCT_OWNER tag.
 *
 * Deliberately not exported: it is reached through `TodoVisibility`, which is,
 * and a second exported name for the same shape is one more thing to keep in
 * step for no gain.
 */
interface ProductOwnerProject {
	projectId: string;
	/** Members of that project holding a confirmed STAKEHOLDER tag. */
	stakeholderUserIds: string[];
}

/**
 * Everything the SQL predicate needs, resolved once per request.
 *
 * Deliberately a plain, serialisable description rather than a query: it is
 * what makes the rules testable without a database, and what lets the
 * Unassigned bucket's default state travel to the client in the same response
 * instead of costing a second call.
 */
export interface TodoVisibility {
	viewerUserId: string;
	organizationId: string;
	/** Every project of this organization the viewer can currently reach. */
	accessibleProjectIds: string[];
	productOwnerProjects: ProductOwnerProject[];
	/**
	 * Projects with NO confirmed Product Owner, where the viewer is an admin or
	 * the creator. Their contact-assigned to-dos surface here because otherwise
	 * a contact's obligations would be visible to nobody at all.
	 */
	contactFallbackProjectIds: string[];
	/**
	 * Projects whose Unassigned bucket the page expands by default for this
	 * viewer. Openable is not the same as expanded: anyone with access to the
	 * project can open the bucket, and this list only decides what is already
	 * open when the page loads.
	 */
	unassignedExpandedProjectIds: string[];
}

const PRODUCT_OWNER = "PRODUCT_OWNER";
const PRODUCT_CONTRIBUTOR = "PRODUCT_CONTRIBUTOR";
const STAKEHOLDER = "STAKEHOLDER";

/** Project roles that count as administering the project. */
const PROJECT_ADMIN_ROLES = ["OWNER", "PROJECT_ADMIN"] as const;

/**
 * The project-access predicate, as a Prisma filter.
 *
 * Exported so that anything else needing "which projects can this person reach
 * in this organization" asks the same question, and so the soft-delete
 * exclusion cannot be forgotten by a caller that only remembered membership.
 */
export function accessibleProjectWhere(
	viewerUserId: string,
	organizationId: string,
	now: Date,
): Prisma.ProjectWhereInput {
	return {
		organizationId,
		// A soft delete fires no cascade — this is what keeps a deleted
		// project's to-dos off the page.
		deletedAt: null,
		OR: [
			// An accepted, unexpired project membership. This is the guest
			// path: a guest reaches exactly the projects they were invited to
			// and no others.
			{
				members: {
					some: {
						userId: viewerUserId,
						acceptedAt: { not: null },
						OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
					},
				},
			},
			// Membership of the host organization.
			{ organization: { members: { some: { userId: viewerUserId } } } },
		],
	};
}

/**
 * Turns the fetched facts into the visibility scope. Pure — no I/O — because
 * every rule worth arguing about is decided here, and a rule that needs a
 * database to test is a rule nobody tests.
 */
export function deriveTodoVisibility(input: {
	viewerUserId: string;
	organizationId: string;
	projects: VisibilityProjectRow[];
	confirmedTags: VisibilityFunctionTagRow[];
}): TodoVisibility {
	const { viewerUserId, organizationId, projects, confirmedTags } = input;

	const tagsByProject = new Map<string, VisibilityFunctionTagRow[]>();
	for (const row of confirmedTags) {
		const list = tagsByProject.get(row.projectId);
		if (list) {
			list.push(row);
		} else {
			tagsByProject.set(row.projectId, [row]);
		}
	}

	const productOwnerProjects: ProductOwnerProject[] = [];
	const contactFallbackProjectIds: string[] = [];
	const unassignedExpandedProjectIds: string[] = [];

	for (const project of projects) {
		const projectTags = tagsByProject.get(project.id) ?? [];
		const viewerTags =
			projectTags.find((row) => row.userId === viewerUserId)?.tags ?? [];
		const viewerIsProductOwner = viewerTags.includes(PRODUCT_OWNER);
		const projectHasProductOwner = projectTags.some((row) =>
			row.tags.includes(PRODUCT_OWNER),
		);
		const viewerAdministersProject =
			project.createdById === viewerUserId ||
			project.adminUserIds.includes(viewerUserId);

		if (viewerIsProductOwner) {
			productOwnerProjects.push({
				projectId: project.id,
				stakeholderUserIds: projectTags
					.filter((row) => row.tags.includes(STAKEHOLDER))
					.map((row) => row.userId),
			});
		}

		// Only where nobody confirmed a Product Owner. Where one exists, the
		// contact rows are theirs and an admin has no separate claim on them.
		if (!projectHasProductOwner && viewerAdministersProject) {
			contactFallbackProjectIds.push(project.id);
		}

		// Expanded by default for the two product functions, and — only when
		// the viewer has no confirmed tag on this project at all — for admins
		// and creators. A viewer whose confirmed tag is neither of the two has
		// answered the question, and the fallback must not overrule them.
		const expanded =
			viewerIsProductOwner ||
			viewerTags.includes(PRODUCT_CONTRIBUTOR) ||
			(viewerTags.length === 0 && viewerAdministersProject);
		if (expanded) {
			unassignedExpandedProjectIds.push(project.id);
		}
	}

	return {
		viewerUserId,
		organizationId,
		accessibleProjectIds: projects.map((project) => project.id),
		productOwnerProjects,
		contactFallbackProjectIds,
		unassignedExpandedProjectIds,
	};
}

/**
 * Loads the facts and derives the scope. Two queries, both bounded by the
 * viewer's accessible projects; a viewer with no projects costs one.
 */
export async function resolveTodoVisibility(params: {
	viewerUserId: string;
	organizationId: string;
	now: Date;
}): Promise<TodoVisibility> {
	const { viewerUserId, organizationId, now } = params;

	const projectRows = await db.project.findMany({
		where: accessibleProjectWhere(viewerUserId, organizationId, now),
		select: {
			id: true,
			userId: true,
			members: {
				where: {
					role: { in: [...PROJECT_ADMIN_ROLES] },
					acceptedAt: { not: null },
					OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
				},
				select: { userId: true },
			},
		},
	});

	const projects: VisibilityProjectRow[] = projectRows.map((project) => ({
		id: project.id,
		createdById: project.userId,
		adminUserIds: project.members.map((member) => member.userId),
	}));

	// `confirmedAt: { not: null }` is the whole confirmation lifecycle as far as
	// this file is concerned — see the header. A row that exists but is
	// unconfirmed grants nothing.
	const confirmedTags = projects.length
		? await db.projectUserFunctionTag.findMany({
				where: {
					projectId: { in: projects.map((project) => project.id) },
					confirmedAt: { not: null },
				},
				select: { projectId: true, userId: true, tags: true },
			})
		: [];

	return deriveTodoVisibility({
		viewerUserId,
		organizationId,
		projects,
		confirmedTags,
	});
}

/**
 * The scope rendered as a parameterised SQL predicate over `todo_item t`.
 *
 * Five arms, each one rule:
 *
 *  1. **Rows assigned to the viewer**, always. Whatever tags anyone holds.
 *  2. **A PROJECT's Unassigned bucket**, openable by any viewer with access to
 *     that project. It does NOT reach a row with no project: such a row is
 *     always MANUAL (a meeting row takes its project from the transcript,
 *     whose `projectId` is NOT NULL) and arm 5 answers for it, for the one
 *     person it belongs to. This arm once admitted project-less rows on the
 *     grounds that nothing else would -- true before arm 5 existed, and the
 *     cost was that every member's private, not-yet-assigned to-dos sat on
 *     every other member's page, which is most of a to-do's life.
 *  3. **Contact-assigned rows**, on projects where the viewer is a confirmed
 *     Product Owner, plus the projects that fell back to their admins because
 *     no Product Owner was confirmed there. Nobody is the Product Owner of
 *     "no project", so a project-less contact row is arm 5's too.
 *  4. **Stakeholder-assigned rows**, matched as (project, user) PAIRS. The
 *     pairing is the point: a Product Owner of project A must not see project
 *     B's stakeholder rows merely because the same person is tagged
 *     STAKEHOLDER on both. `unnest` of two parallel arrays keeps that exact,
 *     and keeps the predicate one parameterised statement rather than an
 *     OR-chain that grows with the tenant.
 *  5. **MANUAL rows the viewer CREATED**, whatever their assignment. Arm 1 asks
 *     who a row is assigned TO, which leaves the person who wrote a to-do and
 *     then handed it to a colleague matching no arm at all: they could neither
 *     see it nor take it back. `TodoItem.userId` is the owner column
 *     (`user_owned` RLS keys on it) and this arm is the only thing that reads
 *     it here.
 *
 *     THE `MANUAL` RESTRICTION IS THE WHOLE OF THIS ARM'S SAFETY and is not
 *     defensive typing. On a meeting-sourced row `userId` is copied from
 *     `transcript.userId` — the person whose MEETING it was, not the person who
 *     owes the work — so an unscoped owner arm would show every action item of
 *     every meeting you hosted, regardless of who it was assigned to. That is a
 *     widening nobody asked for, and it would be invisible until a tenant with
 *     one heavy meeting host noticed their list had everyone else's work in it.
 *
 * The whole thing is wrapped in the project-access gate, so no arm can reach
 * outside the viewer's projects and no arm can resurrect a soft-deleted
 * project's rows. Arm 5 sits inside that gate like every other arm: a creator
 * who has since lost the project loses its rows with it.
 *
 * Empty arrays are safe by construction: `= ANY('{}')` is false and `unnest`
 * of empty arrays yields no rows, so a viewer with no projects matches nothing
 * rather than everything.
 *
 * THIS PREDICATE AND `isTodoVisibleTo` ARE ONE RULE IN TWO RENDERINGS — this
 * one for rows still in the table, that one for a row already loaded. Every
 * to-do WRITE evaluates the in-memory form, because a row the caller cannot see
 * must not be a row they can change. The writes used to ask a different
 * question (owner-of-the-row OR the row's project is reachable), and because
 * every project of an organization is reachable by every member of it, a to-do
 * assigned to a colleague was absent from the caller's list and still
 * completable, snoozable and reassignable by id. An arm added here must be
 * added there in the same edit, and `__tests__/visibility.test.ts` walks a
 * matrix of rows through both.
 */
export function todoVisibilityCondition(
	visibility: TodoVisibility,
): Prisma.Sql {
	const accessible = visibility.accessibleProjectIds;
	const contactVisibleProjectIds = [
		...visibility.productOwnerProjects.map((project) => project.projectId),
		...visibility.contactFallbackProjectIds,
	];

	const stakeholderProjectIds: string[] = [];
	const stakeholderUserIds: string[] = [];
	for (const project of visibility.productOwnerProjects) {
		for (const userId of project.stakeholderUserIds) {
			stakeholderProjectIds.push(project.projectId);
			stakeholderUserIds.push(userId);
		}
	}

	return Prisma.sql`(
		(t."projectId" IS NULL OR t."projectId" = ANY(${accessible}::text[]))
		AND (
			t."assigneeUserId" = ${visibility.viewerUserId}
			OR (
				/* A PROJECT's unassigned work, and only that. The arm used to
				   admit a project-less row too, on the reasoning that it would
				   otherwise be visible to nobody. Arm 5 is now what catches
				   those, and it catches them for the ONE person they belong
				   to -- so keeping the branch here no longer rescues anything
				   and instead shows every member the private, not-yet-assigned
				   to-dos of every other member. A project-less row is always
				   MANUAL (a meeting row takes its project from the transcript,
				   whose projectId is NOT NULL), so arm 5 covers the whole of
				   what this branch used to cover. */
				t."assigneeUserId" IS NULL
				AND t."assigneeContactId" IS NULL
				AND t."projectId" = ANY(${accessible}::text[])
			)
			OR (
				/* Contact rows of a PROJECT the viewer answers for. A
				   project-less row assigned to a contact is not one of these:
				   it has no project to be the Product Owner of, and it belongs
				   to whoever wrote it -- which is arm 5. Handing it to every
				   member instead would publish one person's private
				   commitments to the whole organization. Block comment, not a
				   line comment: this fragment is composed into a larger
				   statement, where a line comment swallows the rest of the
				   line it lands on. */
				t."assigneeContactId" IS NOT NULL
				AND t."projectId" = ANY(${contactVisibleProjectIds}::text[])
			)
			OR EXISTS (
				SELECT 1
				FROM unnest(
					${stakeholderProjectIds}::text[],
					${stakeholderUserIds}::text[]
				) AS pair("projectId", "userId")
				WHERE pair."projectId" = t."projectId"
					AND pair."userId" = t."assigneeUserId"
			)
			OR (
				/* Arm 5 — the creator of a MANUAL row. The literal is compared
				   against the enum column directly, which Postgres resolves to
				   the column's own type; it is not a parameter because a text
				   parameter would need a cast of its own to be compared at all.
				   Block comment, not a line comment: this fragment is composed
				   into a larger statement. */
				t."source" = 'MANUAL'
				AND t."userId" = ${visibility.viewerUserId}
			)
		)
	)`;
}

/**
 * The row-shaped facts the rule is decided from — the same columns the SQL
 * predicate names, and nothing else.
 *
 * Structural rather than an import of `TodoMutationRow`, so the predicate can
 * be asked about a literal in a test without a database row's other twenty
 * fields, and so this file keeps no dependency on the write path.
 */
export interface TodoVisibilityRow {
	source: "MEETING_DIGEST" | "MANUAL";
	projectId: string | null;
	/** `TodoItem.userId` — the creator of a manual row (see arm 5). */
	userId: string | null;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
}

/**
 * `todoVisibilityCondition`, answered in memory about one already-loaded row.
 *
 * THE SAME RULE IN THE OTHER RENDERING. The arms below are the arms above, in
 * the same order and with the same meanings; the header of
 * `todoVisibilityCondition` is the reasoning for all of them and is not
 * repeated here, precisely so there is one place to change it. What this form
 * exists for is the WRITES: a to-do mutation is keyed by id and has already
 * loaded the row, so asking "may this caller see it" must not cost another
 * query per row — the batch path resolves the scope ONCE and asks this per row
 * with no further I/O.
 *
 * Pure, and deliberately free of shortcuts SQL would not take: `NULL =
 * anything` is never true in Postgres, so each arm compares only after
 * establishing the column is present. A row that matched here and not there
 * (or the reverse) would be the two-spellings bug this replaced.
 */
export function isTodoVisibleTo(
	row: TodoVisibilityRow,
	visibility: TodoVisibility,
): boolean {
	// The gate the SQL wraps every arm in. A row with no project is an
	// organization-level item and passes it; the load that produced the row is
	// what pinned the organization.
	if (
		row.projectId !== null &&
		!visibility.accessibleProjectIds.includes(row.projectId)
	) {
		return false;
	}

	// 1. Assigned to the viewer.
	if (
		row.assigneeUserId !== null &&
		row.assigneeUserId === visibility.viewerUserId
	) {
		return true;
	}

	// 2. A PROJECT's Unassigned bucket. A project-less row is not in it: it is
	// always MANUAL, and arm 5 gives it to the one person it belongs to.
	if (
		row.projectId !== null &&
		row.assigneeUserId === null &&
		row.assigneeContactId === null
	) {
		return true;
	}

	// 3. Contact-assigned, where the contact rows are this viewer's to see.
	if (row.assigneeContactId !== null && row.projectId !== null) {
		const contactVisible =
			visibility.productOwnerProjects.some(
				(project) => project.projectId === row.projectId,
			) || visibility.contactFallbackProjectIds.includes(row.projectId);
		if (contactVisible) {
			return true;
		}
	}

	// 4. A (project, user) stakeholder PAIR — never a project id and a user id
	// that merely both appear somewhere in the scope.
	if (row.projectId !== null && row.assigneeUserId !== null) {
		const owned = visibility.productOwnerProjects.find(
			(project) => project.projectId === row.projectId,
		);
		if (owned?.stakeholderUserIds.includes(row.assigneeUserId)) {
			return true;
		}
	}

	// 5. A MANUAL row the viewer created, whatever its assignment.
	if (
		row.source === "MANUAL" &&
		row.userId !== null &&
		row.userId === visibility.viewerUserId
	) {
		return true;
	}

	return false;
}
