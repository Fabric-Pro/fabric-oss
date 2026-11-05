/**
 * Every role against the report tenant checker, the project the report surface
 * reads and the organization-wide project list, over real rows: membership,
 * project rows and the platform role all decide in the database, and no second
 * identity exists on a shared environment to prove them live. `execute` asks about
 * a report the identity owns, since nobody runs anyone else's. The API's rules on
 * top of these are `packages/api/modules/reports/lib/__tests__/report-role-matrix.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	canExecuteReportInstance,
	createReportAccessChecker,
	getReportAdminProjectOrganization,
} from "../prisma/queries/lib/report-access";
import {
	getProjectById,
	getProjectForReportsOnly,
	listOrganizationProjectsForReports,
	listProjects,
} from "../prisma/queries/projects/projects";

const prefix = `example-report-roles-${randomUUID()}`;
const org = `${prefix}-org`;
const foreignOrg = `${prefix}-foreign-org`;
const project = `${prefix}-project`;
const draftProject = `${prefix}-draft-project`;
const trashedProject = `${prefix}-trashed-project`;
const foreignProject = `${prefix}-foreign-project`;
const creator = `${prefix}-creator`;

type Identity = {
	key: string;
	label: string;
	platformRole?: string;
	orgRole?: string;
	foreignOrgRole?: string;
	projectRole?: "EDITOR" | "VIEWER";
	read: boolean;
	write: boolean;
	execute: boolean;
	administers: boolean;
};

const IDENTITIES: Identity[] = [
	{
		key: "viewer",
		label: "organization Viewer",
		orgRole: "viewer",
		read: false,
		write: false,
		execute: false,
		administers: false,
	},
	{
		key: "viewer-editor",
		label: "organization Viewer with an Editor project row",
		orgRole: "viewer",
		projectRole: "EDITOR",
		read: true,
		write: true,
		execute: false,
		administers: false,
	},
	{
		key: "member",
		label: "organization Member with no project row",
		orgRole: "member",
		read: false,
		write: false,
		execute: false,
		administers: false,
	},
	{
		key: "member-viewer",
		label: "organization Member with a Viewer project row",
		orgRole: "member",
		projectRole: "VIEWER",
		read: true,
		write: false,
		execute: false,
		administers: false,
	},
	{
		key: "member-editor",
		label: "organization Member with an Editor project row",
		orgRole: "member",
		projectRole: "EDITOR",
		read: true,
		write: true,
		execute: true,
		administers: false,
	},
	{
		key: "admin",
		label: "organization Admin with no project row",
		orgRole: "admin",
		read: true,
		write: true,
		execute: true,
		administers: true,
	},
	{
		key: "owner",
		label: "organization Owner with no project row",
		orgRole: "owner",
		read: true,
		write: true,
		execute: true,
		administers: true,
	},
	{
		key: "guest",
		label: "project guest who is no organization member",
		projectRole: "EDITOR",
		read: false,
		write: false,
		execute: false,
		administers: false,
	},
	{
		key: "system-member",
		label: "system admin who is a member",
		platformRole: "admin",
		orgRole: "viewer",
		read: true,
		write: true,
		execute: true,
		administers: true,
	},
	{
		key: "system-non-member",
		label: "system admin who is no member",
		platformRole: "admin",
		read: false,
		write: false,
		execute: false,
		administers: false,
	},
	{
		key: "foreign",
		label: "admin of a foreign organization",
		foreignOrgRole: "admin",
		read: false,
		write: false,
		execute: false,
		administers: false,
	},
];

const userId = (key: string) => `${prefix}-${key}`;
const userIds = () => [creator, ...IDENTITIES.map(({ key }) => userId(key))];
const report = {
	userId: creator,
	organizationId: org,
	projectId: project,
	fabricConfig: null,
};

let validated = false;
let priorOperatorOrganization: string | undefined;

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"report roles against guarded local Postgres",
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
			priorOperatorOrganization = process.env.OPERATOR_ORGANIZATION_ID;
			delete process.env.OPERATOR_ORGANIZATION_ID;

			for (const id of [org, foreignOrg]) {
				await db.organization.create({
					data: {
						id,
						name: "Example roles organization",
						slug: id,
						createdAt: new Date(),
					},
				});
			}
			await db.user.create({
				data: {
					id: creator,
					name: "Example project creator",
					email: `${creator}@example.com`,
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await db.member.create({
				data: {
					id: `${creator}-member`,
					organizationId: org,
					userId: creator,
					role: "member",
					createdAt: new Date(),
				},
			});
			for (const [id, organizationId, status, deletedAt] of [
				[project, org, "ACTIVE", null],
				[draftProject, org, "DRAFT", null],
				[trashedProject, org, "ACTIVE", new Date()],
				[foreignProject, foreignOrg, "ACTIVE", null],
			] as const) {
				await db.project.create({
					data: {
						id,
						name: "Example roles project",
						userId: creator,
						organizationId,
						status,
						deletedAt,
						techStack: [],
						features: [],
						tags: [],
					},
				});
			}
			await db.projectDocument.create({
				data: {
					id: `${prefix}-document`,
					projectId: project,
					organizationId: org,
					userId: creator,
					type: "PRD",
					title: "A document for the project's members",
					content: "Example content",
					status: "COMPLETE",
					source: "GENERATED",
				},
			});
			for (const identity of IDENTITIES) {
				const id = userId(identity.key);
				await db.user.create({
					data: {
						id,
						name: "Example roles actor",
						email: `${id}@example.com`,
						emailVerified: true,
						role: identity.platformRole ?? "user",
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
				for (const [organizationId, role] of [
					[org, identity.orgRole],
					[foreignOrg, identity.foreignOrgRole],
				] as const) {
					if (role) {
						await db.member.create({
							data: {
								id: `${id}-${organizationId}`,
								organizationId,
								userId: id,
								role,
								createdAt: new Date(),
							},
						});
					}
				}
				if (identity.projectRole) {
					await db.projectMember.create({
						data: {
							projectId: project,
							userId: id,
							role: identity.projectRole,
							invitedBy: creator,
							acceptedAt: new Date(),
						},
					});
				}
			}
		});

		afterAll(async () => {
			if (priorOperatorOrganization !== undefined) {
				process.env.OPERATOR_ORGANIZATION_ID =
					priorOperatorOrganization;
			}
			if (!validated) {
				return;
			}
			await db.projectDocument.deleteMany({
				where: { id: `${prefix}-document` },
			});
			await db.project.deleteMany({
				where: {
					id: {
						in: [
							project,
							draftProject,
							trashedProject,
							foreignProject,
						],
					},
				},
			});
			await db.organization.deleteMany({
				where: { id: { in: [org, foreignOrg] } },
			});
			await db.user.deleteMany({ where: { id: { in: userIds() } } });
		});

		it.each(IDENTITIES)(
			"$label: read $read, write $write, execute $execute, administers $administers",
			async ({ key, read, write, execute, administers }) => {
				const caller = { userId: userId(key), organizationId: org };

				const mayRead = await createReportAccessChecker(caller);
				const mayWrite = await createReportAccessChecker(caller, true);

				expect(await mayRead(report)).toBe(read);
				expect(await mayWrite(report)).toBe(write);
				expect(
					await canExecuteReportInstance(
						{ ...report, userId: userId(key) },
						caller,
					),
				).toBe(execute);
				expect(
					await getReportAdminProjectOrganization(
						project,
						userId(key),
					),
				).toEqual(administers ? { organizationId: org } : null);
			},
		);

		it("runs a report for nobody but its owner, an organization admin included", async () => {
			for (const { key } of IDENTITIES) {
				expect(
					await canExecuteReportInstance(report, {
						userId: userId(key),
						organizationId: org,
					}),
				).toBe(false);
			}
		});

		it("gives the report surface the project's fields and nothing the project's members alone read", async () => {
			const shell = await getProjectForReportsOnly(project, org);

			expect(shell?.id).toBe(project);
			expect(shell?.name).toBe("Example roles project");
			for (const field of [
				"documents",
				"contexts",
				"_count",
				"goals",
				"targetAudience",
				"attachmentRetentionDays",
			]) {
				expect(shell).not.toHaveProperty(field);
			}
		});

		it("leaves the project's own read closed to an admin with no row, for every other page", async () => {
			expect(
				await getProjectById(project, userId("admin"), org),
			).toBeNull();
			expect(
				(await getProjectById(project, creator, org))?.documents,
			).toHaveLength(1);
		});

		it("refuses a trashed project and another organization's", async () => {
			expect(
				await getProjectForReportsOnly(trashedProject, org),
			).toBeNull();
			expect(
				await getProjectForReportsOnly(foreignProject, org),
			).toBeNull();
			expect(
				await getReportAdminProjectOrganization(
					trashedProject,
					userId("admin"),
				),
			).toBeNull();
			expect(
				await getReportAdminProjectOrganization(
					foreignProject,
					userId("admin"),
				),
			).toBeNull();
		});

		it("lists the organization's live projects for the report surface, without drafts, the trash or another organization's, and a card's fields only", async () => {
			const { projects, total } =
				await listOrganizationProjectsForReports({
					userId: userId("admin"),
					organizationId: org,
					limit: 50,
					offset: 0,
				});

			expect(projects.map(({ id }) => id)).toEqual([project]);
			expect(total).toBe(1);
			expect(projects[0].members).toEqual([]);
			expect(projects[0]).not.toHaveProperty("activePmSync");
			expect(projects[0]).not.toHaveProperty("goals");
		});

		it("keeps the project list to the caller's own projects", async () => {
			const { projects } = await listProjects({
				userId: userId("admin"),
				organizationId: org,
				includeDraft: true,
				limit: 50,
			});

			expect(projects).toEqual([]);
		});
	},
);
