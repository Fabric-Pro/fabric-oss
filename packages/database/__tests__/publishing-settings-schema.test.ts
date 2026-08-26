import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index";

// REAL-DB integration test: the tenant-XOR CHECK constraint is a database-level
// guard that cannot be exercised without Postgres. Gated on RUN_DB_INTEGRATION
// like the sibling publishing-suite-*.test.ts files.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function seedProject(name: string) {
	const user = await db.user.create({
		data: {
			id: `pub-settings-${randomUUID()}`,
			name: "pub-settings",
			email: `pub-settings-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	const project = await db.project.create({
		data: {
			name,
			userId: user.id,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return { project, user };
}

it.skipIf(!RUN_DB)(
	"persists a personal-context settings row with the documented defaults",
	async () => {
		const { project, user } = await seedProject("settings-defaults");

		const row = await db.publishingSuiteSettings.create({
			data: {
				projectId: project.id,
				organizationId: null,
				userId: user.id,
				createdByUserId: user.id,
			},
		});

		expect(row.cadence).toBe("MANUAL");
		expect(row.lookbackDays).toBeNull();
		expect(row.notificationsEnabled).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"rejects a row carrying BOTH tenant ids (tenant-XOR CHECK)",
	async () => {
		const { project, user } = await seedProject("settings-xor-both");
		const org = await db.organization.create({
			data: {
				id: `pub-settings-org-${randomUUID()}`,
				name: "example-org",
				slug: `example-org-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(org.id);

		await expect(
			db.publishingSuiteSettings.create({
				data: {
					projectId: project.id,
					organizationId: org.id,
					userId: user.id,
					createdByUserId: user.id,
				},
			}),
		).rejects.toThrow(/publishing_suite_settings_tenant_xor/);
	},
);

it.skipIf(!RUN_DB)(
	"rejects a row carrying NEITHER tenant id (tenant-XOR CHECK)",
	async () => {
		const { project, user } = await seedProject("settings-xor-neither");

		await expect(
			db.publishingSuiteSettings.create({
				data: {
					projectId: project.id,
					organizationId: null,
					userId: null,
					createdByUserId: user.id,
				},
			}),
		).rejects.toThrow(/publishing_suite_settings_tenant_xor/);
	},
);

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}

	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
});
