/**
 * "Decision candidates are ready" notifications for Living Memory extractions.
 *
 * Recipients are the project's own people (owner and accepted members) who
 * may create decisions on it — never an organization member who was not added
 * to the project — minus whoever last wrote the file and anyone who switched
 * project notifications off. One unread row per person per project, however
 * many files a sync changed, stating what the Decisions tab offers; each
 * extraction announces at most once, and an extraction with nothing open never.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	extractionFindUnique: vi.fn(),
	extractionFindMany: vi.fn(),
	extractionUpdateMany: vi.fn(),
	decisionFindMany: vi.fn(),
	projectFindUnique: vi.fn(),
	memberFindMany: vi.fn(),
	orgMemberFindMany: vi.fn(),
	notificationCreate: vi.fn(),
	notificationUpdateMany: vi.fn(),
	canCreate: vi.fn(),
	enabled: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectContextDecisionExtraction: {
			findUnique: mocks.extractionFindUnique,
			findMany: mocks.extractionFindMany,
			updateMany: mocks.extractionUpdateMany,
		},
		architectureDecision: { findMany: mocks.decisionFindMany },
		project: { findUnique: mocks.projectFindUnique },
		projectMember: { findMany: mocks.memberFindMany },
		member: { findMany: mocks.orgMemberFindMany },
		notification: {
			create: mocks.notificationCreate,
			updateMany: mocks.notificationUpdateMany,
		},
	},
	NotificationCategory: { PROJECT: "PROJECT" },
	NotificationType: {
		DECISION_CANDIDATES_READY: "DECISION_CANDIDATES_READY",
	},
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateArchitectureDecisions: mocks.canCreate,
}));
vi.mock("../prisma/queries/notification-preferences", () => ({
	getEnabledRecipientsForCategory: mocks.enabled,
}));

import {
	createDecisionCandidatesReadyNotifications,
	resolveDecisionCandidateRecipients,
} from "../prisma/queries/projects/living-memory-decision-notifications";

const NEW_HASH = "a".repeat(64);
const OLD_HASH = "b".repeat(64);

const NO_DISMISSALS: number[] = [];

const extraction = {
	id: "ext-1",
	projectId: "proj",
	contextId: "ctx",
	contentHash: NEW_HASH,
	sourcePath: "docs/architecture.md",
	decisions: [{ text: "We use Postgres." }, { text: "We deploy weekly." }],
	dismissedIndexes: NO_DISMISSALS,
	organizationId: "org",
	context: { contentUpdatedByUserId: "writer", contentHash: NEW_HASH },
};

/**
 * A stand-in for the notification table that enforces what the partial unique
 * index does: one unread, unarchived row per (userId, dedupeKey).
 */
function notificationTable() {
	type Row = Record<string, unknown> & {
		userId: string;
		dedupeKey: string;
		readAt: Date | null;
		archivedAt: Date | null;
	};
	const rows: Row[] = [];
	const live = (userId: string, dedupeKey: string) =>
		rows.find(
			(row) =>
				row.userId === userId &&
				row.dedupeKey === dedupeKey &&
				row.readAt === null &&
				row.archivedAt === null,
		);
	mocks.notificationCreate.mockImplementation(async ({ data }) => {
		if (live(data.userId, data.dedupeKey)) {
			throw Object.assign(new Error("unique"), { code: "P2002" });
		}
		rows.push({ ...data, readAt: null, archivedAt: null });
		return { id: `n-${rows.length}` };
	});
	mocks.notificationUpdateMany.mockImplementation(async ({ where, data }) => {
		const row = live(where.userId, where.dedupeKey);
		if (!row) {
			return { count: 0 };
		}
		Object.assign(row, data);
		return { count: 1 };
	});
	return rows;
}

/** Extractions recorded so far, served to the claim, gate and total queries. */
function recordExtractions(recorded: Array<typeof extraction>) {
	mocks.extractionFindUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) =>
			recorded.find((row) => row.id === where.id) ?? null,
	);
	mocks.extractionFindMany.mockImplementation(
		async ({ where }: { where: { contextId?: string } }) =>
			where.contextId
				? recorded.filter((row) => row.contextId === where.contextId)
				: recorded,
	);
}

beforeEach(() => {
	for (const fn of Object.values(mocks)) {
		fn.mockReset();
	}
	mocks.extractionFindUnique.mockResolvedValue(extraction);
	mocks.extractionFindMany.mockResolvedValue([extraction]);
	mocks.extractionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.decisionFindMany.mockResolvedValue([]);
	mocks.projectFindUnique.mockResolvedValue({
		name: "Example project",
		userId: "owner",
	});
	mocks.memberFindMany.mockResolvedValue([
		{ userId: "member" },
		{ userId: "viewer" },
		{ userId: "writer" },
	]);
	mocks.orgMemberFindMany.mockResolvedValue([
		{ userId: "org-creator" },
		{ userId: "member" },
	]);
	mocks.canCreate.mockImplementation(
		async (_projectId: string, userId: string) => userId !== "viewer",
	);
	mocks.enabled.mockImplementation(async (ids: string[]) => new Set(ids));
	mocks.notificationCreate.mockImplementation(async ({ data }) => ({
		id: `n-${data.userId}`,
	}));
	mocks.notificationUpdateMany.mockResolvedValue({ count: 0 });
});

describe("resolveDecisionCandidateRecipients", () => {
	const input = {
		projectId: "proj",
		ownerUserId: "owner",
		writerUserId: "writer",
	};

	it("tells the owner and the project's members who may create decisions", async () => {
		expect(
			(await resolveDecisionCandidateRecipients(input)).sort(),
		).toEqual(["member", "owner"]);
		expect(mocks.memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj",
					acceptedAt: { not: null },
				}),
			}),
		);
	});

	it("never tells an organization member who is not on the project, even one whose organization role grants the permission", async () => {
		const recipients = await resolveDecisionCandidateRecipients(input);

		expect(recipients).not.toContain("org-creator");
		expect(mocks.orgMemberFindMany).not.toHaveBeenCalled();
		expect(mocks.canCreate).not.toHaveBeenCalledWith("proj", "org-creator");
	});

	it("excludes a member without the permission to create decisions", async () => {
		expect(await resolveDecisionCandidateRecipients(input)).not.toContain(
			"viewer",
		);
		expect(mocks.canCreate).toHaveBeenCalledWith("proj", "viewer");
	});

	it("excludes the file's last writer", async () => {
		expect(await resolveDecisionCandidateRecipients(input)).not.toContain(
			"writer",
		);
		expect(mocks.canCreate).not.toHaveBeenCalledWith("proj", "writer");
	});

	it("respects the project notification preference", async () => {
		mocks.enabled.mockResolvedValue(new Set(["owner"]));

		expect(await resolveDecisionCandidateRecipients(input)).toEqual([
			"owner",
		]);
		expect(mocks.enabled).toHaveBeenCalledWith(
			expect.arrayContaining(["owner", "member"]),
			"PROJECT",
		);
	});
});

describe("createDecisionCandidatesReadyNotifications", () => {
	it("writes one PROJECT notification per recipient, linked to the Decisions tab with the total", async () => {
		const written = await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-1",
		});

		expect(written).toBe(2);
		expect(mocks.extractionUpdateMany).toHaveBeenCalledWith({
			where: { id: "ext-1", notifiedAt: null },
			data: { notifiedAt: expect.any(Date) },
		});
		expect(mocks.notificationCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "owner",
					organizationId: "org",
					type: "DECISION_CANDIDATES_READY",
					category: "PROJECT",
					title: "2 decision candidates to review",
					link: "projects/proj?tab=decisions",
					projectId: "proj",
					snippet:
						"Example project: found in 1 file. Review them in the Decisions tab.",
					dedupeKey: "decisionCandidates:proj:owner",
					payload: {
						projectId: "proj",
						candidateCount: 2,
						fileCount: 1,
					},
				}),
			}),
		);
	});

	it("announces nothing for an edit that leaves only already settled decisions", async () => {
		const edited = {
			...extraction,
			decisions: [
				{ text: "  We use   POSTGRES. " },
				{ text: "We deploy weekly." },
			],
		};
		mocks.extractionFindUnique.mockResolvedValue(edited);
		mocks.extractionFindMany.mockResolvedValue([
			edited,
			{
				contextId: "ctx",
				contentHash: OLD_HASH,
				decisions: [
					{ text: "We use Postgres." },
					{ text: "We deploy weekly." },
				],
				dismissedIndexes: [1],
			},
		]);
		mocks.decisionFindMany.mockResolvedValue([
			{
				sourceMetadata: {
					contextId: "ctx",
					contentHash: OLD_HASH,
					index: 0,
				},
			},
		]);

		expect(
			await createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).toBe(0);
		expect(mocks.extractionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notificationCreate).not.toHaveBeenCalled();
	});

	it("counts only the decisions an edit newly added", async () => {
		const edited = {
			...extraction,
			decisions: [
				{ text: "We use Postgres." },
				{ text: "We deploy weekly." },
				{ text: "We pin every dependency." },
			],
		};
		mocks.extractionFindUnique.mockResolvedValue(edited);
		mocks.extractionFindMany.mockResolvedValue([
			edited,
			{
				contextId: "ctx",
				contentHash: OLD_HASH,
				decisions: [
					{ text: "We use Postgres." },
					{ text: "We deploy weekly." },
				],
				dismissedIndexes: [0, 1],
				context: { contentHash: NEW_HASH },
			},
		]);

		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-1",
		});

		expect(mocks.extractionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj", contextId: "ctx" },
			}),
		);
		const data = mocks.notificationCreate.mock.calls[0]?.[0].data;
		expect(data.title).toBe("1 decision candidate to review");
		expect(data.payload.candidateCount).toBe(1);
	});

	it("announces an extraction once: a taken claim writes nothing", async () => {
		mocks.extractionUpdateMany.mockResolvedValue({ count: 0 });

		expect(
			await createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).toBe(0);
		expect(mocks.notificationCreate).not.toHaveBeenCalled();
	});

	it("announces nothing for an extraction that found no decision", async () => {
		mocks.extractionFindUnique.mockResolvedValue({
			...extraction,
			decisions: [],
		});

		expect(
			await createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).toBe(0);
		expect(mocks.extractionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notificationCreate).not.toHaveBeenCalled();
	});

	it("never throws", async () => {
		mocks.extractionFindUnique.mockRejectedValue(new Error("db down"));

		await expect(
			createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).resolves.toBe(0);
	});
});

describe("one notification per person for a sync that changes many files", () => {
	const files = Array.from({ length: 13 }, (_, i) => ({
		...extraction,
		id: `ext-${i}`,
		contextId: `ctx-${i}`,
		sourcePath: `docs/file-${i}.md`,
	}));

	it("tells each of 25 people once about 13 files, with the total, not 325 times", async () => {
		const rows = notificationTable();
		const members = Array.from({ length: 24 }, (_, i) => ({
			userId: `member-${i}`,
		}));
		mocks.memberFindMany.mockResolvedValue(members);
		mocks.canCreate.mockResolvedValue(true);
		const recorded: Array<typeof extraction> = [];
		recordExtractions(recorded);

		for (const file of files) {
			recorded.push(file);
			await createDecisionCandidatesReadyNotifications({
				extractionId: file.id,
			});
		}

		expect(rows).toHaveLength(25);
		expect(new Set(rows.map((row) => row.userId))).toEqual(
			new Set(["owner", ...members.map((member) => member.userId)]),
		);
		for (const row of rows) {
			expect(row).toMatchObject({
				title: "26 decision candidates to review",
				snippet:
					"Example project: found in 13 files. Review them in the Decisions tab.",
				link: "projects/proj?tab=decisions",
				payload: {
					projectId: "proj",
					candidateCount: 26,
					fileCount: 13,
				},
			});
		}
		// The claim is still taken per extraction, once each.
		expect(mocks.extractionUpdateMany).toHaveBeenCalledTimes(13);
		expect(mocks.extractionUpdateMany).toHaveBeenCalledWith({
			where: { id: "ext-12", notifiedAt: null },
			data: { notifiedAt: expect.any(Date) },
		});
	});

	it("keeps one row when extractions finish concurrently", async () => {
		const rows = notificationTable();
		recordExtractions(files);

		const written = await Promise.all(
			files.map((file) =>
				createDecisionCandidatesReadyNotifications({
					extractionId: file.id,
				}),
			),
		);

		expect(rows.map((row) => row.userId).sort()).toEqual([
			"member",
			"owner",
		]);
		expect(written).toEqual(files.map(() => 2));
	});

	it("still tells only the project's people, never the organization roster", async () => {
		const rows = notificationTable();
		recordExtractions(files);

		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-0",
		});

		expect(rows.map((row) => row.userId).sort()).toEqual([
			"member",
			"owner",
		]);
		expect(mocks.orgMemberFindMany).not.toHaveBeenCalled();
	});

	it("moves the unread row back to the top when a later push refreshes it", async () => {
		const rows = notificationTable();
		recordExtractions(files);
		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-0",
		});
		expect(rows[0]?.createdAt).toBeUndefined();

		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-1",
		});

		expect(rows[0]?.createdAt).toEqual(expect.any(Date));
	});

	it("gives a person who read the row a new one for what arrives next", async () => {
		mocks.enabled.mockResolvedValue(new Set(["owner"]));
		const rows = notificationTable();
		recordExtractions(files);
		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-0",
		});
		const [first] = rows;
		if (!first) {
			throw new Error("expected the first row");
		}
		first.readAt = new Date();

		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-1",
		});

		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ readAt: null, userId: "owner" });
	});

	it("states what the tab offers: a file edited twice counts once, and a dismissal lowers the total", async () => {
		const rows = notificationTable();
		recordExtractions([
			{
				...extraction,
				id: "ext-v1",
				contextId: "ctx-0",
				contentHash: OLD_HASH,
				decisions: [{ text: "We use Postgres." }],
			},
			{ ...extraction, id: "ext-0", contextId: "ctx-0" },
			{
				...extraction,
				id: "ext-other",
				contextId: "ctx-other",
				dismissedIndexes: [0],
			},
		]);

		await createDecisionCandidatesReadyNotifications({
			extractionId: "ext-0",
		});

		expect(rows[0]?.payload).toEqual({
			projectId: "proj",
			candidateCount: 3,
			fileCount: 2,
		});
	});

	it("writes nothing when the claimed version was replaced and no version is offered yet", async () => {
		const rows = notificationTable();
		recordExtractions([
			{
				...extraction,
				context: {
					contentUpdatedByUserId: "writer",
					contentHash: OLD_HASH,
				},
			},
		]);

		expect(
			await createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).toBe(0);
		expect(rows).toHaveLength(0);
	});

	it("refreshes the winner's row when another extraction's insert got there first", async () => {
		mocks.enabled.mockResolvedValue(new Set(["owner"]));
		mocks.notificationUpdateMany
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });
		mocks.notificationCreate.mockRejectedValue(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);

		expect(
			await createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).toBe(1);
		expect(mocks.notificationUpdateMany).toHaveBeenCalledTimes(2);
	});

	it("still tells the others when one person's write fails", async () => {
		mocks.notificationCreate.mockImplementation(async ({ data }) => {
			if (data.userId === "member") {
				throw new Error("db hiccup");
			}
			return { id: `n-${data.userId}` };
		});

		expect(
			await createDecisionCandidatesReadyNotifications({
				extractionId: "ext-1",
			}),
		).toBe(1);
	});
});
