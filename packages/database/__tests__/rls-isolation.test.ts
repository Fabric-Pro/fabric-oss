/**
 * Database-Level Row Level Security (RLS) Tests
 *
 * These tests verify that PostgreSQL RLS policies correctly enforce tenant isolation
 * at the database level. This provides defense-in-depth alongside application-level filtering.
 *
 * IMPORTANT: These tests require a real PostgreSQL database with RLS policies enabled.
 * Run with: pnpm --filter @repo/database test:rls
 */

import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
} from "@repo/utils/attachment";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import type { Prisma } from "../prisma/generated/client";
import { getMinimumAttachmentRetentionOverride } from "../prisma/queries/projects/attachment-retention";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

describe("PostgreSQL RLS Policies", () => {
	const TEST_USERS = {
		userA: "test-user-a-rls",
		userB: "test-user-b-rls",
	};

	const TEST_ORGS = {
		orgA: "test-org-a-rls",
		orgB: "test-org-b-rls",
	};

	beforeEach(() => {
		expect.hasAssertions();
	});

	beforeAll(async () => {
		// Provision the restricted RLS role before any fixtures are created
		// (this hook is registered before the nested-describe fixtures).
		await ensureRlsTestRole();

		const now = new Date();

		// Create test users. `User.createdAt` has no schema default, so it must
		// be supplied explicitly (mirrors the organization/member creates below).
		await db.user.upsert({
			where: { id: TEST_USERS.userA },
			update: {},
			create: {
				id: TEST_USERS.userA,
				name: "Test User A",
				email: "user-a-rls@test.com",
				emailVerified: true,
				onboardingComplete: false,
				createdAt: now,
				updatedAt: now,
			} as Prisma.UserUncheckedCreateInput,
		});

		await db.user.upsert({
			where: { id: TEST_USERS.userB },
			update: {},
			create: {
				id: TEST_USERS.userB,
				name: "Test User B",
				email: "user-b-rls@test.com",
				emailVerified: true,
				onboardingComplete: false,
				createdAt: now,
				updatedAt: now,
			} as Prisma.UserUncheckedCreateInput,
		});

		// Create test organizations
		await db.organization.upsert({
			where: { id: TEST_ORGS.orgA },
			update: {},
			create: {
				id: TEST_ORGS.orgA,
				name: "Test Org A",
				createdAt: new Date(),
			},
		});

		await db.organization.upsert({
			where: { id: TEST_ORGS.orgB },
			update: {},
			create: {
				id: TEST_ORGS.orgB,
				name: "Test Org B",
				createdAt: new Date(),
			},
		});

		// Create memberships
		await db.member.upsert({
			where: {
				organizationId_userId: {
					organizationId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
			},
			update: {},
			create: {
				organizationId: TEST_ORGS.orgA,
				userId: TEST_USERS.userA,
				role: "owner",
				createdAt: new Date(),
			},
		});

		await db.member.upsert({
			where: {
				organizationId_userId: {
					organizationId: TEST_ORGS.orgA,
					userId: TEST_USERS.userB,
				},
			},
			update: {},
			create: {
				organizationId: TEST_ORGS.orgA,
				userId: TEST_USERS.userB,
				role: "member",
				createdAt: new Date(),
			},
		});

		await db.member.upsert({
			where: {
				organizationId_userId: {
					organizationId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
			},
			update: {},
			create: {
				organizationId: TEST_ORGS.orgB,
				userId: TEST_USERS.userA,
				role: "owner",
				createdAt: new Date(),
			},
		});
	});

	afterAll(async () => {
		// Cleanup test data
		await db.mCPConfig.deleteMany({
			where: {
				OR: [
					{ userId: TEST_USERS.userA },
					{ userId: TEST_USERS.userB },
					{ organizationId: TEST_ORGS.orgA },
					{ organizationId: TEST_ORGS.orgB },
				],
			},
		});

		await db.member.deleteMany({
			where: {
				OR: [
					{ userId: TEST_USERS.userA },
					{ userId: TEST_USERS.userB },
				],
			},
		});

		await db.organization.deleteMany({
			where: { id: { in: [TEST_ORGS.orgA, TEST_ORGS.orgB] } },
		});

		await db.user.deleteMany({
			where: { id: { in: [TEST_USERS.userA, TEST_USERS.userB] } },
		});
	});

	describe("MCPConfig RLS Isolation", () => {
		let personalConfigA: string;
		let orgAConfigA: string;
		let orgAConfigB: string;
		let orgBConfigA: string;

		beforeAll(async () => {
			// MCPConfig.mcpServerId is a FK to MCPServer; the parent row must
			// exist before any config insert. Seeded on the privileged db.
			await db.mCPServer.upsert({
				where: { id: "test-server" },
				update: {},
				create: {
					id: "test-server",
					key: "test-server",
					name: "Test MCP Server",
				},
			});

			// Create test configs
			// Personal config for User A
			personalConfigA = (
				await db.mCPConfig.create({
					data: {
						mcpServerId: "test-server",
						userId: TEST_USERS.userA,
						organizationId: null,
						authType: "NONE",
						enabled: true,
					},
				})
			).id;

			// Org A config for User A (per-user within org)
			orgAConfigA = (
				await db.mCPConfig.create({
					data: {
						mcpServerId: "test-server",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgA,
						authType: "NONE",
						enabled: true,
					},
				})
			).id;

			// Org A config for User B (per-user within org)
			orgAConfigB = (
				await db.mCPConfig.create({
					data: {
						mcpServerId: "test-server",
						userId: TEST_USERS.userB,
						organizationId: TEST_ORGS.orgA,
						authType: "NONE",
						enabled: true,
					},
				})
			).id;

			// Org B config for User A
			orgBConfigA = (
				await db.mCPConfig.create({
					data: {
						mcpServerId: "test-server",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgB,
						authType: "NONE",
						enabled: true,
					},
				})
			).id;
		});

		it("should allow User A to read their personal config", async () => {
			const config = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.mCPConfig.findUnique({ where: { id: personalConfigA } }),
			);

			expect(config).not.toBeNull();
			expect(config?.id).toBe(personalConfigA);
		});

		it("should NOT allow User A to read User B's personal config (actual)", async () => {
			// First create User B's personal config (fixture — on the privileged db)
			const userBPersonalConfig = (
				await db.mCPConfig.create({
					data: {
						mcpServerId: "test-server",
						userId: TEST_USERS.userB,
						organizationId: null,
						authType: "NONE",
						enabled: true,
					},
				})
			).id;

			// User B's personal config should not be visible to User A
			const config = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.mCPConfig.findUnique({
						where: { id: userBPersonalConfig },
					}),
			);

			// RLS should block access
			expect(config).toBeNull();

			// Cleanup
			await db.mCPConfig.delete({ where: { id: userBPersonalConfig } });
		});

		it("should allow User A to read their org-scoped config in Org A", async () => {
			const config = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) => tx.mCPConfig.findUnique({ where: { id: orgAConfigA } }),
			);

			expect(config).not.toBeNull();
			expect(config?.id).toBe(orgAConfigA);
		});

		it("should NOT allow User A to read User B's org-scoped config in Org A", async () => {
			// User B's config in Org A should not be visible to User A
			const config = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) => tx.mCPConfig.findUnique({ where: { id: orgAConfigB } }),
			);

			// Per-user isolation should block this
			expect(config).toBeNull();
		});

		it("should NOT allow User A to read Org B's config when in Org A context", async () => {
			// Org B's config should not be visible
			const config = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) => tx.mCPConfig.findUnique({ where: { id: orgBConfigA } }),
			);

			// Different organization should be blocked
			expect(config).toBeNull();
		});

		it("should block access when no tenant context is set", async () => {
			// No configs should be visible without tenant context
			const config = await asRlsRole({ type: "none" }, (tx) =>
				tx.mCPConfig.findUnique({ where: { id: personalConfigA } }),
			);

			expect(config).toBeNull();
		});
	});

	describe("AiChat RLS Isolation (per_user_within_org)", () => {
		let personalChatA: string;
		let personalChatB: string;
		let orgChatAOwnedByA: string;
		let orgChatAOwnedByB: string;
		let orgChatBOwnedByA: string;

		beforeAll(async () => {
			personalChatA = (
				await db.aiChat.create({
					data: {
						userId: TEST_USERS.userA,
						organizationId: null,
						title: "Personal A",
						messages: [],
					},
				})
			).id;
			personalChatB = (
				await db.aiChat.create({
					data: {
						userId: TEST_USERS.userB,
						organizationId: null,
						title: "Personal B",
						messages: [],
					},
				})
			).id;
			orgChatAOwnedByA = (
				await db.aiChat.create({
					data: {
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgA,
						title: "Org A / A",
						messages: [],
					},
				})
			).id;
			orgChatAOwnedByB = (
				await db.aiChat.create({
					data: {
						userId: TEST_USERS.userB,
						organizationId: TEST_ORGS.orgA,
						title: "Org A / B",
						messages: [],
					},
				})
			).id;
			orgChatBOwnedByA = (
				await db.aiChat.create({
					data: {
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgB,
						title: "Org B / A",
						messages: [],
					},
				})
			).id;
		});

		it("allows User A to read their personal chat", async () => {
			const chat = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) => tx.aiChat.findUnique({ where: { id: personalChatA } }),
			);
			expect(chat).not.toBeNull();
		});

		it("does NOT allow User A to see their org chat from personal context", async () => {
			const chat = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.aiChat.findUnique({ where: { id: orgChatAOwnedByA } }),
			);
			expect(chat).toBeNull();
		});

		it("allows User A to read their own org chat in Org A context", async () => {
			const chat = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.aiChat.findUnique({ where: { id: orgChatAOwnedByA } }),
			);
			expect(chat).not.toBeNull();
		});

		it("does NOT allow User A to read User B's org chat in Org A (per-user isolation)", async () => {
			const chat = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.aiChat.findUnique({ where: { id: orgChatAOwnedByB } }),
			);
			expect(chat).toBeNull();
		});

		it("does NOT allow User A to read an Org B chat while in Org A context", async () => {
			const chat = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.aiChat.findUnique({ where: { id: orgChatBOwnedByA } }),
			);
			expect(chat).toBeNull();
		});

		it("does NOT allow User A's personal chat to be visible in Org A context", async () => {
			const chat = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) => tx.aiChat.findUnique({ where: { id: personalChatA } }),
			);
			expect(chat).toBeNull();
		});

		it("does NOT allow User A to read User B's personal chat (per-user personal isolation)", async () => {
			const chat = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) => tx.aiChat.findUnique({ where: { id: personalChatB } }),
			);
			expect(chat).toBeNull();
		});

		it("prevents User A from creating a personal chat attributed to User B (WITH CHECK userId)", async () => {
			await expect(
				asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USERS.userA,
						userId: TEST_USERS.userA,
					},
					(tx) =>
						tx.aiChat.create({
							data: {
								userId: TEST_USERS.userB,
								organizationId: null,
								title: "Wrong user personal",
								messages: [],
							},
						}),
				),
			).rejects.toThrow(/row-level security/i);
		});

		it("prevents User A from creating an org chat attributed to User B (WITH CHECK userId)", async () => {
			await expect(
				asRlsRole(
					{
						type: "organization",
						tenantId: TEST_ORGS.orgA,
						userId: TEST_USERS.userA,
					},
					(tx) =>
						tx.aiChat.create({
							data: {
								userId: TEST_USERS.userB,
								organizationId: TEST_ORGS.orgA,
								title: "Wrong user org",
								messages: [],
							},
						}),
				),
			).rejects.toThrow(/row-level security/i);
		});

		it("prevents creating an org-scoped chat from personal context (WITH CHECK)", async () => {
			await expect(
				asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USERS.userA,
						userId: TEST_USERS.userA,
					},
					(tx) =>
						tx.aiChat.create({
							data: {
								userId: TEST_USERS.userA,
								organizationId: TEST_ORGS.orgA,
								title: "Blocked",
								messages: [],
							},
						}),
				),
			).rejects.toThrow(/row-level security/i);
		});

		it("allows User A to create their own org chat in Org A context", async () => {
			const created = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.aiChat.create({
						data: {
							userId: TEST_USERS.userA,
							organizationId: TEST_ORGS.orgA,
							title: "Allowed",
							messages: [],
						},
					}),
			);
			expect(created.organizationId).toBe(TEST_ORGS.orgA);
			await db.aiChat.delete({ where: { id: created.id } });
		});
	});

	describe("DailyBriefReleaseNoteExclusion RLS Isolation", () => {
		// Same `user_owned` policy shape as MCPConfig above: organization reads
		// filter on organizationId only (any org member sees every org row for
		// their project); personal reads additionally require userId to match
		// the row's owner. Every exclusion row belongs to a Project, so each
		// fixture gets its own project scoped to the same tenant.
		let personalProjectA: string;
		let personalProjectB: string;
		let orgAProject: string;
		let orgBProject: string;

		let personalExclusionA: string;
		let personalExclusionB: string;
		let orgAExclusion: string;
		let orgBExclusion: string;

		beforeAll(async () => {
			personalProjectA = (
				await db.project.create({
					data: {
						name: "RLS Personal Project A",
						userId: TEST_USERS.userA,
					},
				})
			).id;
			personalProjectB = (
				await db.project.create({
					data: {
						name: "RLS Personal Project B",
						userId: TEST_USERS.userB,
					},
				})
			).id;
			orgAProject = (
				await db.project.create({
					data: {
						name: "RLS Org A Project",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgA,
					},
				})
			).id;
			orgBProject = (
				await db.project.create({
					data: {
						name: "RLS Org B Project",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgB,
					},
				})
			).id;

			personalExclusionA = (
				await db.dailyBriefReleaseNoteExclusion.create({
					data: {
						projectId: personalProjectA,
						organizationId: null,
						userId: TEST_USERS.userA,
						kind: "pr",
						targetKey: "pr:acme/personal-a#1",
						repoFullName: "acme/personal-a",
						prNumber: 1,
						excludedByUserId: TEST_USERS.userA,
					},
				})
			).id;
			personalExclusionB = (
				await db.dailyBriefReleaseNoteExclusion.create({
					data: {
						projectId: personalProjectB,
						organizationId: null,
						userId: TEST_USERS.userB,
						kind: "pr",
						targetKey: "pr:acme/personal-b#1",
						repoFullName: "acme/personal-b",
						prNumber: 1,
						excludedByUserId: TEST_USERS.userB,
					},
				})
			).id;
			orgAExclusion = (
				await db.dailyBriefReleaseNoteExclusion.create({
					data: {
						projectId: orgAProject,
						organizationId: TEST_ORGS.orgA,
						userId: TEST_USERS.userA,
						kind: "story",
						targetKey: "story:F-ORG-A",
						storyIdentifier: "F-ORG-A",
						excludedByUserId: TEST_USERS.userA,
					},
				})
			).id;
			orgBExclusion = (
				await db.dailyBriefReleaseNoteExclusion.create({
					data: {
						projectId: orgBProject,
						organizationId: TEST_ORGS.orgB,
						userId: TEST_USERS.userA,
						kind: "story",
						targetKey: "story:F-ORG-B",
						storyIdentifier: "F-ORG-B",
						excludedByUserId: TEST_USERS.userA,
					},
				})
			).id;
		});

		it("should allow User A to read their personal exclusion", async () => {
			const row = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: personalExclusionA },
					}),
			);

			expect(row).not.toBeNull();
			expect(row?.id).toBe(personalExclusionA);
		});

		it("should NOT allow User A to read User B's personal exclusion", async () => {
			const row = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: personalExclusionB },
					}),
			);

			expect(row).toBeNull();
		});

		it("should allow User A to read Org A's exclusion in Org A context", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: orgAExclusion },
					}),
			);

			expect(row).not.toBeNull();
			expect(row?.id).toBe(orgAExclusion);
		});

		it("should NOT allow User A to read Org B's exclusion when in Org A context", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: orgBExclusion },
					}),
			);

			expect(row).toBeNull();
		});

		it("should NOT allow User A's personal exclusion to be visible in Org A context", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: personalExclusionA },
					}),
			);

			expect(row).toBeNull();
		});

		it("should prevent UPDATE of Org A's exclusion from Org B context", async () => {
			const { count } = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.updateMany({
						where: { id: orgAExclusion },
						data: { reason: "blocked cross-tenant update" },
					}),
			);
			expect(count).toBe(0);

			// Confirm unchanged when read back from the correct tenant.
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: orgAExclusion },
					}),
			);
			expect(row?.reason).toBeNull();
		});

		it("should prevent DELETE of Org A's exclusion from a personal context", async () => {
			const { count } = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.deleteMany({
						where: { id: orgAExclusion },
					}),
			);
			expect(count).toBe(0);

			// Confirm the row still exists when read back from the correct tenant.
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: orgAExclusion },
					}),
			);
			expect(row).not.toBeNull();
		});

		it("should allow UPDATE within the correct tenant", async () => {
			const { count } = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.updateMany({
						where: { id: orgAExclusion },
						data: { reason: "allowed same-tenant update" },
					}),
			);
			expect(count).toBe(1);

			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: orgAExclusion },
					}),
			);
			expect(row?.reason).toBe("allowed same-tenant update");
		});

		it("should reject moving a VISIBLE Org A exclusion into Org B (user_owned WITH CHECK)", async () => {
			await expect(
				asRlsRole(
					{
						type: "organization",
						tenantId: TEST_ORGS.orgA,
						userId: TEST_USERS.userA,
					},
					(tx) =>
						tx.dailyBriefReleaseNoteExclusion.updateMany({
							where: { id: orgAExclusion },
							data: { organizationId: TEST_ORGS.orgB },
						}),
				),
			).rejects.toThrow(/row-level security/i);

			// Unchanged when read back from Org A.
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.dailyBriefReleaseNoteExclusion.findUnique({
						where: { id: orgAExclusion },
					}),
			);
			expect(row?.organizationId).toBe(TEST_ORGS.orgA);
		});
	});

	describe("Publishing Suite RLS Isolation", () => {
		// Same `user_owned` policy shape as DailyBriefReleaseNoteExclusion above:
		// organization reads filter on organizationId only (any org member sees
		// every org row for their project). Both tables are org-scoped rows
		// belonging to a Project, so the Org A fixture gets its own org-scoped
		// project (mirrors orgAProject above). An Org B project is also created
		// so the Org B tenant is a real, populated tenant — not merely an
		// absent-row edge case — even though no row is created under it; the
		// isolation assertion below relies only on the Org B *tenant context*
		// (TEST_ORGS.orgB), not on an Org B project id.
		let orgAProject: string;

		let orgACycleId: string;
		let orgATopicId: string;
		let orgASettingsId: string;
		let personalProject: string;
		let personalCycleId: string;
		let orgADeliveryId: string;
		let personalDeliveryId: string;
		let orgAChatDeliveryId: string;
		let personalChatDeliveryId: string;

		beforeAll(async () => {
			orgAProject = (
				await db.project.create({
					data: {
						name: "RLS Publishing Suite Org A Project",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgA,
					},
				})
			).id;
			await db.project.create({
				data: {
					name: "RLS Publishing Suite Org B Project",
					userId: TEST_USERS.userA,
					organizationId: TEST_ORGS.orgB,
				},
			});

			orgACycleId = (
				await db.publishingSuggestionCycle.create({
					data: {
						projectId: orgAProject,
						organizationId: TEST_ORGS.orgA,
						status: "READY",
						actorUserId: TEST_USERS.userA,
						coveredThrough: new Date(),
					},
				})
			).id;

			orgATopicId = (
				await db.publishingTopic.create({
					data: {
						projectId: orgAProject,
						organizationId: TEST_ORGS.orgA,
						title: "RLS isolation smoke topic",
						origin: "AI",
						dedupeKey: "rls-publishing-suite-org-a-topic",
						status: "SUGGESTION",
					},
				})
			).id;

			orgASettingsId = (
				await db.publishingSuiteSettings.create({
					data: {
						projectId: orgAProject,
						organizationId: TEST_ORGS.orgA,
						createdByUserId: TEST_USERS.userA,
					},
				})
			).id;

			personalProject = (
				await db.project.create({
					data: {
						name: "RLS Publishing Suite Personal Project",
						userId: TEST_USERS.userA,
						organizationId: null,
					},
				})
			).id;

			personalCycleId = (
				await db.publishingSuggestionCycle.create({
					data: {
						projectId: personalProject,
						userId: TEST_USERS.userA,
						status: "READY",
						actorUserId: TEST_USERS.userA,
						coveredThrough: new Date(),
					},
				})
			).id;

			orgADeliveryId = (
				await db.publishingNotificationDelivery.create({
					data: {
						cycleId: orgACycleId,
						projectId: orgAProject,
						organizationId: TEST_ORGS.orgA,
						recipientUserId: TEST_USERS.userA,
						channel: "IN_APP",
						status: "SENT",
						deliveredAt: new Date(),
					},
				})
			).id;

			personalDeliveryId = (
				await db.publishingNotificationDelivery.create({
					data: {
						cycleId: personalCycleId,
						projectId: personalProject,
						userId: TEST_USERS.userA,
						recipientUserId: TEST_USERS.userA,
						channel: "IN_APP",
						status: "SENT",
						deliveredAt: new Date(),
					},
				})
			).id;

			orgAChatDeliveryId = (
				await db.publishingChatDelivery.create({
					data: {
						cycleId: orgACycleId,
						projectId: orgAProject,
						organizationId: TEST_ORGS.orgA,
						platform: "SLACK",
						externalTeamId: "T-example",
						channelId: "C-example-org",
						status: "SENT",
						deliveredAt: new Date(),
					},
				})
			).id;

			personalChatDeliveryId = (
				await db.publishingChatDelivery.create({
					data: {
						cycleId: personalCycleId,
						projectId: personalProject,
						userId: TEST_USERS.userA,
						platform: "SLACK",
						externalTeamId: "T-example",
						channelId: "C-example-personal",
						status: "SENT",
						deliveredAt: new Date(),
					},
				})
			).id;
		});

		it("publishing_suggestion_cycle: Org B context cannot read Org A's cycle", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingSuggestionCycle.findUnique({
						where: { id: orgACycleId },
					}),
			);

			expect(row).toBeNull();
		});

		it("publishing_topic: Org B context cannot read Org A's topic", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingTopic.findUnique({
						where: { id: orgATopicId },
					}),
			);

			expect(row).toBeNull();
		});

		it("publishing_suggestion_cycle: Org A context CAN read its own cycle (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingSuggestionCycle.findUnique({
						where: { id: orgACycleId },
					}),
			);

			expect(row).not.toBeNull();
			expect(row?.id).toBe(orgACycleId);
		});

		it("publishing_topic: Org A context CAN read its own topic (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingTopic.findUnique({
						where: { id: orgATopicId },
					}),
			);

			expect(row).not.toBeNull();
			expect(row?.id).toBe(orgATopicId);
		});

		it("publishing_suite_settings: Org B context cannot read Org A's settings", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingSuiteSettings.findUnique({
						where: { id: orgASettingsId },
					}),
			);

			expect(row).toBeNull();
		});

		it("publishing_suite_settings: Org A context CAN read its own settings (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingSuiteSettings.findUnique({
						where: { id: orgASettingsId },
					}),
			);

			expect(row).not.toBeNull();
			expect(row?.id).toBe(orgASettingsId);
		});

		it("publishing_notification_delivery: Org B context cannot read Org A's delivery row", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingNotificationDelivery.findUnique({
						where: { id: orgADeliveryId },
					}),
			);
			expect(row).toBeNull();
		});

		it("publishing_notification_delivery: Org A context CAN read its own delivery row (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingNotificationDelivery.findUnique({
						where: { id: orgADeliveryId },
					}),
			);
			expect(row).not.toBeNull();
			expect(row?.id).toBe(orgADeliveryId);
		});

		// The recipient column is deliberately NOT a tenant column: user B is the RECIPIENT of nothing
		// here, and the policy must exclude them on the tenant `userId` alone.
		it("publishing_notification_delivery: another user's personal context cannot read a personal delivery row", async () => {
			const row = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userB,
					userId: TEST_USERS.userB,
				},
				(tx) =>
					tx.publishingNotificationDelivery.findUnique({
						where: { id: personalDeliveryId },
					}),
			);
			expect(row).toBeNull();
		});

		it("publishing_notification_delivery: the owning personal context CAN read its delivery row (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingNotificationDelivery.findUnique({
						where: { id: personalDeliveryId },
					}),
			);
			expect(row).not.toBeNull();
			expect(row?.id).toBe(personalDeliveryId);
		});

		// The broadcast ledger has NO recipient column, so the only thing standing
		// between one tenant and another's posted-message record is the tenant XOR
		// and the user_owned policy over it. That makes both directions worth
		// pinning: a policy that filtered nothing would pass the negatives only by
		// accident of an empty table, and a policy that filtered everything would
		// pass them while breaking the product.
		it("publishing_chat_delivery: Org B context cannot read Org A's broadcast row", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgB,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingChatDelivery.findUnique({
						where: { id: orgAChatDeliveryId },
					}),
			);
			expect(row).toBeNull();
		});

		it("publishing_chat_delivery: Org A context CAN read its own broadcast row (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingChatDelivery.findUnique({
						where: { id: orgAChatDeliveryId },
					}),
			);
			expect(row).not.toBeNull();
			expect(row?.id).toBe(orgAChatDeliveryId);
		});

		it("publishing_chat_delivery: another user's personal context cannot read a personal broadcast row", async () => {
			const row = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userB,
					userId: TEST_USERS.userB,
				},
				(tx) =>
					tx.publishingChatDelivery.findUnique({
						where: { id: personalChatDeliveryId },
					}),
			);
			expect(row).toBeNull();
		});

		it("publishing_chat_delivery: the owning personal context CAN read its broadcast row (positive control)", async () => {
			const row = await asRlsRole(
				{
					type: "personal",
					tenantId: TEST_USERS.userA,
					userId: TEST_USERS.userA,
				},
				(tx) =>
					tx.publishingChatDelivery.findUnique({
						where: { id: personalChatDeliveryId },
					}),
			);
			expect(row).not.toBeNull();
			expect(row?.id).toBe(personalChatDeliveryId);
		});
	});

	describe("Attachment retention minimum under RLS", () => {
		// The purge's scan-bound proof (#1749) depends on MIN() observing EVERY
		// row. `project` carries a `user_owned` policy, so under an RLS-enforcing
		// role the aggregate observes fewer rows — and a filtered minimum can only
		// come back LARGER, which narrows the nightly scan and silently skips
		// eligible rows forever. Unit mocks cannot catch that; it needs this role
		// harness. The fixture is built so the SMALLEST override lives in a tenant
		// the reading context cannot see: if RLS ever reached the aggregate, the
		// scoped answer would jump from the floor to the Org A value.
		// Deliberately the floor of the usable range rather than a loose literal:
		// the assertion below relies on nothing else in the database being able to
		// undercut it, which is only true at the minimum.
		const LOW_OVERRIDE_DAYS = MIN_ATTACHMENT_RETENTION_DAYS;
		const HIGH_OVERRIDE_DAYS = 365;

		let orgALowProject: string;
		let orgBLowProject: string;

		beforeAll(async () => {
			orgALowProject = (
				await db.project.create({
					data: {
						name: "RLS Attachment Retention Org A Project",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgA,
						attachmentRetentionDays: HIGH_OVERRIDE_DAYS,
						attachmentRetentionDaysUpdatedAt: new Date(),
					},
				})
			).id;

			// Invisible to an Org A tenant context — this is the row whose
			// disappearance would inflate the minimum.
			orgBLowProject = (
				await db.project.create({
					data: {
						name: "RLS Attachment Retention Org B Project",
						userId: TEST_USERS.userA,
						organizationId: TEST_ORGS.orgB,
						attachmentRetentionDays: LOW_OVERRIDE_DAYS,
						attachmentRetentionDaysUpdatedAt: new Date(),
					},
				})
			).id;
		});

		afterAll(async () => {
			await db.project.deleteMany({
				where: { id: { in: [orgALowProject, orgBLowProject] } },
			});
		});

		it("an RLS-scoped MIN() reads larger than the true minimum, which is why the purge must not use one", async () => {
			const unscoped = await getMinimumAttachmentRetentionOverride();

			// The fixture sits at the floor of the usable range the aggregate
			// filters on, so no other row in the database can undercut it.
			// Asserting it unconditionally proves the fixture actually landed
			// before the comparison below leans on it.
			expect(unscoped).toBe(LOW_OVERRIDE_DAYS);

			// The same aggregate, genuinely subject to RLS.
			//
			// This MUST run through the `tx` the harness supplies. `SET LOCAL
			// ROLE` binds to that transaction's connection, so calling the
			// production helper here instead — which reaches for the module-level
			// pooled `db` — would quietly run as the owner and compare the floor
			// against itself, a test that cannot fail. The project half of the
			// aggregate is enough to show the hazard; `organization` carries no
			// tenant policy.
			const scoped = await asRlsRole(
				{
					type: "organization",
					tenantId: TEST_ORGS.orgA,
					userId: TEST_USERS.userA,
				},
				async (tx) => {
					const rows = await tx.$queryRaw<{ min: number | null }[]>`
						SELECT MIN("attachmentRetentionDays")::int AS min
						FROM "project"
						WHERE "attachmentRetentionDays"
							BETWEEN ${MIN_ATTACHMENT_RETENTION_DAYS}
							AND ${MAX_ATTACHMENT_RETENTION_DAYS}`;
					return rows[0]?.min ?? null;
				},
			);

			// Org B's floor override is invisible from an Org A context, so the
			// smallest window an RLS-filtered reader can see is Org A's own 365.
			// Feeding THAT to the purge would bound the nightly scan at 365 days
			// while the 30-day tenant waits forever — the whole reason
			// getMinimumAttachmentRetentionOverride documents a BYPASSRLS
			// precondition. Asserting the exact value rather than merely "not the
			// floor" also fails loudly if the harness stopped enforcing RLS, which
			// is the state in which every assertion here would be a false pass.
			expect(scoped).toBe(HIGH_OVERRIDE_DAYS);
		});
	});
});
