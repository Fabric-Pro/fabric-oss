/**
 * Who hears that a tier's default prompt changed, and how it is framed.
 *
 * Fizzy #2068 FR6. The audience rule for the universal tier is a deliberate
 * narrowing, so it is pinned here rather than left to be rediscovered: a
 * platform-wide message on every system prompt edit is a volume decision, and
 * the people who can act on one are organization owners and admins.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-default-recipients.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { memberFindMany, bindingFindMany } = vi.hoisted(() => ({
	memberFindMany: vi.fn(),
	bindingFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		member: { findMany: memberFindMany },
		promptBinding: { findMany: bindingFindMany },
	},
	Prisma: {},
}));

import { listPromptDefaultRecipients } from "../prisma/queries/prompt-default-recipients";

const TARGET = {
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
	storyKind: null,
};

describe("listPromptDefaultRecipients", () => {
	beforeEach(() => {
		memberFindMany.mockReset();
		bindingFindMany.mockReset();
		bindingFindMany.mockResolvedValue([]);
	});

	it("tells every member when an organization default changes", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "u-1", organizationId: "org-1" },
			{ userId: "u-2", organizationId: "org-1" },
		]);

		const recipients = await listPromptDefaultRecipients({
			scope: "ORG",
			organizationId: "org-1",
			...TARGET,
		});

		expect(recipients.map((r) => r.userId).sort()).toEqual(["u-1", "u-2"]);
		// Scoped to that organization, not to every member everywhere.
		expect(memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1" },
			}),
		);
	});

	it("tells only owners and admins when the universal default changes", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "admin-1", organizationId: "org-1" },
		]);

		await listPromptDefaultRecipients({ scope: "SYSTEM", ...TARGET });

		expect(memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { role: { in: ["admin", "owner"] } },
			}),
		);
	});

	it("never tells the person who made the change", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "actor", organizationId: "org-1" },
			{ userId: "other", organizationId: "org-1" },
		]);

		const recipients = await listPromptDefaultRecipients({
			scope: "ORG",
			organizationId: "org-1",
			excludeUserId: "actor",
			...TARGET,
		});

		expect(recipients.map((r) => r.userId)).toEqual(["other"]);
	});

	it("frames it as informational for someone holding their own override", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "has-override", organizationId: "org-1" },
			{ userId: "no-override", organizationId: "org-1" },
		]);
		bindingFindMany.mockResolvedValue([{ userId: "has-override" }]);

		const recipients = await listPromptDefaultRecipients({
			scope: "ORG",
			organizationId: "org-1",
			...TARGET,
		});

		const byId = Object.fromEntries(
			recipients.map((r) => [r.userId, r.hasOwnOverride]),
		);
		expect(byId["has-override"]).toBe(true);
		expect(byId["no-override"]).toBe(false);
	});

	it("looks for an override on the same action, not merely the same agent", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "u-1", organizationId: "org-1" },
		]);

		await listPromptDefaultRecipients({
			scope: "ORG",
			organizationId: "org-1",
			targetKey: "project_document_generator",
			documentType: "DRAFT",
			storyKind: "FEATURE",
		});

		expect(bindingFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					storyKind: "FEATURE",
					scope: "USER",
					isDefault: true,
				}),
			}),
		);
	});

	it("lists a user once even when they belong to several organizations", async () => {
		memberFindMany.mockResolvedValue([
			{ userId: "u-1", organizationId: "org-1" },
			{ userId: "u-1", organizationId: "org-2" },
		]);

		const recipients = await listPromptDefaultRecipients({
			scope: "SYSTEM",
			...TARGET,
		});

		expect(recipients).toHaveLength(1);
	});

	it("returns nothing when an org default changes with no organization", async () => {
		const recipients = await listPromptDefaultRecipients({
			scope: "ORG",
			organizationId: null,
			...TARGET,
		});

		expect(recipients).toEqual([]);
		expect(memberFindMany).not.toHaveBeenCalled();
	});

	it("does not query overrides when there is nobody to tell", async () => {
		memberFindMany.mockResolvedValue([]);

		const recipients = await listPromptDefaultRecipients({
			scope: "SYSTEM",
			...TARGET,
		});

		expect(recipients).toEqual([]);
		expect(bindingFindMany).not.toHaveBeenCalled();
	});
});
