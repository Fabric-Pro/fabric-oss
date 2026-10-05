import { randomUUID } from "node:crypto";
import { encryptApiKey } from "@repo/utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider,
} from "../prisma/queries/workflows/credential-fetcher";
import { listWorkflowIntegrationsInTenant } from "../prisma/queries/workflows/integrations";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const prefix = `integration-scope-${randomUUID()}`;
const actor = `${prefix}-actor`;
const owner = `${prefix}-owner`;
const org = `${prefix}-org`;
const foreignOrg = `${prefix}-foreign`;
const privateId = `${prefix}-private`;
const sharedId = `${prefix}-shared`;
const foreignId = `${prefix}-foreign-grant`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"connection scope on real Postgres",
	() => {
		beforeAll(async () => {
			for (const id of [actor, owner]) {
				await db.user.create({
					data: {
						id,
						name: "Example",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
			}
			for (const id of [org, foreignOrg]) {
				await db.organization.create({
					data: {
						id,
						name: "Example organization",
						slug: id,
						createdAt: new Date(),
					},
				});
			}
			await db.member.createMany({
				data: [actor, owner].map((userId) => ({
					userId,
					organizationId: org,
					role: "member",
					createdAt: new Date(),
				})),
			});
			await db.workflowIntegration.createMany({
				data: [
					{
						id: privateId,
						userId: owner,
						organizationId: org,
						provider: "NHTSA_VPIC",
						name: "Example private",
						credentials: encryptApiKey("{}"),
					},
					{
						id: sharedId,
						userId: owner,
						organizationId: org,
						provider: "NHTSA_VPIC",
						name: "Example shared",
						credentials: encryptApiKey("{}"),
						usageScope: "ORGANIZATION_SHARED",
					},
					{
						id: foreignId,
						userId: owner,
						organizationId: foreignOrg,
						provider: "NHTSA_VPIC",
						name: "Example foreign",
						credentials: encryptApiKey("{}"),
						usageScope: "ORGANIZATION_SHARED",
					},
				],
			});
		});
		afterAll(async () => {
			await db.workflowIntegration.deleteMany({
				where: { id: { in: [privateId, sharedId, foreignId] } },
			});
			await db.organization.deleteMany({
				where: { id: { in: [org, foreignOrg] } },
			});
			await db.user.deleteMany({ where: { id: { in: [actor, owner] } } });
			await db.$disconnect();
		});
		it("defaults historical-style inserts to private and enforces own/shared access", async () => {
			expect(
				(
					await db.workflowIntegration.findUniqueOrThrow({
						where: { id: privateId },
					})
				).usageScope,
			).toBe("OWNER_ONLY");
			expect(
				await fetchCredentialsByIdAndProviderInTenant(
					privateId,
					"NHTSA_VPIC",
					actor,
					org,
				),
			).toBeNull();
			expect(
				await fetchCredentialsByIdAndProviderInTenant(
					privateId,
					"NHTSA_VPIC",
					owner,
					org,
				),
			).toEqual({ NHTSA_ENABLED: "true" });
			expect(
				await fetchCredentialsByIdAndProviderInTenant(
					sharedId,
					"NHTSA_VPIC",
					actor,
					org,
				),
			).toEqual({ NHTSA_ENABLED: "true" });
			expect(
				await fetchCredentialsByIdAndProviderInTenant(
					foreignId,
					"NHTSA_VPIC",
					actor,
					org,
				),
			).toBeNull();
			expect(
				(
					await listWorkflowIntegrationsInTenant({
						userId: actor,
						organizationId: org,
					})
				).map((row) => row.id),
			).toEqual([sharedId]);
		});
		it("denies the next access after sharing or membership is revoked", async () => {
			await db.workflowIntegration.update({
				where: { id: sharedId },
				data: { usageScope: "OWNER_ONLY" },
			});
			expect(
				await fetchCredentialsByProvider("NHTSA_VPIC", actor, org),
			).toBeNull();
			await db.member.delete({
				where: {
					organizationId_userId: {
						organizationId: org,
						userId: owner,
					},
				},
			});
			expect(
				await fetchCredentialsByIdAndProviderInTenant(
					privateId,
					"NHTSA_VPIC",
					owner,
					org,
				),
			).toBeNull();
		});
	},
);
