/**
 * Verifies the notification-service writer:
 *  - skips self-notifications
 *  - coalesces duplicates via the partial-unique index (P2002 → updateMany)
 *  - persists XOR-scoped (userId, organizationId)
 *  - rejects malformed payloads via the Zod schemas
 */

import { NotificationCategory, NotificationType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory (also hoisted) can reference it. The real
// `getNotificationPreferences` binds `db` from `@repo/database/prisma/client`
// (a different module than the mocked `@repo/database` barrel), so we mock the
// function itself to control the write-time preference filter. `isCategoryEnabled`
// and `CATEGORY_TO_TOGGLE` stay real (pure functions) via `...actual`.
const { getPrefsMock } = vi.hoisted(() => ({ getPrefsMock: vi.fn() }));

const ALL_ENABLED = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
};

vi.mock("@repo/database", async () => {
	const actual = (await vi.importActual("@repo/database")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		getNotificationPreferences: getPrefsMock,
		db: {
			notification: {
				findFirst: vi.fn(),
				create: vi.fn(),
				updateMany: vi.fn(),
			},
		},
	};
});

function makeP2002(): Error & { code: string } {
	const err = new Error("unique violation") as Error & { code: string };
	err.code = "P2002";
	return err;
}

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../notification-cache", () => ({
	invalidateUnreadCount: vi.fn().mockResolvedValue(undefined),
	getCachedUnreadCount: vi.fn().mockResolvedValue(null),
	setCachedUnreadCount: vi.fn().mockResolvedValue(undefined),
}));

async function loadModule() {
	return await import("../notification-service");
}

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		notification: {
			findFirst: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
			updateMany: ReturnType<typeof vi.fn>;
		};
	};
}

beforeEach(async () => {
	const db = await getMockDb();
	db.notification.findFirst.mockReset();
	db.notification.create.mockReset();
	db.notification.updateMany.mockReset();
	getPrefsMock.mockReset();
	// Default: all categories enabled (opt-out model — missing row = all on).
	getPrefsMock.mockResolvedValue({ ...ALL_ENABLED });
});

const baseArgs = {
	userId: "user-bob",
	organizationId: "org-A",
	type: NotificationType.STORY_MENTION,
	category: NotificationCategory.MENTION,
	title: "@alice mentioned you",
	snippet: "Take a look at this",
	link: "projects/p1/stories/s1#comment-c1",
	source: {
		projectId: "p1",
		storyId: "s1",
		commentId: "c1",
		actorUserId: "user-alice",
	},
	payload: {
		commentId: "c1",
		storyId: "s1",
		projectId: "p1",
		mentionedByUserId: "user-alice",
		snippet: "Take a look at this",
	},
};

describe("createNotification", () => {
	it("returns null without writing when actor === recipient (self-skip)", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();

		const result = await createNotification({
			...baseArgs,
			userId: "user-alice", // matches actorUserId
		});

		expect(result).toBeNull();
		expect(db.notification.create).not.toHaveBeenCalled();
		expect(db.notification.updateMany).not.toHaveBeenCalled();
	});

	it("suppresses the row when the recipient disabled the category (write-time filter)", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		// Recipient has the MENTION-mapped toggle (`mentions`) turned off.
		getPrefsMock.mockResolvedValue({ ...ALL_ENABLED, mentions: false });

		const result = await createNotification({ ...baseArgs });

		expect(result).toEqual({
			skipped: true,
			reason: "preference-disabled",
		});
		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("never suppresses always-on categories (SYSTEM) and skips the preference lookup", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "sys1" });

		await createNotification({
			...baseArgs,
			type: NotificationType.SYSTEM_INCIDENT,
			category: NotificationCategory.SYSTEM,
			payload: {
				incidentId: "inc1",
				severity: "sev3",
				summary: "x",
				link: "/app/admin/monitoring",
				startedAt: new Date().toISOString(),
			},
		});

		// Always-on categories are not in CATEGORY_TO_TOGGLE → no lookup at all.
		expect(getPrefsMock).not.toHaveBeenCalled();
		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("creates a row when no dedup conflict occurs", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n1" });

		await createNotification({
			...baseArgs,
			dedupeKey: "mention:c1:user-bob",
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(db.notification.updateMany).not.toHaveBeenCalled();
		const call = db.notification.create.mock.calls[0][0];
		expect(call.data.userId).toBe("user-bob");
		expect(call.data.organizationId).toBe("org-A");
	});

	it("coalesces into existing unread row on P2002 unique-violation", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(makeP2002());
		db.notification.updateMany.mockResolvedValue({ count: 1 });
		db.notification.findFirst.mockResolvedValue({ id: "existing" });

		const result = await createNotification({
			...baseArgs,
			dedupeKey: "mention:c1:user-bob",
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(db.notification.updateMany).toHaveBeenCalledTimes(1);
		const updateWhere = db.notification.updateMany.mock.calls[0][0].where;
		expect(updateWhere.userId).toBe("user-bob");
		expect(updateWhere.dedupeKey).toBe("mention:c1:user-bob");
		expect(updateWhere.readAt).toBeNull();
		expect(updateWhere.archivedAt).toBeNull();
		// The findFirst here is the POST-P2002 read-back path (no unreadOnly policy
		// is set in this test). It must also filter archivedAt: null to stay
		// consistent with the new partial-live index.
		const findWhere = db.notification.findFirst.mock.calls[0][0].where;
		expect(findWhere.userId).toBe("user-bob");
		expect(findWhere.dedupeKey).toBe("mention:c1:user-bob");
		expect(findWhere.readAt).toBeNull();
		expect(findWhere.archivedAt).toBeNull();
		expect(result).toEqual({ id: "existing" });
	});

	it("re-throws non-P2002 errors", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(new Error("connection lost"));

		await expect(
			createNotification({
				...baseArgs,
				dedupeKey: "mention:c1:user-bob",
			}),
		).rejects.toThrow("connection lost");
		expect(db.notification.updateMany).not.toHaveBeenCalled();
	});

	it("does not run updateMany on P2002 when no dedupeKey was supplied", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(makeP2002());

		await expect(createNotification({ ...baseArgs })).rejects.toMatchObject(
			{ code: "P2002" },
		);
		expect(db.notification.updateMany).not.toHaveBeenCalled();
	});

	it("persists organizationId=null for personal context (XOR)", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n2" });

		await createNotification({ ...baseArgs, organizationId: null });

		const call = db.notification.create.mock.calls[0][0];
		expect(call.data.organizationId).toBeNull();
	});

	it("rejects payloads that do not match the type schema", async () => {
		const { createNotification } = await loadModule();
		// STORY_MENTION requires commentId + projectId + mentionedByUserId.
		await expect(
			createNotification({
				...baseArgs,
				payload: { snippet: "incomplete" } as unknown as Record<
					string,
					unknown
				>,
			}),
		).rejects.toThrow();
	});

	it("truncates snippets longer than 280 chars", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n4" });

		await createNotification({ ...baseArgs, snippet: "x".repeat(500) });

		const call = db.notification.create.mock.calls[0][0];
		expect(call.data.snippet.length).toBeLessThanOrEqual(280);
		expect(call.data.snippet.endsWith("…")).toBe(true);
	});
});

describe("createNotification — dedupePolicy: unreadOnly", () => {
	it("suppresses when an unread notification with the same key exists", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		// Simulate an existing unread+live notification
		db.notification.findFirst.mockResolvedValue({ id: "existing-n1" });

		const result = await createNotification({
			...baseArgs,
			dedupeKey: "mention:c1:user-bob",
			dedupePolicy: "unreadOnly",
		});

		expect(result).toEqual({ skipped: true, reason: "deduped-unread" });
		// Pre-query must scope to the correct user
		expect(db.notification.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-bob",
					dedupeKey: "mention:c1:user-bob",
					readAt: null,
					archivedAt: null,
				}),
			}),
		);
		// Must not attempt to create or coalesce
		expect(db.notification.create).not.toHaveBeenCalled();
		expect(db.notification.updateMany).not.toHaveBeenCalled();
	});

	it("queries for live unread rows using both readAt and archivedAt filters", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		db.notification.findFirst.mockResolvedValue(null);
		db.notification.create.mockResolvedValue({ id: "new-n2" });

		await createNotification({
			...baseArgs,
			dedupeKey: "test-archive-filter",
			dedupePolicy: "unreadOnly",
		});

		expect(db.notification.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-bob",
					dedupeKey: "test-archive-filter",
					readAt: null,
					archivedAt: null,
				}),
			}),
		);
	});

	it("inserts a new notification when no live unread row exists (prior was read or archived)", async () => {
		const { createNotification } = await loadModule();
		const db = await getMockDb();
		// findFirst returns null → no live unread match → falls through to INSERT
		db.notification.findFirst.mockResolvedValue(null);
		db.notification.create.mockResolvedValue({ id: "new-n3" });

		const result = await createNotification({
			...baseArgs,
			dedupeKey: "mention:c1:user-bob",
			dedupePolicy: "unreadOnly",
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		// Result is the inserted notification, not the skipped sentinel.
		expect(result).not.toMatchObject({ skipped: true });
		expect(result).toEqual({ id: "new-n3" });
	});
});

describe("fanOut.mention", () => {
	it("skips actor from recipient list and dedupes recipients", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n5" });

		await fanOut.mention({
			recipientUserIds: ["user-bob", "user-bob", "user-alice"],
			commentId: "c1",
			projectId: "p1",
			organizationId: "org-A",
			actorUserId: "user-alice",
			actorName: "Alice",
			target: { storyId: "s1" },
			link: "projects/p1/stories/s1#comment-c1",
			snippet: "hi",
		});

		// Bob written once (deduped), alice skipped (self).
		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(db.notification.create.mock.calls[0][0].data.userId).toBe(
			"user-bob",
		);
	});

	it("swallows DB errors so the writer is never blocked", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(new Error("db down"));

		await expect(
			fanOut.mention({
				recipientUserIds: ["user-bob"],
				commentId: "c1",
				projectId: "p1",
				organizationId: "org-A",
				actorUserId: "user-alice",
				actorName: "Alice",
				target: { storyId: "s1" },
				link: "x",
				snippet: "hi",
			}),
		).resolves.toBeUndefined();
	});
});

describe("fanOut.documentMention", () => {
	it("creates one notification per recipient with deep-link", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_d1" });

		await fanOut.documentMention({
			recipients: [
				{ userId: "u_1", anchorId: "m_a" },
				{ userId: "u_2", anchorId: "m_b" },
			],
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "actor_1",
			actorName: "Alice",
			documentTitle: "PRD",
			link: "/app/acme/projects/proj_1/documents/doc_1",
			snippetByAnchor: { m_a: "Please review", m_b: "see section 3" },
		});

		expect(db.notification.create).toHaveBeenCalledTimes(2);
		const calls = db.notification.create.mock.calls.map((c) => c[0].data);
		const byUser = Object.fromEntries(calls.map((d) => [d.userId, d]));
		expect(byUser.u_1.link).toBe(
			"/app/acme/projects/proj_1/documents/doc_1#m-a",
		);
		expect(byUser.u_1.type).toBe("DOCUMENT_MENTION");
		expect(byUser.u_1.category).toBe("MENTION");
		expect(byUser.u_1.dedupeKey).toBe("docmention:doc_1:u_1");
		expect(byUser.u_2.link).toBe(
			"/app/acme/projects/proj_1/documents/doc_1#m-b",
		);
	});

	it("self-skips when actor mentions themselves", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_skip" });

		await fanOut.documentMention({
			recipients: [{ userId: "actor_1", anchorId: "m_a" }],
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "actor_1",
			actorName: "Alice",
			documentTitle: "PRD",
			link: "/app/acme/projects/proj_1/documents/doc_1",
			snippetByAnchor: { m_a: "" },
		});

		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("falls back to documentTitle as snippet when per-anchor snippet is empty", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_fb" });

		await fanOut.documentMention({
			recipients: [{ userId: "u_1", anchorId: "m_a" }],
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "actor_1",
			actorName: "Alice",
			documentTitle: "PRD",
			link: "/app/acme/projects/proj_1/documents/doc_1",
			snippetByAnchor: { m_a: "" },
		});

		const call = db.notification.create.mock.calls[0][0];
		expect(call.data.snippet).toBe("PRD");
	});

	it("collapses duplicate recipients (same userId) to a single notification", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_dedup" });

		await fanOut.documentMention({
			recipients: [
				{ userId: "u_1", anchorId: "m_a" },
				{ userId: "u_1", anchorId: "m_b" },
			],
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "actor_1",
			actorName: "Alice",
			documentTitle: "PRD",
			link: "/app/acme/projects/proj_1/documents/doc_1",
			snippetByAnchor: { m_a: "Please review", m_b: "see section 3" },
		});

		// Same user mentioned twice: only one notification, anchored at the
		// FIRST occurrence so the deep-link scrolls to the earliest mention.
		expect(db.notification.create).toHaveBeenCalledTimes(1);
		const call = db.notification.create.mock.calls[0][0].data;
		expect(call.userId).toBe("u_1");
		expect(call.link).toBe("/app/acme/projects/proj_1/documents/doc_1#m-a");
	});

	it("passes dedupePolicy: unreadOnly to createNotification (pre-query path)", async () => {
		// Test A: verify fanOut.documentMention propagates dedupePolicy: "unreadOnly"
		// to createNotification. The observable effect is that db.notification.findFirst
		// is called for a pre-INSERT dedup check (which only happens with unreadOnly policy).
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		// Simulate no existing unread row so createNotification falls through to INSERT.
		db.notification.findFirst.mockResolvedValue(null);
		db.notification.create.mockResolvedValue({ id: "n_unread_policy" });

		await fanOut.documentMention({
			recipients: [{ userId: "u_1", anchorId: "m_a" }],
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "actor_1",
			actorName: "Alice",
			documentTitle: "PRD",
			link: "/app/acme/projects/proj_1/documents/doc_1",
			snippetByAnchor: { m_a: "see intro" },
		});

		// The unreadOnly policy triggers a pre-query via db.notification.findFirst
		// BEFORE the INSERT. If the policy is missing, findFirst is never called here.
		expect(db.notification.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u_1",
					dedupeKey: "docmention:doc_1:u_1",
					readAt: null,
					archivedAt: null,
				}),
			}),
		);
		// Falls through to insert since no prior unread row exists.
		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("suppresses duplicate when an unread doc-mention already exists (unreadOnly policy)", async () => {
		// When fanOut.documentMention is called again for the same document+recipient
		// and an unread notification already exists, it must short-circuit.
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		// Simulate an existing unread row for this recipient+key.
		db.notification.findFirst.mockResolvedValue({
			id: "existing_docmention",
		});

		await fanOut.documentMention({
			recipients: [{ userId: "u_1", anchorId: "m_a" }],
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_1",
			actorUserId: "actor_1",
			actorName: "Alice",
			documentTitle: "PRD",
			link: "/app/acme/projects/proj_1/documents/doc_1",
			snippetByAnchor: { m_a: "see intro" },
		});

		// With unreadOnly policy active, no INSERT should occur.
		expect(db.notification.create).not.toHaveBeenCalled();
		expect(db.notification.updateMany).not.toHaveBeenCalled();
	});
});

describe("fanOut.storyStatusChanged", () => {
	const baseStatusArgs = {
		storyId: "s1",
		storyTitle: "Login flow",
		projectId: "p1",
		organizationId: null,
		actorUserId: "u-actor",
		actorName: "Ada",
		previousStatusId: "stA",
		previousStatusName: "In Progress",
		statusId: "stB",
		statusName: "Done",
		isFinal: true,
		requiresApproval: false,
		recipientUserIds: ["u-assignee", "u-owner"],
		link: "projects/p1/stories/s1",
	};

	it("emits one notification per recipient when target status is final", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_st1" });

		await fanOut.storyStatusChanged({
			...baseStatusArgs,
			recipientUserIds: ["u-assignee", "u-owner", "u-actor"],
		});

		// actor is filtered out; the remaining two recipients each get a row.
		expect(db.notification.create).toHaveBeenCalledTimes(2);
		const titles = db.notification.create.mock.calls.map(
			(c) => c[0].data.title,
		);
		expect(titles[0]).toContain("Done");
		expect(titles[0]).toContain("Ada");
		const snippets = db.notification.create.mock.calls.map(
			(c) => c[0].data.snippet,
		);
		expect(snippets[0]).toContain("In Progress");
		expect(snippets[0]).toContain("Done");
		const dedupeKeys = db.notification.create.mock.calls.map(
			(c) => c[0].data.dedupeKey,
		);
		expect(dedupeKeys.every((k) => k === "status:s1:stB")).toBe(true);
	});

	it("skips when target status is not final, approval-required, or named blocked", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();

		await fanOut.storyStatusChanged({
			...baseStatusArgs,
			statusName: "In Progress",
			isFinal: false,
			requiresApproval: false,
		});

		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("emits when status name matches /blocked/i even without flags", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_st_blk" });

		await fanOut.storyStatusChanged({
			...baseStatusArgs,
			statusName: "Blocked",
			isFinal: false,
			requiresApproval: false,
			recipientUserIds: ["u-assignee"],
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("emits when status requires approval even if not final", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_st_apr" });

		await fanOut.storyStatusChanged({
			...baseStatusArgs,
			statusName: "Awaiting Review",
			isFinal: false,
			requiresApproval: true,
			recipientUserIds: ["u-assignee"],
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("suppresses notifications addressed to the actor", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_st_self" });

		await fanOut.storyStatusChanged({
			...baseStatusArgs,
			recipientUserIds: ["u-actor"],
		});

		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("swallows DB errors so the writer is never blocked", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(new Error("db down"));

		await expect(
			fanOut.storyStatusChanged({
				...baseStatusArgs,
				recipientUserIds: ["u-assignee"],
			}),
		).resolves.toBeUndefined();
	});
});

describe("fanOut.pmSyncConflict", () => {
	const baseConflictArgs = {
		storyId: "s1",
		storyTitle: "Login",
		projectId: "p1",
		organizationId: null,
		actorUserId: null,
		pendingStateChangeId: "psc1",
		previousState: "Active",
		newState: "Done",
		recipientUserIds: ["u1", "u1", "u2"],
		link: "projects/p1/stories/s1?review=conflict",
	};

	it("emits to deduplicated recipients", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_pmc1" });

		await fanOut.pmSyncConflict(baseConflictArgs);

		expect(db.notification.create).toHaveBeenCalledTimes(2);
		const dedupeKeys = db.notification.create.mock.calls.map(
			(c) => c[0].data.dedupeKey,
		);
		expect(dedupeKeys.every((k) => k === "pmConflict:s1:psc1")).toBe(true);
	});

	it("excludes the actor when one is present", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_pmc2" });

		await fanOut.pmSyncConflict({
			...baseConflictArgs,
			actorUserId: "u1",
			recipientUserIds: ["u1", "u2"],
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(db.notification.create.mock.calls[0][0].data.userId).toBe("u2");
	});

	it("uses the conflict link and title shape", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_pmc3" });

		await fanOut.pmSyncConflict({
			...baseConflictArgs,
			recipientUserIds: ["u1"],
		});

		const call = db.notification.create.mock.calls[0][0].data;
		expect(call.title).toBe('Conflict detected on "Login"');
		expect(call.link).toBe("projects/p1/stories/s1?review=conflict");
		expect(call.type).toBe("PM_SYNC_CONFLICT");
		expect(call.category).toBe("PROJECT");
	});

	it("swallows DB errors so the writer is never blocked", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(new Error("db down"));

		await expect(
			fanOut.pmSyncConflict({
				...baseConflictArgs,
				recipientUserIds: ["u2"],
			}),
		).resolves.toBeUndefined();
	});
});

describe("fanOut.agentReplyReady", () => {
	const baseAgentReplyArgs = {
		runId: "r1",
		recipientUserId: "u-initiator",
		organizationId: null as string | null,
		agentName: "Code Reviewer",
		finalMessage: "Looks good — shipping it.",
		link: "projects/p1/agents/r1",
		projectId: "p1",
	};

	it("writes one notification with the expected title, snippet, dedupeKey", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_ar1" });

		await fanOut.agentReplyReady(baseAgentReplyArgs);

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.userId).toBe("u-initiator");
		expect(data.title).toBe("Code Reviewer finished a reply");
		expect(data.dedupeKey).toBe("agentReply:r1");
		expect(data.type).toBe("AGENT_REPLY_READY");
		expect(data.category).toBe("AGENT");
		expect(data.link).toBe("projects/p1/agents/r1");
		// Snippet is the collapsed final message (within the 140 budget here).
		expect(data.snippet).toBe("Looks good — shipping it.");
		// The payload must carry the runId in `commentId` (existing schema).
		expect(data.payload.commentId).toBe("r1");
		expect(data.payload.projectId).toBe("p1");
		expect(data.payload.snippet).toBe("Looks good — shipping it.");
	});

	it("truncates the snippet to 140 chars and collapses whitespace", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_ar2" });

		const longMessage = `   first   line\n\n\t  second   line ${"x".repeat(500)}`;
		await fanOut.agentReplyReady({
			...baseAgentReplyArgs,
			finalMessage: longMessage,
		});

		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.snippet.length).toBeLessThanOrEqual(140);
		// Whitespace collapsed at the head of the message.
		expect(data.snippet.startsWith("first line second line ")).toBe(true);
	});

	it("skips when isUserPresent returns true (presence suppression)", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();

		await fanOut.agentReplyReady({
			...baseAgentReplyArgs,
			isUserPresent: () => true,
		});

		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("fires when isUserPresent throws — presence errors are non-fatal", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockResolvedValue({ id: "n_ar3" });

		await fanOut.agentReplyReady({
			...baseAgentReplyArgs,
			isUserPresent: () => {
				throw new Error("presence service down");
			},
		});

		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("swallows DB errors so the agent run is never blocked", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(new Error("db down"));

		await expect(
			fanOut.agentReplyReady(baseAgentReplyArgs),
		).resolves.toBeUndefined();
	});
});
