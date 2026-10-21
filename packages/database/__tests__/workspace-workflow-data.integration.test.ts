import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { PrismaClient } from "../prisma/generated/client";
import { PageRecordVersionConflictError } from "../prisma/queries/frame-page-records";
import {
	WorkspaceWorkflowBindingConflictError,
	type WorkspaceWorkflowRunGuard,
} from "../prisma/queries/workflows/workspace-workflow-binding";
import {
	getWorkspaceWorkflowRecord,
	setWorkspaceWorkflowRecord,
} from "../prisma/queries/workflows/workspace-workflow-data";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const ids = {
	user: "workspace-data-owner",
	org: "workspace-data-org",
	project: "workspace-data-project",
	workflow: "workspace-data-workflow",
	frame: "workspace-data-frame",
};
const stamp = new Date("2026-01-01T12:00:00Z");
const fixtures = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});
const binding: WorkspaceWorkflowRunGuard = {
	userId: ids.user,
	organizationId: ids.org,
	projectId: ids.project,
	workflowId: ids.workflow,
	workspaceFrameId: ids.frame,
	workflowUpdatedAt: stamp,
	frameUpdatedAt: stamp,
	status: "PUBLISHED",
	requirement: { kind: "bound-run", workflowVersion: 2 },
};
const metadata = {
	surface: "workspace",
	workflowBindings: {
		version: 1,
		workflows: [
			{
				workflowId: ids.workflow,
				authorizedWorkflowVersion: 2,
				authorizedWorkflowUpdatedAt: stamp.toISOString(),
			},
		],
	},
};
const read = {
	binding,
	collection: "state",
	key: "baseline",
	scope: "shared" as const,
};
const write = { ...read, value: { unchanged: true }, expectedVersion: 0 };

function barrier() {
	let release = () => {};
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release: () => release() };
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Workspace workflow data (real Postgres)",
	() => {
		beforeAll(async () => {
			await fixtures.user.upsert({
				where: { id: ids.user },
				update: {},
				create: {
					id: ids.user,
					name: "Workspace owner",
					email: "workspace-data@example.com",
					emailVerified: true,
					createdAt: stamp,
					updatedAt: stamp,
				},
			});
			await fixtures.organization.upsert({
				where: { id: ids.org },
				update: {},
				create: {
					id: ids.org,
					name: "Workspace data organization",
					slug: ids.org,
					createdAt: stamp,
				},
			});
			await fixtures.project.upsert({
				where: { id: ids.project },
				update: {},
				create: {
					id: ids.project,
					name: "Workspace data project",
					userId: ids.user,
					organizationId: ids.org,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			await fixtures.workflow.upsert({
				where: { id: ids.workflow },
				update: {},
				create: {
					id: ids.workflow,
					name: "Workspace data workflow",
					userId: ids.user,
					organizationId: ids.org,
					projectId: ids.project,
					nodes: [],
					edges: [],
				},
			});
			await fixtures.agentWorkspaceFile.upsert({
				where: { id: ids.frame },
				update: {},
				create: {
					id: ids.frame,
					userId: ids.user,
					organizationId: ids.org,
					projectId: ids.project,
					path: "/frames/workspace-data.json",
					name: "Workspace data",
					content: "{}",
					size: 2,
					fileType: "FRAME",
					status: "COMPLETE",
				},
			});
		}, 60_000);

		beforeEach(async () => {
			await fixtures.framePageRecord.deleteMany({
				where: { frameId: ids.frame },
			});
			await fixtures.workflow.update({
				where: { id: ids.workflow },
				data: {
					status: "PUBLISHED",
					version: 2,
					publishedVersion: 2,
					updatedAt: stamp,
				},
			});
			await fixtures.agentWorkspaceFile.update({
				where: { id: ids.frame },
				data: { metadata, updatedAt: stamp },
			});
			await fixtures.project.update({
				where: { id: ids.project },
				data: { deletedAt: null },
			});
		});

		afterAll(async () => {
			await fixtures.agentWorkspaceFile.deleteMany({
				where: { id: ids.frame },
			});
			await fixtures.workflow.deleteMany({ where: { id: ids.workflow } });
			await fixtures.project.deleteMany({ where: { id: ids.project } });
			await fixtures.organization.deleteMany({ where: { id: ids.org } });
			await fixtures.user.deleteMany({ where: { id: ids.user } });
			await fixtures.$disconnect();
			await db.$disconnect();
		}, 60_000);

		it("reads and writes the existing shared and mine store with JSON null and version zero", async () => {
			expect(await getWorkspaceWorkflowRecord(read)).toBeNull();
			await setWorkspaceWorkflowRecord(write);
			await setWorkspaceWorkflowRecord({
				...write,
				scope: "mine",
				value: null,
			});
			expect(await getWorkspaceWorkflowRecord(read)).toMatchObject({
				value: write.value,
				version: 1,
				scope: "shared",
			});
			expect(
				await getWorkspaceWorkflowRecord({ ...read, scope: "mine" }),
			).toMatchObject({ value: null, version: 1, scope: "mine" });
		});

		it("allows one of two concurrent writes with the same expected version", async () => {
			const results = await Promise.allSettled([
				setWorkspaceWorkflowRecord(write),
				setWorkspaceWorkflowRecord({
					...write,
					value: { unchanged: false },
				}),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const rejected = results.find(
				(result) => result.status === "rejected",
			);
			expect(
				rejected?.status === "rejected" && rejected.reason,
			).toBeInstanceOf(PageRecordVersionConflictError);
			expect(await getWorkspaceWorkflowRecord(read)).toMatchObject({
				version: 1,
			});
		});

		it("refuses a repeated write after an unknown response without incrementing the record again", async () => {
			await setWorkspaceWorkflowRecord(write);
			await expect(
				setWorkspaceWorkflowRecord(write),
			).rejects.toBeInstanceOf(PageRecordVersionConflictError);
			expect(await getWorkspaceWorkflowRecord(read)).toMatchObject({
				version: 1,
				value: write.value,
			});
		});

		it("denies foreign owner, organization, project, and frame guards", async () => {
			for (const change of [
				{ userId: "foreign-owner" },
				{ organizationId: "foreign-org" },
				{ projectId: "foreign-project" },
				{ workspaceFrameId: "foreign-frame" },
			]) {
				await expect(
					setWorkspaceWorkflowRecord({
						...write,
						binding: { ...binding, ...change },
					}),
				).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
			}
			expect(
				await fixtures.framePageRecord.count({
					where: { frameId: ids.frame },
				}),
			).toBe(0);
		});

		it("rejects edited versions and workflow stamps rather than following the current graph", async () => {
			await fixtures.workflow.update({
				where: { id: ids.workflow },
				data: { version: 3, updatedAt: stamp },
			});
			await expect(
				setWorkspaceWorkflowRecord(write),
			).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
			await fixtures.workflow.update({
				where: { id: ids.workflow },
				data: {
					version: 2,
					updatedAt: new Date("2026-01-02T12:00:00Z"),
				},
			});
			await expect(
				getWorkspaceWorkflowRecord(read),
			).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
		});

		it("rejects revoked grants and restored or converted surfaces even with matching timestamps", async () => {
			for (const changed of [
				{ surface: "workspace" },
				{ ...metadata, surface: "artifact" },
				{
					...metadata,
					workflowBindings: { version: 1, workflows: [] },
				},
			]) {
				await fixtures.agentWorkspaceFile.update({
					where: { id: ids.frame },
					data: { metadata: changed, updatedAt: stamp },
				});
				await expect(
					setWorkspaceWorkflowRecord(write),
				).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
			}
		});

		it("rejects a project deleted after authorization", async () => {
			await fixtures.project.update({
				where: { id: ids.project },
				data: { deletedAt: new Date() },
			});
			await expect(
				setWorkspaceWorkflowRecord(write),
			).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
		});

		it("rechecks the grant after waiting for a concurrent revocation transaction", async () => {
			const locked = barrier();
			const release = barrier();
			const revocation = fixtures.$transaction(
				async (tx) => {
					await tx.$queryRaw`SELECT id FROM workflow WHERE id = ${ids.workflow} FOR SHARE`;
					await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id = ${ids.frame} FOR UPDATE`;
					locked.release();
					await release.ready;
					await tx.agentWorkspaceFile.update({
						where: { id: ids.frame },
						data: { metadata: { surface: "workspace" } },
					});
				},
				{ timeout: 10_000 },
			);
			await Promise.race([locked.ready, revocation]);
			const pending = expect(
				setWorkspaceWorkflowRecord(write),
			).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
			release.release();
			await revocation;
			await pending;
			expect(
				await fixtures.framePageRecord.count({
					where: { frameId: ids.frame },
				}),
			).toBe(0);
		});
	},
);
