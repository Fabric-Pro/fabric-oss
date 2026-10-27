import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { recordAiOutcome } from "../prisma/queries/ai-outcomes";
import {
	getAiOutputProvenance,
	recordAiOutputProvenance,
} from "../prisma/queries/ai-output-provenance";
import { asRlsRole, ensureRlsTestRole } from "./_helpers/rls-role";

const enabled = process.env.RUN_DB_INTEGRATION === "1";
const suffix = `${Date.now()}-${process.pid}`;
const organizationId = `example-provenance-org-${suffix}`;
const otherOrg = `example-provenance-other-org-${suffix}`;
const userId = `example-provenance-user-${suffix}`;
const otherUser = `example-provenance-other-user-${suffix}`;
const subject = {
	organizationId,
	userId,
	subjectType: "copilot-message",
	subjectId: `msg_1793000000000_${suffix}`,
};

describe.skipIf(!enabled)("AI output provenance database and RLS", () => {
	let validatedTarget = false;
	beforeAll(async () => {
		const url = new URL(process.env.DATABASE_URL ?? "");
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			!/^\/example_[a-z0-9_]+$/.test(url.pathname) ||
			url.search
		) {
			throw new Error(
				"Use a loopback example_* disposable database without URL parameters",
			);
		}
		validatedTarget = true;
		await ensureRlsTestRole();
		for (const id of [organizationId, otherOrg]) {
			await db.organization.create({
				data: {
					id,
					name: "Example provenance",
					slug: id,
					createdAt: new Date(),
				},
			});
		}
		for (const id of [userId, otherUser]) {
			await db.user.create({
				data: {
					id,
					name: "Example user",
					email: `${id}@example.com`,
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
		}
		await recordAiOutputProvenance({
			...subject,
			modelCanonicalName: "example-initial-model",
		});
	});
	afterAll(async () => {
		if (!validatedTarget) {
			return;
		}
		await db.organization.deleteMany({
			where: { id: { in: [organizationId, otherOrg] } },
		});
		await db.user.deleteMany({
			where: { id: { in: [userId, otherUser] } },
		});
		await db.$disconnect();
	});
	it("updates the same row to the final call's model and keeps chat prompt null", async () => {
		await recordAiOutputProvenance({
			...subject,
			modelCanonicalName: "example-final-model",
			agentId: "project_document_generator:truncation_retry",
		});
		expect(await db.aiOutputProvenance.count({ where: subject })).toBe(1);
		expect(await getAiOutputProvenance(subject)).toEqual({
			projectId: null,
			modelCanonicalName: "example-final-model",
			promptVersionId: null,
		});
	});
	it("does not return another user's or organization's row", async () => {
		expect(
			await getAiOutputProvenance({ ...subject, userId: otherUser }),
		).toBeNull();
		expect(
			await getAiOutputProvenance({
				...subject,
				organizationId: otherOrg,
			}),
		).toBeNull();
	});
	it("keeps the stored model when a later rating has no provenance", async () => {
		const verdict = { ...subject, featureKey: "document-generation" };
		await recordAiOutcome({
			...verdict,
			outcome: "RATED_UP",
			modelCanonicalName: "example-final-model",
			promptVersionId: "example-prompt",
		});
		await recordAiOutcome({
			...verdict,
			outcome: "RATED_DOWN",
			modelCanonicalName: null,
			promptVersionId: null,
		});
		expect(
			await db.aiOutcomeEvent.findFirst({ where: verdict }),
		).toMatchObject({
			outcome: "RATED_DOWN",
			modelCanonicalName: "example-final-model",
			promptVersionId: "example-prompt",
		});
	});
	it("enables and forces RLS", async () => {
		const rows = await db.$queryRaw<
			{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]
		>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'ai_output_provenance'::regclass`;
		expect(rows).toEqual([
			{ relrowsecurity: true, relforcerowsecurity: true },
		]);
	});
	it("lets a restricted role read only its organization's rows", async () => {
		const own = await asRlsRole(
			{ type: "organization", tenantId: organizationId, userId },
			(tx) =>
				tx.aiOutputProvenance.findMany({
					where: { subjectId: subject.subjectId },
				}),
		);
		expect(own).toHaveLength(1);
		const foreign = await asRlsRole(
			{ type: "organization", tenantId: otherOrg, userId },
			(tx) =>
				tx.aiOutputProvenance.findMany({
					where: { subjectId: subject.subjectId },
				}),
		);
		expect(foreign).toEqual([]);
	});
	it("rejects a write into another organization under a restricted role", async () => {
		await expect(
			asRlsRole(
				{ type: "organization", tenantId: otherOrg, userId },
				(tx) =>
					tx.aiOutputProvenance.create({
						data: {
							...subject,
							subjectId: "example-forbidden-output",
						},
					}),
			),
		).rejects.toThrow(/row.level security/i);
	});
});
