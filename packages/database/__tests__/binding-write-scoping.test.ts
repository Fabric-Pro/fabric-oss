/**
 * The WHERE clauses that decide whose row a write touches.
 *
 * Three functions here own a filter that is the entire safety property, and all
 * three were only ever exercised through a mock OF THEMSELVES — the procedure
 * tests replace them with `vi.fn()`, so what they actually send the database was
 * never asserted anywhere.
 *
 * That is the gap worth closing rather than the happy paths: each of these
 * clauses can lose a field and still return a plausible result. A clear that
 * drops `userId` matches every user's row for the target; a resolver that stops
 * filtering `storyKind` answers a BUG lookup with a FEATURE prompt; a withdraw
 * that drops `nominatedById` reaches somebody else's proposal.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/binding-write-scoping.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindingUpdateMany,
	bindingDeleteMany,
	bindingFindFirst,
	nominationUpdateMany,
} = vi.hoisted(() => ({
	bindingUpdateMany: vi.fn(),
	bindingDeleteMany: vi.fn(),
	bindingFindFirst: vi.fn(),
	nominationUpdateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		promptBinding: {
			updateMany: bindingUpdateMany,
			deleteMany: bindingDeleteMany,
			findFirst: bindingFindFirst,
		},
		promptNomination: { updateMany: nominationUpdateMany },
	},
	Prisma: {},
}));

import { withdrawPromptNomination } from "../prisma/queries/prompt-nominations";
import {
	clearPromptBinding,
	getBoundPromptVersion,
} from "../prisma/queries/prompts";

beforeEach(() => {
	bindingUpdateMany.mockReset();
	bindingUpdateMany.mockResolvedValue({ count: 1 });
	bindingDeleteMany.mockReset();
	bindingDeleteMany.mockResolvedValue({ count: 1 });
	bindingFindFirst.mockReset();
	bindingFindFirst.mockResolvedValue(null);
	nominationUpdateMany.mockReset();
	nominationUpdateMany.mockResolvedValue({ count: 1 });
});

// Clearing keeps the row and drops its default flag (FR12, soft-clear), so
// every scoping assertion below reads the UPDATE's WHERE plus its data — the
// flag drop must never widen what the statement matches.
describe("clearPromptBinding clears exactly one tier's default", () => {
	it("scopes a personal clear to the caller's own binding", async () => {
		// Dropping userId here would clear the same action for every user who
		// has a personal override — and report success.
		await clearPromptBinding({
			targetType: "AGENT",
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			storyKind: null,
			scope: "USER",
			userId: "user-1",
		});

		expect(bindingUpdateMany).toHaveBeenCalledWith({
			where: {
				targetType: "AGENT",
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "USER",
				userId: "user-1",
				organizationId: null,
				projectId: null,
				isDefault: true,
			},
			data: { isDefault: false },
		});
	});

	it("scopes an organization clear to that organization", async () => {
		await clearPromptBinding({
			targetType: "AGENT",
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			scope: "ORG",
			organizationId: "org-a",
		});

		expect(bindingUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					scope: "ORG",
					organizationId: "org-a",
					userId: null,
					isDefault: true,
				}),
			}),
		);
	});

	it("names the story kind so a clear cannot take the other kind's row", async () => {
		await clearPromptBinding({
			targetType: "AGENT",
			targetKey: "project_document_generator",
			documentType: "DRAFT",
			storyKind: "BUG",
			scope: "ORG",
			organizationId: "org-a",
		});

		expect(bindingUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ storyKind: "BUG" }),
			}),
		);
	});

	it("reports whether anything was actually cleared", async () => {
		bindingUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			clearPromptBinding({
				targetType: "AGENT",
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				scope: "USER",
				userId: "user-1",
			}),
		).resolves.toEqual({ cleared: false });
	});
});

describe("getBoundPromptVersion matches storyKind exactly", () => {
	const lookup = (storyKind: "FEATURE" | "BUG" | null | undefined) =>
		getBoundPromptVersion({
			targetType: "AGENT",
			targetKey: "project_document_generator",
			documentType: "DRAFT",
			storyKind,
			organizationId: "org-a",
		});

	/** The storyKind each query actually asked the database for. */
	const kindsAskedFor = () =>
		bindingFindFirst.mock.calls.map((c) => c[0].where.storyKind);

	it("asks for BUG and nothing else when looking up a bug stage", async () => {
		// The docstring is explicit that there is no cross-bucket fallback: a
		// missing BUG binding must NOT resolve to the FEATURE one. A query that
		// stopped naming storyKind would silently answer with either.
		await lookup("BUG");

		expect(kindsAskedFor().every((k) => k === "BUG")).toBe(true);
	});

	it("asks for FEATURE and nothing else when looking up a feature stage", async () => {
		await lookup("FEATURE");

		expect(kindsAskedFor().every((k) => k === "FEATURE")).toBe(true);
	});

	it("treats an omitted kind as the non-stage slot, not as a wildcard", async () => {
		await lookup(undefined);

		expect(kindsAskedFor().every((k) => k === null)).toBe(true);
	});

	it("falls through the tiers without ever changing the kind", async () => {
		// ORG then SYSTEM. Both must carry the same kind — a fallback that
		// widened on the way down is exactly the cross-bucket leak.
		await lookup("BUG");

		expect(bindingFindFirst.mock.calls.length).toBeGreaterThan(1);
		expect(new Set(kindsAskedFor())).toEqual(new Set(["BUG"]));
	});
});

describe("withdrawPromptNomination cannot reach someone else's", () => {
	it("scopes the update to the owner and to PENDING in one statement", async () => {
		// Both conditions in the same WHERE, not a read followed by a write:
		// a separate check leaves a window where a concurrent decision lands
		// between them.
		await withdrawPromptNomination({
			nominationId: "nom-1",
			nominatedById: "user-1",
		});

		expect(nominationUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "nom-1",
					nominatedById: "user-1",
					status: "PENDING",
				},
			}),
		);
	});

	it("reports nothing withdrawn when no row matched", async () => {
		nominationUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			withdrawPromptNomination({
				nominationId: "nom-1",
				nominatedById: "someone-else",
			}),
		).resolves.toEqual({ withdrawn: false });
	});
});

/**
 * FR12: a cleared override must remain reusable.
 *
 * The requirement is that clearing "does not delete the underlying prompt
 * content", so the user can put it back later without recreating it. That is a
 * claim about what the operation does NOT touch, and nothing asserted it — the
 * clear could have grown a cascade at any point and every test would still pass,
 * because they all check the binding row.
 */
describe("clearPromptBinding leaves the prompt itself alone", () => {
	it("touches only the binding table", async () => {
		await clearPromptBinding({
			targetType: "AGENT",
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			scope: "ORG",
			organizationId: "org-a",
		});

		// The mocked client exposes ONLY promptBinding and promptNomination —
		// a call to prompt or promptVersion would throw rather than silently
		// delete, which is what makes this assertion meaningful.
		expect(bindingUpdateMany).toHaveBeenCalledTimes(1);
		expect(bindingDeleteMany).not.toHaveBeenCalled();
	});

	it("does not cascade to the version the binding pointed at", async () => {
		// Asserted through the update's own shape: it filters on the action and
		// tier, and names no version, so it cannot reach one.
		await clearPromptBinding({
			targetType: "AGENT",
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			scope: "USER",
			userId: "user-1",
		});

		const call = bindingUpdateMany.mock.calls[0][0];
		expect(call.where).not.toHaveProperty("promptVersionId");
		expect(call.where).not.toHaveProperty("promptVersion");
		expect(call.data).toEqual({ isDefault: false });
	});
});
