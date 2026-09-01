/**
 * Question assignment is scoped to the TENANT that owns the question, never to
 * the person assigned (Fizzy #1751).
 *
 * ## The bug this exists to prevent
 *
 * `decision_log_entry_assignee` carries three user columns and only one of them
 * is a tenant key:
 *
 *   - `userId`           — the TENANT key, copied from the parent question.
 *   - `assigneeUserId`   — the person being asked.
 *   - `assignedByUserId` — who asked them.
 *
 * The `user_owned` RLS policy matches `"userId" = current_user_id()` on its
 * personal branch, so naming the assignee `userId` — or filtering reads by the
 * assignee — scopes the row to the person being asked. The author who assigned
 * somebody *else* would then stop seeing their own assignment, breaking AC-4
 * ("assignment persists") and AC-21 ("assignees are displayed").
 *
 * The trap only shows up when the assigner and the assignee are DIFFERENT
 * people. A test that assigns a user to their own question passes either way and
 * proves nothing, which is why every case below uses two distinct users.
 *
 * Asserted in ORGANIZATION context: per ADR-018 an organization is the only
 * context anything resolves into, and `organizationId: null` is a fail-closed
 * default meaning resolution failed — not a personal surface to design for.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/decision-log-assignee-tenancy.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	assigneeFindMany,
	entryFindFirst,
	createMany,
	deleteMany,
	transaction,
} = vi.hoisted(() => ({
	assigneeFindMany: vi.fn(),
	entryFindFirst: vi.fn(),
	createMany: vi.fn(),
	deleteMany: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		decisionLogEntry: { findFirst: entryFindFirst },
		decisionLogEntryAssignee: {
			findMany: assigneeFindMany,
			createMany,
			deleteMany,
		},
		$transaction: transaction,
	},
	Prisma: {},
}));

import {
	listQuestionAssignees,
	setQuestionAssignees,
} from "../prisma/queries/feature-maturation";

const ORG = "org_acme";
/** The person doing the assigning. */
const ASSIGNER = "user_assigner";
/** A DIFFERENT person, being assigned. This difference is the whole test. */
const ASSIGNEE = "user_assignee";
const ENTRY = "entry_1";

const ORG_TENANT = { organizationId: ORG, userId: ASSIGNER };

beforeEach(() => {
	vi.clearAllMocks();
	assigneeFindMany.mockResolvedValue([]);
	entryFindFirst.mockResolvedValue({
		id: ENTRY,
		userId: "user_question_owner",
		organizationId: ORG,
	});
	createMany.mockResolvedValue({ count: 0 });
	deleteMany.mockResolvedValue({ count: 0 });
	transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) =>
			await fn({
				decisionLogEntryAssignee: { createMany, deleteMany },
			}),
	);
});

describe("listQuestionAssignees — scoped by tenant, not by assignee", () => {
	it("filters on the tenant and never on assigneeUserId", async () => {
		await listQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryIds: [ENTRY],
		});

		expect(assigneeFindMany).toHaveBeenCalledTimes(1);
		const where = assigneeFindMany.mock.calls[0][0].where;

		expect(where.organizationId).toBe(ORG);
		// The load-bearing assertion: scoping by the assignee would hide an
		// assignment from the person who created it.
		expect(where).not.toHaveProperty("assigneeUserId");
		expect(where).not.toHaveProperty("assignedByUserId");
	});

	it("returns an assignment the assigner made for someone else", async () => {
		assigneeFindMany.mockResolvedValue([
			{
				decisionLogEntryId: ENTRY,
				assigneeUserId: ASSIGNEE,
				assignedByUserId: ASSIGNER,
			},
		]);

		const byEntry = await listQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryIds: [ENTRY],
		});

		expect(byEntry.get(ENTRY)).toEqual([
			{ assigneeUserId: ASSIGNEE, assignedByUserId: ASSIGNER },
		]);
	});

	it("short-circuits without querying when there are no entries", async () => {
		const byEntry = await listQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryIds: [],
		});

		expect(byEntry.size).toBe(0);
		expect(assigneeFindMany).not.toHaveBeenCalled();
	});
});

describe("setQuestionAssignees — tenant columns come from the question", () => {
	it("copies userId/organizationId from the question, not from the assignee", async () => {
		const added = await setQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryId: ENTRY,
			assigneeUserIds: [ASSIGNEE],
			assignedByUserId: ASSIGNER,
		});

		expect(added).toEqual([ASSIGNEE]);
		const row = createMany.mock.calls[0][0].data[0];

		// The tenant key is the QUESTION's owner…
		expect(row.userId).toBe("user_question_owner");
		expect(row.organizationId).toBe(ORG);
		// …and the assignee is carried separately.
		expect(row.assigneeUserId).toBe(ASSIGNEE);
		expect(row.assignedByUserId).toBe(ASSIGNER);
		expect(row.userId).not.toBe(ASSIGNEE);
	});

	it("refuses to write when the question is not visible in this tenant", async () => {
		entryFindFirst.mockResolvedValue(null);

		const added = await setQuestionAssignees({
			tenantFilter: { organizationId: "org_other", userId: ASSIGNER },
			entryId: ENTRY,
			assigneeUserIds: [ASSIGNEE],
			assignedByUserId: ASSIGNER,
		});

		expect(added).toEqual([]);
		expect(createMany).not.toHaveBeenCalled();
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("keeps the original assigner when the same person is re-saved", async () => {
		assigneeFindMany.mockResolvedValue([{ assigneeUserId: ASSIGNEE }]);

		const added = await setQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryId: ENTRY,
			assigneeUserIds: [ASSIGNEE],
			assignedByUserId: "user_someone_else",
		});

		// Already present ⇒ not re-created, so `assignedByUserId` is untouched and
		// the original asker still hears the answer.
		expect(added).toEqual([]);
		expect(createMany).not.toHaveBeenCalled();
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("clears every assignee when given an empty set", async () => {
		assigneeFindMany.mockResolvedValue([
			{ assigneeUserId: ASSIGNEE },
			{ assigneeUserId: "user_third" },
		]);

		await setQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryId: ENTRY,
			assigneeUserIds: [],
			assignedByUserId: ASSIGNER,
		});

		expect(deleteMany.mock.calls[0][0].where.assigneeUserId.in).toEqual([
			ASSIGNEE,
			"user_third",
		]);
		expect(createMany).not.toHaveBeenCalled();
	});

	it("de-duplicates a repeated assignee", async () => {
		await setQuestionAssignees({
			tenantFilter: ORG_TENANT,
			entryId: ENTRY,
			assigneeUserIds: [ASSIGNEE, ASSIGNEE, "user_third"],
			assignedByUserId: ASSIGNER,
		});

		expect(createMany.mock.calls[0][0].data).toHaveLength(2);
	});
});
