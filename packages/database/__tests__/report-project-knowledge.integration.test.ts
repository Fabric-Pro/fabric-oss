import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "../prisma/client";
import type { Prisma } from "../prisma/generated/client";
import {
	buildReportExecutionSnapshot,
	createTemplateInstance,
	createTemplateInstanceExecution,
	updateTemplateInstanceExecution,
} from "../prisma/queries/reports";
import { getReportProjectKnowledge } from "../prisma/queries/reports-project-knowledge";

const prefix = `example-report-${randomUUID()}`;
const org = `${prefix}-org`;
const otherOrg = `${prefix}-other-org`;
const user = `${prefix}-user`;
const otherUser = `${prefix}-other-user`;
const project = `${prefix}-project`;
const otherProject = `${prefix}-other-project`;
const templateId = `${prefix}-template`;
const skillId = `${prefix}-skill`;
let instanceId: string | undefined;
let executionId: string | undefined;
let validated = false;
const input = () => ({
	executionId: executionId ?? "",
	sourceId: "knowledge",
	userId: user,
	organizationId: org,
});

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"report Project knowledge against guarded local Postgres",
	() => {
		beforeAll(async () => {
			const url = new URL(process.env.DATABASE_URL ?? "");
			if (
				!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
				!/^\/example_[a-z0-9_]+$/.test(url.pathname) ||
				url.search
			) {
				throw new Error(
					"Only a guarded loopback example_* database may run this fixture",
				);
			}
			validated = true;
			for (const id of [org, otherOrg]) {
				await db.organization.create({
					data: {
						id,
						name: "Example report organization",
						slug: id,
						createdAt: new Date(),
					},
				});
			}
			for (const id of [user, otherUser]) {
				await db.user.create({
					data: {
						id,
						name: "Example report actor",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
			}
			for (const organizationId of [org, otherOrg]) {
				await db.member.create({
					data: {
						id: `${prefix}-${organizationId === org ? "member" : "other-member"}`,
						organizationId,
						userId: user,
						role: "owner",
						createdAt: new Date(),
					},
				});
			}
			for (const id of [project, otherProject]) {
				await db.project.create({
					data: {
						id,
						name: "Example report project",
						userId: user,
						organizationId: org,
						techStack: [],
						features: [],
						tags: [],
					},
				});
			}
			const old = new Date("2026-10-15T00:00:00Z");
			await db.projectDocument.create({
				data: {
					id: `${prefix}-document`,
					projectId: project,
					organizationId: org,
					userId: user,
					type: "PRD",
					title: "Shared generated delivery",
					content: "A completed project delivery milestone.",
					status: "COMPLETE",
					source: "GENERATED",
					version: 3,
					createdAt: old,
					updatedAt: old,
				},
			});
			await db.projectDocument.create({
				data: {
					id: `${prefix}-foreign-document`,
					projectId: otherProject,
					organizationId: org,
					userId: user,
					type: "PRD",
					title: "Other project",
					content: "FOREIGN_PROJECT_SECRET",
					status: "COMPLETE",
					source: "GENERATED",
					createdAt: old,
					updatedAt: old,
				},
			});
			await db.projectDocument.create({
				data: {
					id: `${prefix}-private-import`,
					projectId: project,
					organizationId: org,
					userId: user,
					type: "PRD",
					title: "Unattested private import",
					content: "PRIVATE_IMPORTED_SECRET",
					status: "COMPLETE",
					source: "EXTERNAL",
					createdAt: old,
					updatedAt: old,
				},
			});
			await db.projectDocument.create({
				data: {
					id: `${prefix}-future-document`,
					projectId: project,
					organizationId: org,
					userId: user,
					type: "PRD",
					title: "Changed after cutoff",
					content: "FUTURE_REVISION_SECRET",
					status: "COMPLETE",
					source: "GENERATED",
					createdAt: old,
					updatedAt: new Date("2026-11-02T00:00:00Z"),
				},
			});
			for (const [suffix, type, content, metadata, excluded] of [
				[
					"shared-text",
					"TEXT",
					`Shared project notes. ${"x".repeat(7000)}TAIL_MARKER`,
					{},
					false,
				],
				[
					"private-text",
					"TEXT",
					"PRIVATE_CONTEXT_SECRET",
					{ visibility: "PRIVATE" },
					false,
				],
				["store-only", "TEXT", "STORE_ONLY_SECRET", {}, true],
				[
					"private-memory",
					"CODE_FILE",
					"ACTOR_MEMORY_SECRET",
					{},
					false,
				],
				[
					"private-integration",
					"INTEGRATION",
					"PRIVATE_CONVERSATION_SECRET",
					{},
					false,
				],
			] as const) {
				await db.projectContext.create({
					data: {
						id: `${prefix}-${suffix}`,
						projectId: project,
						organizationId: org,
						userId: user,
						type,
						content,
						metadata,
						indexingExcluded: excluded,
						extractionStatus: "COMPLETED",
						createdAt: old,
						updatedAt: old,
					},
				});
			}
			const definition = {
				dataSources: [
					{
						id: "knowledge",
						type: "fabric",
						provider: "fabric_project",
						operation: "project_knowledge",
					},
				],
				sections: [],
			};
			await db.reportTemplate.create({
				data: {
					id: templateId,
					name: "Example project knowledge report",
					templateType: "CUSTOM",
					definition,
					scope: "ORGANIZATION",
					organizationId: org,
					userId: user,
				},
			});
			await db.skill.create({
				data: {
					id: skillId,
					slug: skillId,
					name: "Example pinned skill",
					description: "Synthetic report instructions",
					content: "PINNED_SKILL_TEXT",
					scope: "ORGANIZATION",
					organizationId: org,
					userId: user,
					isPublished: true,
					version: 1,
				},
			});
			await db.reportTemplateSkill.create({
				data: { templateId, skillId },
			});
			const instance = await createTemplateInstance({
				templateId,
				userId: user,
				organizationId: org,
				name: "Example monthly delivery",
				connections: {},
				fabricConfig: {
					reporting: {
						version: 1,
						period: "monthly",
						projectId: project,
					},
				},
			});
			instanceId = instance.id;
			expect(instance.isActive).toBe(true);
			const snapshot = await buildReportExecutionSnapshot({
				instance,
				userId: user,
				organizationId: org,
				occurrenceAt: new Date("2026-11-02T09:00:00Z"),
				origin: "manual",
			});
			const parameters: Prisma.InputJsonObject = z
				.record(z.string(), z.json())
				.parse(
					JSON.parse(
						JSON.stringify({
							__fabricReportExecution: snapshot,
							projectId: otherProject,
						}),
					),
				);
			const execution = await createTemplateInstanceExecution({
				instanceId,
				userId: user,
				organizationId: org,
				parameters,
				workflowId: `${prefix}-workflow`,
				runId: `${prefix}-run`,
			});
			executionId = execution.id;
			await updateTemplateInstanceExecution({
				id: execution.id,
				status: "RUNNING",
			});
			await db.skill.update({
				where: { id: skillId },
				data: { content: "CURRENT_MUTATED_SKILL", version: 2 },
			});
			await db.reportTemplateSkill.deleteMany({
				where: { templateId, skillId },
			});
		});
		afterAll(async () => {
			if (!validated) {
				return;
			}
			if (executionId) {
				await db.templateInstanceExecution.deleteMany({
					where: {
						id: executionId,
						userId: user,
						organizationId: org,
					},
				});
			}
			if (instanceId) {
				await db.templateInstance.deleteMany({
					where: {
						id: instanceId,
						userId: user,
						organizationId: org,
					},
				});
			}
			await db.skill.deleteMany({
				where: { id: skillId, organizationId: org },
			});
			await db.reportTemplate.deleteMany({
				where: { id: templateId, organizationId: org },
			});
			await db.project.deleteMany({
				where: {
					id: { in: [project, otherProject] },
					organizationId: org,
				},
			});
			await db.organization.deleteMany({
				where: { id: { in: [org, otherOrg] } },
			});
			await db.user.deleteMany({
				where: { id: { in: [user, otherUser] } },
			});
		});
		it("reads only generated shared documents and shared ready text, with revision/cutoff/body bounds", async () => {
			const result = await getReportProjectKnowledge(input());
			expect(result.records.map((record) => record.id).sort()).toEqual(
				[`${prefix}-document`, `${prefix}-shared-text`].sort(),
			);
			const serialized = JSON.stringify(result);
			for (const forbidden of [
				"FOREIGN_PROJECT_SECRET",
				"PRIVATE_IMPORTED_SECRET",
				"FUTURE_REVISION_SECRET",
				"PRIVATE_CONTEXT_SECRET",
				"STORE_ONLY_SECRET",
				"ACTOR_MEMORY_SECRET",
				"PRIVATE_CONVERSATION_SECRET",
				"TAIL_MARKER",
			]) {
				expect(serialized).not.toContain(forbidden);
			}
			expect(
				result.records.find((record) => record.kind === "document")
					?.revision,
			).toBe("3");
			expect(
				result.records.find((record) => record.kind === "context")
					?.content.length,
			).toBe(6000);
			expect(
				result.records.find((record) => record.kind === "context")
					?.truncated,
			).toBe(true);
		});
		it("retains effective skill content/version after the live skill changes and detaches", async () => {
			const execution =
				await db.templateInstanceExecution.findUniqueOrThrow({
					where: { id: executionId },
					select: { parameters: true },
				});
			const params = z
				.record(z.string(), z.json())
				.parse(execution.parameters);
			const pinned = z
				.object({
					skills: z.array(
						z.object({ content: z.string(), version: z.number() }),
					),
				})
				.parse(params.__fabricReportExecution);
			expect(pinned.skills).toEqual([
				expect.objectContaining({
					content: "PINNED_SKILL_TEXT",
					version: 1,
				}),
			]);
		});
		it("denies a same-user foreign organization and membership revoked after admission", async () => {
			await expect(
				getReportProjectKnowledge({
					...input(),
					organizationId: otherOrg,
				}),
			).rejects.toThrow("denied");
			await db.member.deleteMany({
				where: { organizationId: org, userId: user },
			});
			await expect(getReportProjectKnowledge(input())).rejects.toThrow(
				"denied",
			);
		});
	},
);
