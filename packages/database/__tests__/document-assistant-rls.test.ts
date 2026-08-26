/**
 * RLS metadata + isolation coverage for `document_assistant_conversation`
 * (spec 2026-05-19 §3.5 FR-20, §10.4, AC-11).
 *
 * Locally Fabric runs against the `postgres` superuser, which bypasses
 * `FORCE ROW LEVEL SECURITY` (Postgres bypasses force-RLS for superusers
 * by design). Staging/prod connect as the non-superuser `fabric_app` role
 * where the policy actively filters reads.
 *
 * To stay useful in both environments, this suite asserts the *structure*
 * of the protection (the table is RLS-enabled, FORCE RLS is on, and the
 * `tenant_isolation` policy is present with the correct USING/CHECK
 * clauses), and — when a non-superuser role is configured via
 * `RLS_TEST_ROLE` — runs the full read-isolation assertions through
 * `SET LOCAL ROLE` inside a transaction.
 *
 * Requires DATABASE_URL + `pnpm --filter @repo/database apply:rls` to have
 * been run at least once on the local DB.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { createAgentConversation } from "../prisma/queries/agent-conversations";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Unique per-process suffix prevents cross-suite collisions when vitest
// runs files in parallel against the same dev Postgres.
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEST_USERS = {
	personalOnly: `test-doc-asst-rls-user-personal-${RUN_ID}`,
	orgMember: `test-doc-asst-rls-user-org-${RUN_ID}`,
};
const TEST_ORG = `test-doc-asst-rls-org-${RUN_ID}`;

const RLS_TEST_ROLE = process.env.RLS_TEST_ROLE;

describe.skipIf(!hasReachableDatabaseUrl())(
	"document_assistant_conversation RLS",
	() => {
		describe("policy structure (verifiable on any role)", () => {
			it("enables RLS and FORCE RLS on the table", async () => {
				const rows = await db.$queryRaw<
					Array<{
						tablename: string;
						rowsecurity: boolean;
						forcerowsecurity: boolean;
					}>
				>`
					SELECT t.tablename::text, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
					FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename
					WHERE t.tablename = 'document_assistant_conversation'
				`;
				expect(rows).toHaveLength(1);
				expect(rows[0].rowsecurity).toBe(true);
				expect(rows[0].forcerowsecurity).toBe(true);
			});

			it("installs the tenant_isolation policy with org/personal XOR clauses", async () => {
				const rows = await db.$queryRaw<
					Array<{
						policyname: string;
						qual: string;
						with_check: string;
					}>
				>`
					SELECT policyname::text, qual::text, with_check::text
					FROM pg_policies
					WHERE tablename = 'document_assistant_conversation' AND policyname = 'tenant_isolation'
				`;
				expect(rows).toHaveLength(1);
				// XOR floor: both branches present, neither leaks across.
				expect(rows[0].qual).toContain("'organization'");
				expect(rows[0].qual).toContain("'personal'");
				expect(rows[0].qual).toContain('"organizationId"');
				expect(rows[0].qual).toContain('"userId"');
				expect(rows[0].with_check).toContain("'organization'");
				expect(rows[0].with_check).toContain("'personal'");
			});
		});

		describe.skipIf(!RLS_TEST_ROLE)(
			"read isolation under a non-superuser role",
			() => {
				let personalProjectId: string;
				let orgProjectId: string;
				let personalRowId: string;
				let orgRowId: string;

				beforeAll(async () => {
					const now = new Date();
					await db.$executeRaw(Prisma.sql`
						INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
						VALUES (${TEST_USERS.personalOnly}, ${"Personal User"}, ${`${TEST_USERS.personalOnly}@test.com`}, true, false, ${now}, ${now})
						ON CONFLICT (id) DO NOTHING
					`);
					await db.$executeRaw(Prisma.sql`
						INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
						VALUES (${TEST_USERS.orgMember}, ${"Org Member"}, ${`${TEST_USERS.orgMember}@test.com`}, true, false, ${now}, ${now})
						ON CONFLICT (id) DO NOTHING
					`);
					await db.$executeRaw(Prisma.sql`
						INSERT INTO "organization" (id, name, slug, "createdAt")
						VALUES (${TEST_ORG}, ${"RLS Test Org"}, ${TEST_ORG}, ${now})
						ON CONFLICT (id) DO NOTHING
					`);
					await db.$executeRaw(Prisma.sql`
						INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
						VALUES (${`m-${TEST_ORG}-${TEST_USERS.orgMember}`}, ${TEST_ORG}, ${TEST_USERS.orgMember}, ${"member"}, ${now})
						ON CONFLICT DO NOTHING
					`);

					const personalProject = await db.project.create({
						data: {
							name: "RLS Personal",
							userId: TEST_USERS.personalOnly,
						},
					});
					personalProjectId = personalProject.id;

					const orgProject = await db.project.create({
						data: {
							name: "RLS Org",
							userId: TEST_USERS.orgMember,
							organizationId: TEST_ORG,
						},
					});
					orgProjectId = orgProject.id;

					const personalConv = await createAgentConversation({
						userId: TEST_USERS.personalOnly,
						agentId: "document_generator",
					});
					const orgConv = await createAgentConversation({
						userId: TEST_USERS.orgMember,
						organizationId: TEST_ORG,
						agentId: "document_generator",
					});

					const personalRow =
						await db.documentAssistantConversation.create({
							data: {
								conversationId: personalConv.id,
								documentRefKind: "PROJECT_DOCUMENT",
								documentRefId: "doc-personal",
								projectId: personalProjectId,
								organizationId: null,
								userId: TEST_USERS.personalOnly,
							},
						});
					personalRowId = personalRow.id;

					const orgRow =
						await db.documentAssistantConversation.create({
							data: {
								conversationId: orgConv.id,
								documentRefKind: "PROJECT_DOCUMENT",
								documentRefId: "doc-org",
								projectId: orgProjectId,
								organizationId: TEST_ORG,
								userId: TEST_USERS.orgMember,
							},
						});
					orgRowId = orgRow.id;
				});

				afterAll(async () => {
					await db.documentAssistantConversation.deleteMany({
						where: {
							userId: {
								in: [
									TEST_USERS.personalOnly,
									TEST_USERS.orgMember,
								],
							},
						},
					});
					await db.agentConversation.deleteMany({
						where: {
							userId: {
								in: [
									TEST_USERS.personalOnly,
									TEST_USERS.orgMember,
								],
							},
						},
					});
					await db.project.deleteMany({
						where: {
							id: { in: [personalProjectId, orgProjectId] },
						},
					});
					await db.member.deleteMany({
						where: { organizationId: TEST_ORG },
					});
					await db.organization.deleteMany({
						where: { id: TEST_ORG },
					});
					await db.user.deleteMany({
						where: { id: { in: Object.values(TEST_USERS) } },
					});
				});

				/**
				 * Run a probe query inside a transaction with
				 *   SET LOCAL ROLE <role>;
				 *   SELECT set_config('app.tenant_type', ...);
				 * so the test exercises the actual policy without leaking
				 * role state across tests.
				 */
				async function probe(
					tenant: "organization" | "personal" | "none",
					tenantId: string,
					userId: string,
					targetId: string,
				) {
					return db.$transaction(async (tx) => {
						await tx.$executeRawUnsafe(
							`SET LOCAL ROLE "${RLS_TEST_ROLE}"`,
						);
						await tx.$executeRaw(
							Prisma.sql`SELECT set_config('app.tenant_type', ${tenant}, true)`,
						);
						await tx.$executeRaw(
							Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
						);
						await tx.$executeRaw(
							Prisma.sql`SELECT set_config('app.user_id', ${userId}, true)`,
						);
						return tx.documentAssistantConversation.findUnique({
							where: { id: targetId },
						});
					});
				}

				it("blocks an org tenant from reading a personal row", async () => {
					const row = await probe(
						"organization",
						TEST_ORG,
						TEST_USERS.orgMember,
						personalRowId,
					);
					expect(row).toBeNull();
				});

				it("blocks a personal tenant from reading an org row", async () => {
					const row = await probe(
						"personal",
						TEST_USERS.personalOnly,
						TEST_USERS.personalOnly,
						orgRowId,
					);
					expect(row).toBeNull();
				});

				it("allows an org tenant to read its own row", async () => {
					const row = await probe(
						"organization",
						TEST_ORG,
						TEST_USERS.orgMember,
						orgRowId,
					);
					expect(row).not.toBeNull();
				});

				it("allows a personal tenant to read its own row", async () => {
					const row = await probe(
						"personal",
						TEST_USERS.personalOnly,
						TEST_USERS.personalOnly,
						personalRowId,
					);
					expect(row).not.toBeNull();
				});

				it("blocks reads with no tenant context", async () => {
					const row = await probe("none", "", "", personalRowId);
					expect(row).toBeNull();
				});
			},
		);
	},
);
