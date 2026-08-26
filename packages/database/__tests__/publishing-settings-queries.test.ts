import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index";
import {
	getPublishingSuiteSettings,
	PublishingSettingsProjectNotFoundError,
	PublishingSettingsTenantMismatchError,
	upsertPublishingSuiteSettings,
} from "../prisma/queries/projects/publishing-settings";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function seedUser(prefix: string) {
	const user = await db.user.create({
		data: {
			id: `${prefix}-${randomUUID()}`,
			name: prefix,
			email: `${prefix}-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	return user;
}

async function seedProject(
	user: { id: string },
	overrides: { organizationId?: string } = {},
) {
	const project = await db.project.create({
		data: {
			name: "pub-settings-queries",
			userId: user.id,
			organizationId: overrides.organizationId ?? null,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return project;
}

async function seedOrg() {
	const org = await db.organization.create({
		data: {
			id: `pub-settings-org-${randomUUID()}`,
			name: "example-org",
			slug: `example-org-${randomUUID()}`,
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(org.id);
	return org;
}

it.skipIf(!RUN_DB)(
	"reading settings for a project with no row returns defaults and writes nothing",
	async () => {
		const user = await seedUser("pub-read-defaults");
		const project = await seedProject(user);

		const settings = await getPublishingSuiteSettings(project.id);

		expect(settings.cadence).toBe("MANUAL");
		expect(settings.lookbackDays).toBeNull();
		expect(settings.notificationsEnabled).toBe(true);
		// Chat is off for a project that has never configured it, and the synthetic
		// default has to SAY so — a missing key would leave the client reading
		// `undefined` and inventing its own answer, which is how the cadence
		// default drifted before this row learned to carry it.
		expect(settings.chatChannels).toBeNull();
		expect(settings.id).toBeNull();

		// Viewing must never create a row.
		const count = await db.publishingSuiteSettings.count({
			where: { projectId: project.id },
		});
		expect(count).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"stamps tenant columns from the PROJECT, XOR-normalized for an org project",
	async () => {
		const user = await seedUser("pub-org-stamp");
		const org = await seedOrg();
		const project = await seedProject(user, { organizationId: org.id });

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: org.id,
			createdByUserId: user.id,
			cadence: "MONTHLY",
		});

		const row = await db.publishingSuiteSettings.findUniqueOrThrow({
			where: { projectId: project.id },
		});
		expect(row.organizationId).toBe(org.id);
		// XOR: org context means userId is NULL, even though Project.userId is set.
		expect(row.userId).toBeNull();
		expect(row.cadence).toBe("MONTHLY");
	},
);

it.skipIf(!RUN_DB)("omitted fields are left unchanged on update", async () => {
	const user = await seedUser("pub-partial");
	const project = await seedProject(user);

	await upsertPublishingSuiteSettings({
		projectId: project.id,
		clientOrganizationId: null,
		createdByUserId: user.id,
		cadence: "BIWEEKLY",
		lookbackDays: 45,
	});
	await upsertPublishingSuiteSettings({
		projectId: project.id,
		clientOrganizationId: null,
		createdByUserId: user.id,
		notificationsEnabled: false,
	});

	const row = await db.publishingSuiteSettings.findUniqueOrThrow({
		where: { projectId: project.id },
	});
	expect(row.cadence).toBe("BIWEEKLY");
	expect(row.lookbackDays).toBe(45);
	expect(row.notificationsEnabled).toBe(false);
});

it.skipIf(!RUN_DB)(
	"null lookbackDays clears back to the engine default",
	async () => {
		const user = await seedUser("pub-clear-lookback");
		const project = await seedProject(user);

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			lookbackDays: 30,
		});
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			lookbackDays: null,
		});

		const row = await db.publishingSuiteSettings.findUniqueOrThrow({
			where: { projectId: project.id },
		});
		expect(row.lookbackDays).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"rejects a positively-wrong non-null client organizationId",
	async () => {
		const user = await seedUser("pub-wrong-org");
		const project = await seedProject(user); // personal context

		await expect(
			upsertPublishingSuiteSettings({
				projectId: project.id,
				clientOrganizationId: "some-other-org",
				createdByUserId: user.id,
				cadence: "WEEKLY",
			}),
		).rejects.toBeInstanceOf(PublishingSettingsTenantMismatchError);

		// The rejection must be a pure no-op, not "threw after writing" — a
		// future refactor that moved the throw past the upsert would still
		// pass if we only asserted the error type above.
		const count = await db.publishingSuiteSettings.count({
			where: { projectId: project.id },
		});
		expect(count).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"throws a typed error when the project is gone",
	async () => {
		const user = await seedUser("pub-missing-project");

		await expect(
			upsertPublishingSuiteSettings({
				projectId: "project-that-does-not-exist",
				clientOrganizationId: null,
				createdByUserId: user.id,
			}),
		).rejects.toBeInstanceOf(PublishingSettingsProjectNotFoundError);
	},
);

it.skipIf(!RUN_DB)(
	"two concurrent partial updates to DIFFERENT fields both survive, independent of the project lock",
	async () => {
		// This pins the conditional-spread payload construction in
		// upsertPublishingSuiteSettings: each call's `update` object only
		// contains the keys it was actually given, so Prisma compiles each
		// concurrent upsert to an `ON CONFLICT ("projectId") DO UPDATE SET`
		// touching a disjoint set of columns. Postgres's own per-statement row
		// locking already serializes those two statements and merges their
		// non-overlapping SET clauses correctly, so this case does not depend
		// on the `FOR UPDATE` lock on the project row — it would pass
		// identically with that lock deleted. It is still worth keeping: a
		// refactor that made the update write a full column set (dropping the
		// conditional spreads) would break it. What the project lock actually
		// guards is documented next to it in publishing-settings.ts, and has
		// no automated coverage.
		const user = await seedUser("pub-concurrent");
		const project = await seedProject(user);

		await Promise.all([
			upsertPublishingSuiteSettings({
				projectId: project.id,
				clientOrganizationId: null,
				createdByUserId: user.id,
				cadence: "MONTHLY",
			}),
			upsertPublishingSuiteSettings({
				projectId: project.id,
				clientOrganizationId: null,
				createdByUserId: user.id,
				notificationsEnabled: false,
			}),
		]);

		const row = await db.publishingSuiteSettings.findUniqueOrThrow({
			where: { projectId: project.id },
		});
		expect(row.cadence).toBe("MONTHLY");
		expect(row.notificationsEnabled).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"re-homes the tenant tuple to the NEW organization after a project transfer",
	async () => {
		const user = await seedUser("pub-transfer");
		const project = await seedProject(user); // personal context

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			cadence: "WEEKLY",
		});

		const beforeTransfer =
			await db.publishingSuiteSettings.findUniqueOrThrow({
				where: { projectId: project.id },
			});
		expect(beforeTransfer.organizationId).toBeNull();
		expect(beforeTransfer.userId).toBe(user.id);

		const org = await seedOrg();
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: org.id },
		});

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: org.id,
			createdByUserId: user.id,
			cadence: "MONTHLY",
		});

		// The public getter deliberately does not select the tenant columns —
		// read the row directly to prove the tuple MOVED, not merely that the
		// org id showed up alongside the stale userId (which would still trip
		// the tenant-XOR CHECK; both assertions below matter together).
		const afterTransfer =
			await db.publishingSuiteSettings.findUniqueOrThrow({
				where: { projectId: project.id },
			});
		expect(afterTransfer.organizationId).toBe(org.id);
		expect(afterTransfer.userId).toBeNull();
	},
);

// ---------------------------------------------------------------------------
// The chat broadcast target list (1C-3). Persisted on this same row, and the
// EMPTY list is the off switch — the design has no separate boolean, on the
// grounds that a second control could disagree with the selection.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"round-trips a chat broadcast target list through the upsert and the read",
	async () => {
		const user = await seedUser("pub-chat-roundtrip");
		const project = await seedProject(user);
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			chatChannels: [
				{
					platform: "SLACK",
					teamId: "T-example",
					channelId: "C-example",
					channelName: "release-notes",
				},
			],
		});
		const read = await getPublishingSuiteSettings(project.id);
		expect(read.chatChannels).toEqual([
			{
				platform: "SLACK",
				teamId: "T-example",
				channelId: "C-example",
				channelName: "release-notes",
			},
		]);
	},
);

it.skipIf(!RUN_DB)(
	"leaves an existing selection untouched when chatChannels is omitted",
	async () => {
		// The partial-update contract every other field on this row already has.
		// Without it, saving the cadence alone would silently turn chat off — a
		// destructive side effect of an unrelated control, and one no user action
		// would explain.
		const user = await seedUser("pub-chat-partial");
		const project = await seedProject(user);
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			chatChannels: [
				{
					platform: "TEAMS",
					teamId: "T-example",
					channelId: "C-example",
				},
			],
		});
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			cadence: "MONTHLY",
		});
		const read = await getPublishingSuiteSettings(project.id);
		expect(read.cadence).toBe("MONTHLY");
		expect(read.chatChannels).toEqual([
			{ platform: "TEAMS", teamId: "T-example", channelId: "C-example" },
		]);
	},
);

it.skipIf(!RUN_DB)(
	"turns chat off when the selection is saved empty",
	async () => {
		// EMPTY IS THE OFF SWITCH, and this is the case that pins it. The design has
		// no separate boolean, on the grounds that a second control could disagree
		// with the selection — so an empty array reaching the column is the whole
		// mechanism, and nothing else in the suite would notice if the writer coerced
		// it back to null-means-unchanged.
		const user = await seedUser("pub-chat-off");
		const project = await seedProject(user);
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			chatChannels: [
				{
					platform: "SLACK",
					teamId: "T-example",
					channelId: "C-example",
				},
			],
		});
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			chatChannels: [],
		});
		const read = await getPublishingSuiteSettings(project.id);
		expect(read.chatChannels).toEqual([]);
	},
);

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}

	await db.publishingSuiteSettings.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
});
