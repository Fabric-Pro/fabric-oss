import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "../index";
import * as membersModule from "../prisma/queries/projects/members";
import {
	countPublishingCycleRecipients,
	countPublishingCycles,
	createManualPublishingTopic,
	getLatestPublishingCycle,
	listPublishingCycles,
	listPublishingTopics,
	type PublishingCycleStatusFilter,
	PublishingTopicProjectNotFoundError,
	PublishingTopicTenantMismatchError,
	resolveProjectTenant,
	setPublishingTopicReadState,
	setPublishingTopicSnooze,
	updatePublishingTopicPostTypes,
	updatePublishingTopicStatus,
} from "../prisma/queries/projects/publishing-suite";
import {
	computeDedupeKey,
	computeSubjectKey,
} from "../src/publishing-suite-schema";

// REAL-DB integration test: Task 1 (Plan 3 "Surface") topic + cycle query helpers —
// listPublishingTopics, createManualPublishingTopic, updatePublishingTopicStatus's
// project-scoped guard, getLatestPublishingCycle, and resolveProjectTenant's H1
// XOR-tenant-tuple normalization — all depend on real Postgres unique-constraint (the
// (projectId, dedupeKey) index) and read-after-write semantics that cannot be faithfully
// mocked. Gated on RUN_DB_INTEGRATION like the sibling publishing-suite-*.test.ts files
// (createorget/persist/costguard), so the no-Postgres unit run SKIPS it; it runs only in
// the db-integration CI job.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

// The 1B role-aware 3-tier ranking tests below (and the "untagged viewer"
// 2-tier collapse case) depend on `listPublishingTopics`'s viewer-tag read,
// which is now gated behind `isFunctionTagsEnabled()` (Copilot review, #1767
// flag) — force it ON for this whole file so the real-PG read actually runs,
// matching the pre-gate behavior these cases assert on. Restore whatever was
// there before so this file never leaks the flag into other test files.
const priorFunctionTagsFlag = process.env.FABRIC_FEATURE_FUNCTION_TAGS;
beforeAll(() => {
	process.env.FABRIC_FEATURE_FUNCTION_TAGS = "true";
});

// A dedicated user per fixture (not db.user.findFirstOrThrow()) — the db-integration CI
// job runs against a fresh, unseeded Postgres, and sibling suites delete their own fixture
// rows in afterAll, so relying on "some other row exists" is order-dependent and can 404 in
// CI. User has no defaults on name/email/emailVerified/createdAt/updatedAt (schema.prisma).
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
			name: "pub-queries",
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

// getProjectMembers returns members with acceptedAt != null. `invitedBy` is a
// required plain string (NO FK relation in the schema) — unused by matching.
async function seedMember(project: { id: string }, user: { id: string }) {
	await db.projectMember.create({
		data: {
			projectId: project.id,
			userId: user.id,
			role: "VIEWER",
			invitedBy: user.id,
			invitedAt: new Date(),
			acceptedAt: new Date(),
		},
	});
}

async function seedTranscript(project: { id: string }, speakerNames: string[]) {
	const meeting = await db.projectLinkedMeeting.create({
		data: {
			projectId: project.id,
			joinUrl: `https://teams.local/${randomUUID()}`,
		},
	});
	const transcript = await db.projectMeetingTranscript.create({
		data: {
			projectId: project.id,
			linkedMeetingId: meeting.id,
			meetingId: `meeting-${randomUUID()}`,
			transcriptId: `transcript-${randomUUID()}`,
			keywords: [], // required String[], no schema default (like seedProject's arrays)
			speakerNames,
		},
	});
	return transcript;
}

async function seedMeetingTopic(
	project: { id: string },
	user: { id: string },
	title: string,
	transcriptIds: string[],
) {
	return db.publishingTopic.create({
		data: {
			projectId: project.id,
			userId: user.id,
			title,
			status: "SUGGESTION",
			origin: "AI",
			dedupeKey: computeDedupeKey(project.id, title),
			provenance: { transcriptIds },
		},
	});
}

it.skipIf(!RUN_DB)(
	"listPublishingTopics returns the project's topics",
	async () => {
		const user = await seedUser("pub-q-list");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id, // personal context; organizationId stays NULL (tenant XOR)
				title: "AI-suggested topic",
				pitch: "why it matters",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "AI-suggested topic"),
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});

		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe(topic.id);
		expect(items[0]?.title).toBe("AI-suggested topic");
		expect(items[0]?.status).toBe("SUGGESTION");
		expect(items[0]?.origin).toBe("AI");
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B: resolves contributor handles and drops non-existent users (DV-7/DV-8)",
	async () => {
		const user = await seedUser("pub-q-list-contrib");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Topic with a deleted contributor",
				pitch: "why it matters",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"Topic with a deleted contributor",
				),
				contributorUserIds: [user.id, `deleted-${randomUUID()}`],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});

		const t = items.find((i) => i.id === topic.id);
		expect(t?.contributors.map((c) => c.id)).toEqual([user.id]);
		expect(t?.contributors[0]?.name).toBe(user.name);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B: returns suggestedPostTypes on the item",
	async () => {
		const user = await seedUser("pub-q-list-posttypes");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Topic with post types",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"Topic with post types",
				),
				suggestedPostTypes: ["BLOG_POST"],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});

		expect(
			items.find((i) => i.id === topic.id)?.suggestedPostTypes,
		).toEqual(["BLOG_POST"]);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B: ranks the viewer's contributed-to topics above the rest, recency within tier",
	async () => {
		const viewer = await seedUser("pub-q-list-viewer");
		const other = await seedUser("pub-q-list-other");
		const project = await seedProject(viewer);

		// T1 (older, viewer is contributor)
		const t1 = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "T1 viewer-contributed, older",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"T1 viewer-contributed, older",
				),
				contributorUserIds: [viewer.id],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt ordering

		// T2 (newer than T1, NOT the viewer)
		const t2 = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "T2 not-viewer, newer",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "T2 not-viewer, newer"),
				contributorUserIds: [other.id],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		// T3 (newest, viewer is contributor)
		const t3 = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "T3 viewer-contributed, newest",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"T3 viewer-contributed, newest",
				),
				contributorUserIds: [viewer.id],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: viewer.id,
		});

		expect(items.map((i) => i.id)).toEqual([t3.id, t1.id, t2.id]);

		// AC3: ranking keys on `viewerUserId`, not a fixed/precomputed order.
		// Calling again as `other` — who contributed only to T2 — must flip the
		// tiering: T2 (other's tier) first, then T3/T1 (recency order) in the
		// "rest" tier.
		const asOther = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: other.id,
		});
		expect(asOther.items.map((i) => i.id)).toEqual([t2.id, t3.id, t1.id]);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B: post types never affect ranking order — only createdAt/contribution do (AC7)",
	async () => {
		const viewer = await seedUser("pub-q-list-posttypes-rank");
		const project = await seedProject(viewer);

		// Same viewer-contribution status (neither contributes) on both topics —
		// the ONLY thing that should determine order is recency (createdAt desc).
		// Different suggestedPostTypes must not perturb that.
		const older = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "Older, single post type",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"Older, single post type",
				),
				suggestedPostTypes: ["TWEET"],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt ordering
		const newer = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "Newer, multiple post types",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"Newer, multiple post types",
				),
				suggestedPostTypes: [
					"BLOG_POST",
					"CASE_STUDY",
					"STAKEHOLDER_EMAIL",
				],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			// Viewer contributes to neither topic, so both land in the same
			// ("rest") tier — isolating the assertion to recency ordering.
			viewerUserId: viewer.id,
		});

		expect(items.map((i) => i.id)).toEqual([newer.id, older.id]);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B role-aware: 3-tier ranks contribution > role-match > rest, above pure recency",
	async () => {
		const viewer = await seedUser("pub-q-list-3tier-viewer");
		const other = await seedUser("pub-q-list-3tier-other");
		const project = await seedProject(viewer);

		await db.projectUserFunctionTag.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				tags: ["DEVELOPER"],
			},
		});

		// Discriminating order (review finding): B (role-matched) is created
		// OLDEST and C (not role-matched) NEWER than B — the OPPOSITE of B being
		// the newest non-contributed row. This matters because:
		//   - OLD 2-tier (pre-Task-7, contribution-only) logic sorts the "rest"
		//     bucket by recency desc → [C, B] → full order [A, C, B].
		//   - NEW 3-tier logic hoists B (role-matched) into tier 2 above C,
		//     regardless of recency → [A, B, C].
		// The two algorithms now disagree, so asserting [a, b, c] below FAILS on
		// 2-tier code and PASSES on 3-tier code. (Before this reorder, B was
		// seeded as the newest non-contributed row, so both algorithms produced
		// the same [A, B, C] order and this case passed on pre-Task-7 code too —
		// it proved nothing about the new tier-2 hoist.)
		const b = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "B role-matched, not contributed",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"B role-matched, not contributed",
				),
				contributorUserIds: [other.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		const c = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "C neither contributed nor role-matched",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"C neither contributed nor role-matched",
				),
				contributorUserIds: [other.id],
				relevantFunctionTags: ["DESIGNER"],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		const a = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "A viewer-contributed",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "A viewer-contributed"),
				contributorUserIds: [viewer.id],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: viewer.id,
		});

		// tier1 = A (viewer contributed); tier2 = B (role-matched, not
		// contributed); tier3 = C (neither) — B is hoisted above C even though B
		// is OLDER than C, which is what makes this case discriminating (see
		// comment above).
		expect(items.map((i) => i.id)).toEqual([a.id, b.id, c.id]);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B role-aware: an untagged viewer collapses to the 2-tier contribution-only order (no role tier)",
	async () => {
		const viewer = await seedUser("pub-q-list-notags-viewer");
		const other = await seedUser("pub-q-list-notags-other");
		const project = await seedProject(viewer);
		// Deliberately NO ProjectUserFunctionTag row for the viewer — the
		// findUnique read genuinely returns null, so viewerTags = [] and the
		// role tier is empty (not a read failure — a real untagged viewer).

		const contributed = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "Viewer-contributed, older",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"Viewer-contributed, older",
				),
				contributorUserIds: [viewer.id],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));

		// Newer, NOT viewer-contributed, but DOES carry a relevantFunctionTags
		// value that would land it in tier 2 if the viewer had a matching tag.
		// The viewer has NO tags at all, so it must NOT be hoisted — it lands
		// in the plain "rest" tier, same as the pre-1B two-tier behavior.
		const untagged = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "Tagged topic, but viewer has no tags",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(
					project.id,
					"Tagged topic, but viewer has no tags",
				),
				contributorUserIds: [other.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: viewer.id,
		});

		expect(items.map((i) => i.id)).toEqual([contributed.id, untagged.id]);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics 1B role-aware: two role-matched (non-contributed) topics preserve recency within tier 2",
	async () => {
		const viewer = await seedUser("pub-q-list-tier2-viewer");
		const other = await seedUser("pub-q-list-tier2-other");
		const project = await seedProject(viewer);

		await db.projectUserFunctionTag.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				tags: ["DEVELOPER"],
			},
		});

		// Older role-matched topic (viewer does NOT contribute)
		const older = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "Older role-matched",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "Older role-matched"),
				contributorUserIds: [other.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt ordering

		// Newer role-matched topic (viewer does NOT contribute)
		const newer = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: viewer.id,
				title: "Newer role-matched",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "Newer role-matched"),
				contributorUserIds: [other.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: viewer.id,
		});

		// Neither topic is contributed by the viewer, so both land in tier 2 —
		// recency (createdAt desc) determines their relative order there.
		expect(items.map((i) => i.id)).toEqual([newer.id, older.id]);
	},
);

it.skipIf(!RUN_DB)(
	"createManualPublishingTopic creates a SELECTED/MANUAL topic with a computed dedupeKey",
	async () => {
		const user = await seedUser("pub-q-manual");
		const project = await seedProject(user);

		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			clientOrganizationId: null, // personal project — tenant comes from the Project row
			createdById: user.id,
			title: "Manual topic",
			description: "manual pitch",
		});

		expect(topic.status).toBe("SELECTED");
		expect(topic.origin).toBe("MANUAL");
		expect(topic.pitch).toBe("manual pitch");
		expect(topic.createdById).toBe(user.id);

		const row = await db.publishingTopic.findUniqueOrThrow({
			where: { id: topic.id },
		});
		expect(row.dedupeKey).toBe(
			computeDedupeKey(project.id, "Manual topic"),
		);
		// tenant columns are derived from the (personal) Project, not the caller
		expect(row.organizationId).toBeNull();
		expect(row.userId).toBe(user.id);
	},
);

it.skipIf(!RUN_DB)(
	"createManualPublishingTopic stamps the creator as sole contributor and no post types",
	async () => {
		const user = await seedUser("pub-q-contributor");
		const project = await seedProject(user);

		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			clientOrganizationId: null,
			createdById: user.id,
			title: "Manual topic",
		});

		const row = await db.publishingTopic.findUnique({
			where: { id: topic.id },
			select: {
				contributorUserIds: true,
				suggestedPostTypes: true,
				origin: true,
			},
		});
		expect(row?.origin).toBe("MANUAL");
		expect(row?.contributorUserIds).toEqual([user.id]);
		expect(row?.suggestedPostTypes).toEqual([]);
	},
);

it.skipIf(!RUN_DB)(
	"createManualPublishingTopic stamps the topic with the project's CURRENT tenant even when the project transfers org before the insert (C-High TOCTOU)",
	async () => {
		// Codex C-High: tenant resolution + insert must be ATOMIC. The helper
		// re-locks (`SELECT ... FOR UPDATE`) and re-derives the tenant tuple from
		// the Project row INSIDE its own transaction, so a transfer that lands
		// before the insert can never leave the topic stamped with the stale org.
		const user = await seedUser("pub-q-race");
		const orgA = await db.organization.create({
			data: {
				name: `pub-q-race-a-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		const orgB = await db.organization.create({
			data: {
				name: `pub-q-race-b-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(orgA.id, orgB.id);
		const project = await seedProject(user, { organizationId: orgA.id });

		// Simulate a concurrent org transfer A -> B landing AFTER the caller's
		// authorization/read but BEFORE the create's internal tenant read. The
		// atomic re-lock means the topic must be stamped with orgB (the Project's
		// tenant at insert time), never the stale orgA.
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: orgB.id },
		});

		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			clientOrganizationId: null, // guest-style: tenant comes from the Project
			createdById: user.id,
			title: "Race topic",
		});

		const row = await db.publishingTopic.findUniqueOrThrow({
			where: { id: topic.id },
			select: { organizationId: true, userId: true },
		});
		expect(row.organizationId).toBe(orgB.id); // CURRENT tenant, not stale orgA
		expect(row.userId).toBeNull(); // XOR-normalized: org project -> userId null
	},
);

it.skipIf(!RUN_DB)(
	"createManualPublishingTopic throws PublishingTopicTenantMismatchError on a positively-wrong non-null client org (F2, race-free)",
	async () => {
		const user = await seedUser("pub-q-mismatch");
		const orgReal = await db.organization.create({
			data: {
				name: `pub-q-mismatch-real-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(orgReal.id);
		const project = await seedProject(user, { organizationId: orgReal.id });

		await expect(
			createManualPublishingTopic({
				projectId: project.id,
				clientOrganizationId: "org-wrong", // does not match the locked Project tenant
				createdById: user.id,
				title: "Mismatch topic",
			}),
		).rejects.toBeInstanceOf(PublishingTopicTenantMismatchError);
		// nothing written on the rejected path
		expect(
			await db.publishingTopic.count({
				where: { projectId: project.id },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"createManualPublishingTopic throws PublishingTopicProjectNotFoundError for a missing project",
	async () => {
		await expect(
			createManualPublishingTopic({
				projectId: `missing-${randomUUID()}`,
				clientOrganizationId: null,
				createdById: (await seedUser("pub-q-missing")).id,
				title: "Ghost topic",
			}),
		).rejects.toBeInstanceOf(PublishingTopicProjectNotFoundError);
	},
);

it.skipIf(!RUN_DB)(
	"createManualPublishingTopic surfaces the raw P2002 on a project-wide dedupeKey collision",
	async () => {
		const user = await seedUser("pub-q-dup");
		const project = await seedProject(user);
		await createManualPublishingTopic({
			projectId: project.id,
			clientOrganizationId: null,
			createdById: user.id,
			title: "Same subject",
		});

		await expect(
			createManualPublishingTopic({
				projectId: project.id,
				clientOrganizationId: null,
				createdById: user.id,
				title: "Same subject",
			}),
		).rejects.toMatchObject({ code: "P2002" });
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus flips status and stores declineReason",
	async () => {
		const user = await seedUser("pub-q-update");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "To decline",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(project.id, "To decline"),
			},
		});

		const result = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "DECLINED",
			declineReason: "not aligned with roadmap",
		});

		expect(result?.topic.status).toBe("DECLINED");
		expect(result?.topic.declineReason).toBe("not aligned with roadmap");
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus clears a stale declineReason when transitioning out of DECLINED (Copilot)",
	async () => {
		const user = await seedUser("pub-q-clear-reason");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Decline then reselect",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(
					project.id,
					"Decline then reselect",
				),
			},
		});

		const declined = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "DECLINED",
			declineReason: "not aligned with roadmap",
		});
		expect(declined?.topic.status).toBe("DECLINED");
		expect(declined?.topic.declineReason).toBe("not aligned with roadmap");

		// Transition OUT of DECLINED without passing declineReason — the stale
		// reason must be cleared, not left dangling on a non-declined topic.
		const reselected = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "SELECTED",
		});
		expect(reselected?.topic.status).toBe("SELECTED");
		expect(reselected?.topic.declineReason).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus stores a null declineReason when declining without a reason (Copilot)",
	async () => {
		const user = await seedUser("pub-q-decline-noreason");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Decline without reason",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(
					project.id,
					"Decline without reason",
				),
			},
		});

		const result = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "DECLINED",
		});

		expect(result?.topic.status).toBe("DECLINED");
		expect(result?.topic.declineReason).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus stores publishedUrl when transitioning to PUBLISHED, surfaced via listPublishingTopics (FR14/DV5)",
	async () => {
		const user = await seedUser("pub-q-publish-url");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Ready to publish",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(project.id, "Ready to publish"),
			},
		});

		const result = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "PUBLISHED",
			publishedUrl: "https://blog.example.com/post ",
		});

		expect(result?.topic.status).toBe("PUBLISHED");
		// stored verbatim — trimming is the UI's job (DV6, mirrors declineReason)
		expect(result?.topic.publishedUrl).toBe(
			"https://blog.example.com/post ",
		);

		// List projection (TOPIC_LIST_SELECT spreads TOPIC_SELECT) must surface
		// the same field — no separate select wiring for the list path.
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		expect(items.find((i) => i.id === topic.id)?.publishedUrl).toBe(
			"https://blog.example.com/post ",
		);
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus clears publishedUrl when transitioning OUT of PUBLISHED (mirrors declineReason)",
	async () => {
		const user = await seedUser("pub-q-clear-url");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Publish then reselect",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(
					project.id,
					"Publish then reselect",
				),
			},
		});

		const published = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "PUBLISHED",
			publishedUrl: "https://x.example.com",
		});
		expect(published?.topic.status).toBe("PUBLISHED");
		expect(published?.topic.publishedUrl).toBe("https://x.example.com");

		// Transition OUT of PUBLISHED without passing publishedUrl — the stale
		// URL must be cleared, not left dangling on a non-published topic.
		const reselected = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "SELECTED",
		});
		expect(reselected?.topic.status).toBe("SELECTED");
		expect(reselected?.topic.publishedUrl).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus stores a null publishedUrl when publishing with the URL prompt dismissed (FR15)",
	async () => {
		const user = await seedUser("pub-q-publish-nourl");
		const project = await seedProject(user);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "Publish without a url",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(
					project.id,
					"Publish without a url",
				),
			},
		});

		const result = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: project.id,
			status: "PUBLISHED",
			publishedUrl: null,
		});

		expect(result?.topic.status).toBe("PUBLISHED");
		expect(result?.topic.publishedUrl).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicStatus returns null for a topic id scoped to a DIFFERENT project",
	async () => {
		const userA = await seedUser("pub-q-guardA");
		const projectA = await seedProject(userA);
		const userB = await seedUser("pub-q-guardB");
		const projectB = await seedProject(userB);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: projectA.id,
				userId: userA.id,
				title: "Owned by A",
				status: "SELECTED",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(projectA.id, "Owned by A"),
			},
		});

		const result = await updatePublishingTopicStatus({
			id: topic.id,
			projectId: projectB.id, // wrong project — must not match
			status: "DECLINED",
		});

		expect(result).toBeNull();
		const row = await db.publishingTopic.findUniqueOrThrow({
			where: { id: topic.id },
		});
		expect(row.status).toBe("SELECTED"); // untouched by the cross-project attempt
	},
);

it.skipIf(!RUN_DB)(
	"getLatestPublishingCycle returns the most recently created cycle for the project, or null",
	async () => {
		const user = await seedUser("pub-q-cycle");
		const project = await seedProject(user);
		expect(await getLatestPublishingCycle(project.id)).toBeNull();

		await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "READY",
				actorUserId: user.id,
				coveredThrough: new Date(),
				completedAt: new Date(),
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt ordering
		const newer = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});

		const latest = await getLatestPublishingCycle(project.id);
		expect(latest?.id).toBe(newer.id);
		expect(latest?.status).toBe("GENERATING");
		expect(latest?.completedAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"resolveProjectTenant XOR-normalizes an ORG project to {organizationId, userId:null}",
	async () => {
		const user = await seedUser("pub-q-tenant-org");
		const org = await db.organization.create({
			data: { name: `pub-q-org-${randomUUID()}`, createdAt: new Date() },
		});
		createdOrgIds.push(org.id);
		const project = await seedProject(user, { organizationId: org.id });

		const tenant = await resolveProjectTenant(project.id);

		expect(tenant).toEqual({ organizationId: org.id, userId: null });
		// exactly one column non-null
		expect(tenant?.organizationId).not.toBeNull();
		expect(tenant?.userId).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"resolveProjectTenant XOR-normalizes a PERSONAL project to {organizationId:null, userId}",
	async () => {
		const user = await seedUser("pub-q-tenant-personal");
		const project = await seedProject(user);

		const tenant = await resolveProjectTenant(project.id);

		expect(tenant).toEqual({ organizationId: null, userId: user.id });
		// exactly one column non-null
		expect(tenant?.userId).not.toBeNull();
		expect(tenant?.organizationId).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"author recommendation (FR4-8): recommends the owner as SINGLE author when their roster tag matches the topic's relevantFunctionTags",
	async () => {
		const owner = await seedUser("pub-q-authorrec-single");
		const project = await seedProject(owner);
		await db.projectUserFunctionTag.create({
			data: {
				projectId: project.id,
				userId: owner.id,
				tags: ["DEVELOPER"],
			},
		});
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: owner.id,
				title: "Author-rec single",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "Author-rec single"),
				contributorUserIds: [owner.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: owner.id,
		});
		const found = items.find((i) => i.id === topic.id);
		expect(found?.authorRecommendation?.model).toBe("single");
		expect(found?.authorRecommendation?.authors[0]?.id).toBe(owner.id);
		expect(found?.authorRecommendation?.authors[0]?.matchedTags).toEqual([
			"DEVELOPER",
		]);
	},
);

it.skipIf(!RUN_DB)(
	"author recommendation (FR4-8): returns null when the contributor's roster tag does NOT match the topic's relevantFunctionTags (fit-only)",
	async () => {
		const owner = await seedUser("pub-q-authorrec-nofit");
		const project = await seedProject(owner);
		await db.projectUserFunctionTag.create({
			data: {
				projectId: project.id,
				userId: owner.id,
				tags: ["DESIGNER"],
			},
		});
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: owner.id,
				title: "Author-rec no fit",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "Author-rec no fit"),
				contributorUserIds: [owner.id],
				relevantFunctionTags: ["DEVELOPER"],
			},
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: owner.id,
		});
		expect(
			items.find((i) => i.id === topic.id)?.authorRecommendation,
		).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"updatePublishingTopicPostTypes sets a non-empty override that round-trips as non-null userPostTypes",
	async () => {
		const user = await seedUser("ptc-set");
		const project = await seedProject(user);
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "PTC set",
		});
		const res = await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: project.id,
			postTypes: ["TWEET", "BLOG_POST"],
		});
		expect(res).not.toBeNull();
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		const found = items.find((t) => t.id === topic.id);
		expect(found?.userPostTypes).toEqual(["TWEET", "BLOG_POST"]);
	},
);

it.skipIf(!RUN_DB)(
	"passing null resets the override — userPostTypes projects back to null",
	async () => {
		const user = await seedUser("ptc-reset");
		const project = await seedProject(user);
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "PTC reset",
		});
		await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: project.id,
			postTypes: ["CASE_STUDY"],
		});
		await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: project.id,
			postTypes: null,
		});
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		expect(items.find((t) => t.id === topic.id)?.userPostTypes).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"an empty override is stored and projects as [] (distinct from null)",
	async () => {
		const user = await seedUser("ptc-empty");
		const project = await seedProject(user);
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "PTC empty",
		});
		await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: project.id,
			postTypes: [],
		});
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		expect(items.find((t) => t.id === topic.id)?.userPostTypes).toEqual([]);
	},
);

it.skipIf(!RUN_DB)(
	"is project-scoped: a foreign projectId writes nothing and returns null",
	async () => {
		const user = await seedUser("ptc-scope");
		const project = await seedProject(user);
		const other = await seedProject(user);
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "PTC scope",
		});
		const res = await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: other.id, // wrong project
			postTypes: ["TWEET"],
		});
		expect(res).toBeNull();
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		expect(items.find((t) => t.id === topic.id)?.userPostTypes).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"a manual topic (no AI suggestion) accepts an override",
	async () => {
		const user = await seedUser("ptc-manual");
		const project = await seedProject(user);
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "PTC manual",
		});
		await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: project.id,
			postTypes: ["STAKEHOLDER_EMAIL"],
		});
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		expect(items.find((t) => t.id === topic.id)?.userPostTypes).toEqual([
			"STAKEHOLDER_EMAIL",
		]);
	},
);

it.skipIf(!RUN_DB)(
	"dedupes a duplicated post type in the override",
	async () => {
		const user = await seedUser("ptc-dedupe");
		const project = await seedProject(user);
		const { topic } = await createManualPublishingTopic({
			projectId: project.id,
			createdById: user.id,
			title: "PTC dedupe",
		});
		await updatePublishingTopicPostTypes({
			id: topic.id,
			projectId: project.id,
			postTypes: ["TWEET", "TWEET", "BLOG_POST"],
		});
		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		expect(items.find((t) => t.id === topic.id)?.userPostTypes).toEqual([
			"TWEET",
			"BLOG_POST",
		]);
	},
);

it.skipIf(!RUN_DB)(
	"whySuggested: resolves an in-project document title + PR count (real read)",
	async () => {
		const user = await seedUser("pub-q-ws-doc");
		const project = await seedProject(user);
		const doc = await db.projectDocument.create({
			data: {
				projectId: project.id,
				type: "GENERAL",
				title: "Launch Plan",
				content: "",
			},
		});
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "WS doc",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "WS doc"),
				provenance: {
					docIds: [doc.id],
					repoPrs: [{ repoFullName: "o/r", prNumber: 2 }],
				},
			},
		});
		const ws = (
			await listPublishingTopics({
				projectId: project.id,
				viewerUserId: user.id,
			})
		).items.find((i) => i.id === topic.id)?.whySuggested;
		expect(ws?.named).toEqual([{ type: "document", label: "Launch Plan" }]);
		expect(ws?.prCount).toBe(1);
	},
);

it.skipIf(!RUN_DB)(
	"whySuggested: a foreign-project document is NOT resolved (tenant isolation)",
	async () => {
		const user = await seedUser("pub-q-ws-tenant");
		const project = await seedProject(user);
		const otherUser = await seedUser("pub-q-ws-tenant-other");
		const otherProject = await seedProject(otherUser);
		const localDoc = await db.projectDocument.create({
			data: {
				projectId: project.id,
				type: "GENERAL",
				title: "Local Doc",
				content: "",
			},
		});
		const foreignDoc = await db.projectDocument.create({
			data: {
				projectId: otherProject.id,
				type: "GENERAL",
				title: "Foreign Doc",
				content: "",
			},
		});
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "WS tenant",
				status: "SUGGESTION",
				origin: "AI",
				dedupeKey: computeDedupeKey(project.id, "WS tenant"),
				provenance: { docIds: [localDoc.id, foreignDoc.id] },
			},
		});
		const ws = (
			await listPublishingTopics({
				projectId: project.id,
				viewerUserId: user.id,
			})
		).items.find((i) => i.id === topic.id)?.whySuggested;
		// Only the in-project doc resolves; the foreign one is dropped by the projectId filter.
		expect(ws?.named).toEqual([{ type: "document", label: "Local Doc" }]);
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: matches a member speaker, drops Unknown + non-members",
	async () => {
		const owner = await seedUser("mp-owner");
		const project = await seedProject(owner);
		const member = await seedUser("mp-dev");
		await seedMember(project, member);
		const tr = await seedTranscript(project, [
			"mp-dev",
			"Unknown",
			"Someone Else",
		]);
		const topic = await seedMeetingTopic(project, owner, "MP match", [
			tr.id,
		]);
		const item = (
			await listPublishingTopics({
				projectId: project.id,
				viewerUserId: owner.id,
			})
		).items.find((i) => i.id === topic.id);
		expect(item?.meetingSpeakers?.members.map((m) => m.id)).toEqual([
			member.id,
		]);
		expect(item?.meetingSpeakers?.overflowCount).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: resolves with FABRIC_FEATURE_FUNCTION_TAGS off (D5 flag-off)",
	async () => {
		const prev = process.env.FABRIC_FEATURE_FUNCTION_TAGS;
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "false";
		try {
			const owner = await seedUser("mp-flagoff");
			const project = await seedProject(owner);
			const tr = await seedTranscript(project, ["mp-flagoff"]);
			const topic = await seedMeetingTopic(project, owner, "MP flagoff", [
				tr.id,
			]);
			const item = (
				await listPublishingTopics({
					projectId: project.id,
					viewerUserId: owner.id,
				})
			).items.find((i) => i.id === topic.id);
			expect(item?.meetingSpeakers?.members.map((m) => m.id)).toEqual([
				owner.id,
			]);
		} finally {
			if (prev === undefined) {
				delete process.env.FABRIC_FEATURE_FUNCTION_TAGS;
			} else {
				process.env.FABRIC_FEATURE_FUNCTION_TAGS = prev;
			}
		}
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: tenant-scoped — a foreign-project transcript never resolves",
	async () => {
		const owner = await seedUser("mp-tenant");
		const projectA = await seedProject(owner);
		const projectB = await seedProject(owner);
		const trB = await seedTranscript(projectB, ["mp-tenant"]);
		const topic = await seedMeetingTopic(
			projectA,
			owner,
			"MP tenant",
			[trB.id], // A's topic cites B's transcript (stale/foreign)
		);
		const item = (
			await listPublishingTopics({
				projectId: projectA.id,
				viewerUserId: owner.id,
			})
		).items.find((i) => i.id === topic.id);
		expect(item?.meetingSpeakers).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: self-invited owner (duplicate roster row) still matches",
	async () => {
		const owner = await seedUser("mp-selfinvite");
		const project = await seedProject(owner);
		await seedMember(project, owner); // owner ALSO a member row → roster returns owner twice
		const tr = await seedTranscript(project, ["mp-selfinvite"]);
		const topic = await seedMeetingTopic(project, owner, "MP self", [
			tr.id,
		]);
		const item = (
			await listPublishingTopics({
				projectId: project.id,
				viewerUserId: owner.id,
			})
		).items.find((i) => i.id === topic.id);
		expect(item?.meetingSpeakers?.members.map((m) => m.id)).toEqual([
			owner.id,
		]);
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: dedupes a member across two cited meetings",
	async () => {
		const owner = await seedUser("mp-dedupe");
		const project = await seedProject(owner);
		const tr1 = await seedTranscript(project, ["mp-dedupe"]);
		const tr2 = await seedTranscript(project, ["mp-dedupe"]);
		const topic = await seedMeetingTopic(project, owner, "MP dedupe", [
			tr1.id,
			tr2.id,
		]);
		const item = (
			await listPublishingTopics({
				projectId: project.id,
				viewerUserId: owner.id,
			})
		).items.find((i) => i.id === topic.id);
		expect(item?.meetingSpeakers?.members.map((m) => m.id)).toEqual([
			owner.id,
		]);
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: fails closed when two distinct members share a name",
	async () => {
		const owner = await seedUser("mp-amb-owner");
		const project = await seedProject(owner);
		// Two DISTINCT users, same display name → the roster index buckets them
		// under one normalized name with size 2 → ambiguous → nobody credited.
		const a = await seedUser("Sam Taylor");
		const b = await seedUser("Sam Taylor");
		await seedMember(project, a);
		await seedMember(project, b);
		const tr = await seedTranscript(project, ["Sam Taylor"]);
		const topic = await seedMeetingTopic(project, owner, "MP ambiguous", [
			tr.id,
		]);
		const item = (
			await listPublishingTopics({
				projectId: project.id,
				viewerUserId: owner.id,
			})
		).items.find((i) => i.id === topic.id);
		expect(item?.meetingSpeakers).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"meetingSpeakers: degrades to null in isolation when the roster read throws",
	async () => {
		const owner = await seedUser("mp-degrade");
		const project = await seedProject(owner);
		const tr = await seedTranscript(project, ["mp-degrade"]);
		const topic = await seedMeetingTopic(project, owner, "MP degrade", [
			tr.id,
		]);
		// The file forces FABRIC_FEATURE_FUNCTION_TAGS=true (beforeAll), under
		// which author-recommendation ALSO calls getProjectMembers (via
		// getProjectMemberFunctionTags) BEFORE this block and would consume the
		// once-mock. Force the flag OFF here so the meeting-participant block's
		// getProjectMembers is the ONLY invocation (author-rec + FR3 roster reads
		// are flag-gated and skipped), then restore the flag.
		const prevFlag = process.env.FABRIC_FEATURE_FUNCTION_TAGS;
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "false";
		const spy = vi
			.spyOn(membersModule, "getProjectMembers")
			.mockRejectedValueOnce(new Error("boom"));
		try {
			const item = (
				await listPublishingTopics({
					projectId: project.id,
					viewerUserId: owner.id,
				})
			).items.find((i) => i.id === topic.id);
			// Non-vacuity: prove the one-shot rejection was actually consumed by
			// THIS block's roster read (else meetingSpeakers=null and
			// whySuggested!=null both pass even if the block was skipped entirely).
			expect(spy).toHaveBeenCalledTimes(1);
			expect(item?.meetingSpeakers).toBeNull();
			expect(item?.whySuggested).not.toBeNull();
		} finally {
			spy.mockRestore();
			if (prevFlag === undefined) {
				delete process.env.FABRIC_FEATURE_FUNCTION_TAGS;
			} else {
				process.env.FABRIC_FEATURE_FUNCTION_TAGS = prevFlag;
			}
		}
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics projects subject onto the list item (present for a group member, null for a singleton)",
	async () => {
		const user = await seedUser("pub-q-subject");
		const project = await seedProject(user);
		await db.publishingTopic.createMany({
			data: [
				{
					projectId: project.id,
					userId: user.id,
					title: "How we built RLS",
					pitch: "p",
					status: "SUGGESTION",
					origin: "AI",
					provenance: {},
					dedupeKey: computeDedupeKey(project.id, "How we built RLS"),
					subject: "Shipped RLS",
					subjectKey: computeSubjectKey(project.id, "Shipped RLS"),
				},
				{
					projectId: project.id,
					userId: user.id,
					title: "A lone topic",
					pitch: "p",
					status: "SUGGESTION",
					origin: "AI",
					provenance: {},
					dedupeKey: computeDedupeKey(project.id, "A lone topic"),
					subject: null,
					subjectKey: null,
				},
			],
		});

		const { items } = await listPublishingTopics({
			projectId: project.id,
			viewerUserId: user.id,
		});
		const grouped = items.find((i) => i.title === "How we built RLS");
		const lone = items.find((i) => i.title === "A lone topic");
		expect(grouped?.subject).toBe("Shipped RLS");
		expect(lone?.subject).toBeNull();
	},
);

// ---------------------------------------------------------------------------
// Cycle history (Fizzy #1850, Phase 1C-4a).
//
// The tab renders only the LATEST cycle, so a run that failed or produced
// nothing disappears the moment the next one starts — including the failure
// somebody would open the tab to investigate. These cover the paged reader
// behind the history table.
// ---------------------------------------------------------------------------

type SeedCycleStatus =
	| "GENERATING"
	| "READY"
	| "NO_TOPICS"
	| "INSUFFICIENT_CONTEXT"
	| "FAILED";

async function seedCycle(
	project: { id: string },
	user: { id: string },
	status: SeedCycleStatus,
	overrides: { createdAt?: Date; triggeredByUserId?: string } = {},
) {
	return db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			userId: user.id, // personal context; organizationId stays NULL (tenant XOR)
			status,
			actorUserId: user.id,
			coveredThrough: new Date(),
			...(status === "GENERATING"
				? { executionTimeoutAt: new Date(Date.now() + 3_600_000) }
				: { completedAt: new Date() }),
			...overrides,
		},
	});
}

it.skipIf(!RUN_DB)(
	"buckets every cycle status, and excludes what each bucket must not contain",
	async () => {
		const user = await seedUser("pub-q-hist-bucket");
		const project = await seedProject(user);
		for (const status of [
			"READY",
			"FAILED",
			"NO_TOPICS",
			"INSUFFICIENT_CONTEXT",
			"GENERATING",
		] as const) {
			await seedCycle(project, user, status);
		}

		const page = (status: PublishingCycleStatusFilter) =>
			listPublishingCycles(project.id, { limit: 50, offset: 0, status });

		expect((await page("ready")).map((c) => c.status)).toEqual(["READY"]);
		expect((await page("failed")).map((c) => c.status)).toEqual(["FAILED"]);
		// `empty` is the only multi-value bucket, so both members are asserted:
		// a predicate naming just one of them passes a one-member check.
		expect((await page("empty")).map((c) => c.status).sort()).toEqual([
			"INSUFFICIENT_CONTEXT",
			"NO_TOPICS",
		]);

		// Both directions. A bucket predicate written with the wrong values
		// still returns rows, so asserting only what SHOULD appear cannot tell
		// a correct predicate from a permissive one.
		for (const status of ["ready", "failed", "empty"] as const) {
			const rows = await page(status);
			expect(rows.some((c) => c.status === "GENERATING")).toBe(false);
		}
		// GENERATING is a live cycle rather than an outcome: it belongs to no
		// bucket, but it must stay reachable — a stuck run is exactly what
		// someone opens this table to find.
		expect((await page("all")).some((c) => c.status === "GENERATING")).toBe(
			true,
		);
	},
);

it.skipIf(!RUN_DB)(
	"pages deterministically when two cycles share a createdAt",
	async () => {
		const user = await seedUser("pub-q-hist-tie");
		const project = await seedProject(user);
		// Identical createdAt on all four — the tie the `id` sort exists for.
		const createdAt = new Date("2026-08-01T00:00:00.000Z");
		for (let i = 0; i < 4; i++) {
			await seedCycle(project, user, "READY", { createdAt });
		}

		const first = await listPublishingCycles(project.id, {
			limit: 2,
			offset: 0,
			status: "all",
		});

		// THE POINT OF THIS TEST, and it took a negative control to find it: with
		// four freshly inserted rows, dropping the `id` tiebreak changes nothing
		// — Postgres seq-scans a tiny table and hands back insertion order, so a
		// tie test written as "read both pages, expect four distinct ids" passes
		// against an ordering that guarantees nothing. It proves the planner's
		// luck, not the query.
		//
		// What actually perturbs that order is an UPDATE: Postgres writes a new
		// tuple version at the END of the heap, so a row touched between the two
		// page reads moves to the back of an untied scan — and then appears on
		// page 2 as well, while the row it displaced appears on neither. This is
		// not a contrived scenario either; the notification lifecycle writes
		// exactly these columns on exactly these rows.
		await db.publishingSuggestionCycle.update({
			where: { id: first[0]?.id },
			data: { notificationOutcomeVersion: { increment: 1 } },
		});

		const second = await listPublishingCycles(project.id, {
			limit: 2,
			offset: 2,
			status: "all",
		});

		// The failure this guards is not "wrong order" — it is a row served on
		// BOTH pages while another is served on neither, which is what an
		// unstable sort does to OFFSET paging.
		const ids = [...first, ...second].map((c) => c.id);
		expect(ids).toHaveLength(4);
		expect(new Set(ids).size).toBe(4);
	},
);

it.skipIf(!RUN_DB)(
	"counts agree with the rows the same filter returns",
	async () => {
		const user = await seedUser("pub-q-hist-count");
		const project = await seedProject(user);
		await seedCycle(project, user, "READY");
		await seedCycle(project, user, "READY");
		await seedCycle(project, user, "FAILED");

		expect(await countPublishingCycles(project.id, "ready")).toBe(2);
		expect(await countPublishingCycles(project.id, "failed")).toBe(1);
		expect(await countPublishingCycles(project.id, "all")).toBe(3);
	},
);

it.skipIf(!RUN_DB)(
	"counts only the topics belonging to the cycle, not the project's manual ones",
	async () => {
		const user = await seedUser("pub-q-hist-topics");
		const project = await seedProject(user);
		const cycle = await seedCycle(project, user, "READY");
		for (const title of ["from cycle A", "from cycle B"]) {
			await db.publishingTopic.create({
				data: {
					projectId: project.id,
					userId: user.id,
					cycleId: cycle.id,
					title,
					status: "SUGGESTION",
					origin: "AI",
					dedupeKey: computeDedupeKey(project.id, title),
				},
			});
		}
		// cycleId is nullable precisely for these — a manually created topic
		// belongs to no cycle and must not inflate any cycle's count.
		await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "typed in by hand",
				status: "SUGGESTION",
				origin: "MANUAL",
				dedupeKey: computeDedupeKey(project.id, "typed in by hand"),
			},
		});

		await db.publishingChatDelivery.create({
			data: {
				cycleId: cycle.id,
				projectId: project.id,
				organizationId: null,
				userId: user.id,
				platform: "SLACK",
				externalTeamId: "T-example",
				channelId: "C-example",
				status: "SENT",
			},
		});

		const [row] = await listPublishingCycles(project.id, {
			limit: 10,
			offset: 0,
			status: "all",
		});
		expect(row?._count.topics).toBe(2);
		// The only RUNTIME assertion that can catch `chatDeliveries` missing from
		// this query's `_count` select. The procedure test module-mocks
		// `listPublishingCycles`, so a mocked row can supply a field the query
		// never asks for — which in production is `undefined` on every row, a
		// disclosure that never renders, and a green suite. (`tsc` catches it
		// too, and faster, because the inferred payload type would lack the
		// field; this one additionally pins the VALUE.)
		expect(row?._count.chatDeliveries).toBe(1);
		// Same hazard as the line above, same reason: the procedure test
		// module-mocks this query, so a mocked row can hand the projection a
		// field the `select` never asked for — and the column would be
		// `undefined` on every row in production while both suites stayed
		// green.
		//
		// Asserts the DEFAULT rather than writing a value first. `seedCycle`
		// does not set this column, so `NOT_APPLICABLE` is what the row must
		// carry, and the failure being guarded — the field missing from the
		// select — surfaces as `undefined` either way. Updating the row to a
		// non-default value would additionally pin a plain string column
		// round-tripping, which nothing here threatens, at the cost of a write
		// this change cannot exercise locally.
		expect(row?.notificationOutcome).toBe("NOT_APPLICABLE");
	},
);

it.skipIf(!RUN_DB)(
	"counts notification reach in people, never in ledger rows",
	async () => {
		const user = await seedUser("pub-q-reach-one");
		const other = await seedUser("pub-q-reach-two");
		const project = await seedProject(user);
		const cycle = await seedCycle(project, user, "READY");

		// THE CASE A ROW COUNT GETS WRONG. One person owed both channels and
		// reached on one of them: two rows, one person, one delivery. A
		// relation count would report two people notified out of two, which is
		// the false "everyone got it" this counter exists to avoid.
		await db.publishingNotificationDelivery.createMany({
			data: [
				{
					cycleId: cycle.id,
					projectId: project.id,
					organizationId: null,
					userId: user.id,
					recipientUserId: user.id,
					channel: "IN_APP",
					status: "SENT",
					deliveredAt: new Date(),
				},
				{
					cycleId: cycle.id,
					projectId: project.id,
					organizationId: null,
					userId: user.id,
					recipientUserId: user.id,
					channel: "EMAIL",
					status: "FAILED",
				},
				// A second person owed one channel and was never reached, so
				// `owed` and `delivered` must differ. Without them the two
				// counts would agree and a bug that returns `owed` for both
				// would pass.
				{
					cycleId: cycle.id,
					projectId: project.id,
					organizationId: null,
					userId: user.id,
					recipientUserId: other.id,
					channel: "IN_APP",
					status: "SKIPPED",
				},
			],
		});

		expect(
			await countPublishingCycleRecipients(project.id, [cycle.id]),
		).toEqual({
			[cycle.id]: { owed: 2, delivered: 1 },
		});

		// The project filter, checked against the ONE id that would otherwise
		// answer: naming another project returns nothing for a cycle whose rows
		// demonstrably exist, so this is scoping rather than an empty fixture.
		const stranger = await seedUser("pub-q-reach-stranger");
		const elsewhere = await seedProject(stranger);
		expect(
			await countPublishingCycleRecipients(elsewhere.id, [cycle.id]),
		).toEqual({});
	},
);

it.skipIf(!RUN_DB)(
	"omits a cycle that owed nobody, rather than inventing a zero row",
	async () => {
		// Positive control on the assertion above: the same query, the same
		// project, and a cycle with no ledger rows at all — the ordinary state
		// for the six outcomes that write none. An empty object is what lets
		// the caller read a missing entry as zero.
		const user = await seedUser("pub-q-reach-none");
		const project = await seedProject(user);
		const cycle = await seedCycle(project, user, "READY");

		expect(
			await countPublishingCycleRecipients(project.id, [cycle.id]),
		).toEqual({});
		// And the empty-input short circuit, which must not reach the database.
		expect(await countPublishingCycleRecipients(project.id, [])).toEqual(
			{},
		);
	},
);

it.skipIf(!RUN_DB)("never returns another project's cycles", async () => {
	const user = await seedUser("pub-q-hist-mine");
	const other = await seedUser("pub-q-hist-theirs");
	const mine = await seedProject(user);
	const theirs = await seedProject(other);
	await seedCycle(theirs, other, "READY");

	expect(
		await listPublishingCycles(mine.id, {
			limit: 10,
			offset: 0,
			status: "all",
		}),
	).toEqual([]);
	expect(await countPublishingCycles(mine.id, "all")).toBe(0);
	// Positive control: the row really was created, so the empty result above
	// is scoping rather than a fixture that silently failed to insert.
	expect(await countPublishingCycles(theirs.id, "all")).toBe(1);
});

async function seedProjectWithTopic() {
	const user = await seedUser("snooze");
	const project = await db.project.create({
		data: { name: `p-${randomUUID()}`, userId: user.id },
	});
	projectIds.push(project.id);
	const topic = await db.publishingTopic.create({
		data: {
			projectId: project.id,
			userId: user.id,
			title: `t-${randomUUID()}`,
			origin: "MANUAL",
			status: "SELECTED",
			dedupeKey: randomUUID(),
		},
	});
	return { projectId: project.id, topicId: topic.id, userId: user.id };
}

async function seedOrgProjectWithTopic() {
	const user = await seedUser("snooze-org");
	const org = await db.organization.create({
		// createdAt has no schema default (Organization.createdAt: DateTime,
		// not DateTime @default(now())) — matches this file's other
		// db.organization.create() fixtures above.
		data: {
			name: `example-org-${randomUUID()}`,
			slug: randomUUID(),
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(org.id);
	const project = await db.project.create({
		data: {
			name: `p-${randomUUID()}`,
			userId: user.id,
			organizationId: org.id,
		},
	});
	projectIds.push(project.id);
	const topic = await db.publishingTopic.create({
		data: {
			projectId: project.id,
			// org context -> userId NULL (publishing_topic_tenant_xor CHECK
			// constraint requires exactly one of organizationId/userId).
			userId: null,
			organizationId: org.id,
			title: `t-${randomUUID()}`,
			origin: "MANUAL",
			status: "SELECTED",
			dedupeKey: randomUUID(),
		},
	});
	return {
		projectId: project.id,
		topicId: topic.id,
		organizationId: org.id,
	};
}

it.skipIf(!RUN_DB)(
	"setPublishingTopicSnooze derives the timestamp from the preset and clears on null",
	async () => {
		const { projectId, topicId } = await seedProjectWithTopic();
		const now = new Date("2026-05-01T00:00:00.000Z");

		const snoozed = await setPublishingTopicSnooze({
			id: topicId,
			projectId,
			preset: "ONE_WEEK",
			reason: "  waiting on the release  ",
			now,
		});
		expect(snoozed?.topic.snoozedUntil?.toISOString()).toBe(
			"2026-05-08T00:00:00.000Z",
		);
		expect(snoozed?.topic.snoozeReason).toBe("waiting on the release");

		const cleared = await setPublishingTopicSnooze({
			id: topicId,
			projectId,
			preset: null,
			now,
		});
		expect(cleared?.topic.snoozedUntil).toBeNull();
		// Clearing the snooze must clear its reason too — a rationale left
		// behind on an un-snoozed topic is a stale explanation for a state the
		// topic is no longer in.
		expect(cleared?.topic.snoozeReason).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"setPublishingTopicSnooze refuses a topic belonging to another project",
	async () => {
		const { topicId } = await seedProjectWithTopic();
		const other = await seedProjectWithTopic();
		const result = await setPublishingTopicSnooze({
			id: topicId,
			projectId: other.projectId,
			preset: "ONE_MONTH",
		});
		expect(result).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"setPublishingTopicReadState creates, is idempotent, and deletes",
	async () => {
		const { projectId, topicId } = await seedProjectWithTopic();
		const userId = (await seedUser("reader")).id;

		expect(
			await setPublishingTopicReadState({
				id: topicId,
				projectId,
				userId,
				read: true,
			}),
		).toBe(true);
		// A double-click must not throw on the unique constraint.
		expect(
			await setPublishingTopicReadState({
				id: topicId,
				projectId,
				userId,
				read: true,
			}),
		).toBe(true);
		expect(
			await db.publishingTopicRead.count({ where: { topicId, userId } }),
		).toBe(1);

		expect(
			await setPublishingTopicReadState({
				id: topicId,
				projectId,
				userId,
				read: false,
			}),
		).toBe(true);
		expect(
			await db.publishingTopicRead.count({ where: { topicId, userId } }),
		).toBe(0);
		// Marking an already-unread topic unread is a no-op, not an error.
		expect(
			await setPublishingTopicReadState({
				id: topicId,
				projectId,
				userId,
				read: false,
			}),
		).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"setPublishingTopicReadState stamps tenant columns from the parent topic",
	async () => {
		const { projectId, topicId, organizationId } =
			await seedOrgProjectWithTopic();
		const userId = (await seedUser("reader-org")).id;
		await setPublishingTopicReadState({
			id: topicId,
			projectId,
			userId,
			read: true,
		});
		const marker = await db.publishingTopicRead.findFirstOrThrow({
			where: { topicId, userId },
		});
		expect(marker.projectId).toBe(projectId);
		expect(marker.organizationId).toBe(organizationId);
	},
);

// NEGATIVE CONTROL (spec 6.2 / finding 4.3): read state must never touch the
// topic row, or marking a topic read would silently reorder Recently Modified.
it.skipIf(!RUN_DB)(
	"marking a topic read does not bump the topic's updatedAt",
	async () => {
		const { projectId, topicId } = await seedProjectWithTopic();
		const userId = (await seedUser("reader-clock")).id;
		const before = await db.publishingTopic.findFirstOrThrow({
			where: { id: topicId },
			select: { updatedAt: true },
		});

		await setPublishingTopicReadState({
			id: topicId,
			projectId,
			userId,
			read: true,
		});

		const after = await db.publishingTopic.findFirstOrThrow({
			where: { id: topicId },
			select: { updatedAt: true },
		});
		expect(after.updatedAt.toISOString()).toBe(
			before.updatedAt.toISOString(),
		);
	},
);

it.skipIf(!RUN_DB)(
	"listPublishingTopics reports per-viewer read state and snooze state",
	async () => {
		const { projectId, topicId, userId } = await seedProjectWithTopic();
		const otherUserId = (await seedUser("other-viewer")).id;
		await setPublishingTopicReadState({
			id: topicId,
			projectId,
			userId,
			read: true,
		});

		const mine = await listPublishingTopics({
			projectId,
			viewerUserId: userId,
		});
		expect(mine.items[0].isRead).toBe(true);

		// Read state is PER USER: another viewer must still see it unread.
		const theirs = await listPublishingTopics({
			projectId,
			viewerUserId: otherUserId,
		});
		expect(theirs.items[0].isRead).toBe(false);
	},
);

it.skipIf(!RUN_DB)(
	"an elapsed snooze reads as not snoozed, at the exact boundary",
	async () => {
		const { projectId, topicId, userId } = await seedProjectWithTopic();
		// This is a coarse integration check, not a pin of the `>` vs `>=`
		// operator: by the time listPublishingTopics captures its own `now`,
		// the `snoozedUntil = new Date()` set here is already in the past, so
		// it reads as elapsed under either comparison. It only confirms an
		// elapsed snooze surfaces and a future one doesn't. The operator
		// boundary itself is pinned by the pure "treats a deadline exactly
		// equal to now as elapsed" test on `isTopicSnoozed` in
		// publishing-inbox.test.ts.
		await db.publishingTopic.update({
			where: { id: topicId },
			data: { snoozedUntil: new Date() },
		});
		const out = await listPublishingTopics({
			projectId,
			viewerUserId: userId,
		});
		expect(out.items[0].isSnoozed).toBe(false);

		await db.publishingTopic.update({
			where: { id: topicId },
			data: { snoozedUntil: new Date(Date.now() + 60_000) },
		});
		const later = await listPublishingTopics({
			projectId,
			viewerUserId: userId,
		});
		expect(later.items[0].isSnoozed).toBe(true);
	},
);

it.skipIf(!RUN_DB)(
	"no topic row retains the deprecated DEFERRED status after the backfill",
	async () => {
		// ::text because the column is an enum: comparing it to a string
		// literal that the Prisma client type no longer admits will not
		// type-check, and comparing enum to enum cannot express "a value the
		// application layer has stopped believing in".
		const rows = await db.$queryRaw<{ count: bigint }[]>`
			SELECT count(*)::bigint AS count
			FROM "publishing_topic"
			WHERE "status"::text = 'DEFERRED'
		`;
		expect(Number(rows[0].count)).toBe(0);
	},
);

afterAll(async () => {
	// Deletes cascade to publishing_topic / publishing_suggestion_cycle rows
	// (both onDelete: Cascade on projectId).
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
	if (priorFunctionTagsFlag === undefined) {
		delete process.env.FABRIC_FEATURE_FUNCTION_TAGS;
	} else {
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = priorFunctionTagsFlag;
	}
});
