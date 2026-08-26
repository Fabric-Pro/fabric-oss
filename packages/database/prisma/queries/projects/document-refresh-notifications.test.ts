/**
 * Tests for `createDocumentRefreshNotifications` — the subscriber fan-out the
 * Living-Documents auto-refresh job runs after committing a new version.
 *
 * Mocks the Prisma client, the project-access check, and the
 * notification-preference helper so the fan-out logic (recipient narrowing,
 * dedupe key, agent attribution, never-throws discipline) is exercised in
 * isolation — the same shape as `__tests__/repo-integration-notifications.test.ts`.
 *
 * Run with:
 *   pnpm --filter @repo/database test prisma/queries/projects/document-refresh-notifications.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, createMock, enabledMock, hasAccessMock } = vi.hoisted(
	() => ({
		findManyMock: vi.fn(),
		createMock: vi.fn(),
		enabledMock: vi.fn(),
		hasAccessMock: vi.fn(),
	}),
);

vi.mock("../../client", () => ({
	db: {
		subscription: { findMany: findManyMock },
		notification: { create: createMock },
	},
	NotificationCategory: { SUBSCRIPTION: "SUBSCRIPTION" },
	NotificationType: { DOCUMENT_UPDATED: "DOCUMENT_UPDATED" },
}));

vi.mock("../notification-preferences", () => ({
	getEnabledRecipientsForCategory: enabledMock,
}));

vi.mock("./projects", () => ({
	hasProjectAccess: hasAccessMock,
}));

import {
	createDocumentRefreshNotifications,
	DOCUMENT_REFRESH_AGENT_ID,
	DOCUMENT_REFRESH_AGENT_NAME,
} from "./document-refresh-notifications";

const baseArgs = {
	documentId: "doc-1",
	documentTitle: "Architecture Overview",
	projectId: "proj-1",
	organizationId: "org-1" as string | null,
	link: "projects/proj-1/documents/doc-1",
};

const subscribers = (...userIds: string[]) =>
	userIds.map((userId) => ({ userId }));

const recipientsOf = () =>
	createMock.mock.calls.map((call) => call[0].data.userId).sort();

const rowFor = (userId: string) =>
	createMock.mock.calls.find((call) => call[0].data.userId === userId)?.[0]
		.data;

describe("createDocumentRefreshNotifications", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Defaults: everyone still has project access and no one has muted the
		// SUBSCRIPTION category.
		hasAccessMock.mockResolvedValue(true);
		enabledMock.mockImplementation((ids: string[]) =>
			Promise.resolve(new Set(ids)),
		);
		findManyMock.mockResolvedValue(subscribers("watcher-1", "watcher-2"));
		createMock.mockResolvedValue({});
	});

	it("writes exactly one notification per subscriber", async () => {
		await createDocumentRefreshNotifications(baseArgs);

		expect(createMock).toHaveBeenCalledTimes(2);
		expect(recipientsOf()).toEqual(["watcher-1", "watcher-2"]);
	});

	it("loads subscribers by DOCUMENT subject, cross-tenant (the sweep has no session)", async () => {
		await createDocumentRefreshNotifications(baseArgs);

		expect(findManyMock).toHaveBeenCalledWith({
			where: { subjectType: "DOCUMENT", subjectId: "doc-1" },
			select: { userId: true },
		});
	});

	it("never notifies the refresh agent itself", async () => {
		findManyMock.mockResolvedValue(
			subscribers("watcher-1", DOCUMENT_REFRESH_AGENT_ID),
		);

		await createDocumentRefreshNotifications(baseArgs);

		expect(recipientsOf()).toEqual(["watcher-1"]);
		expect(recipientsOf()).not.toContain(DOCUMENT_REFRESH_AGENT_ID);
	});

	it("collapses a duplicated subscriber row to a single notification", async () => {
		findManyMock.mockResolvedValue(
			subscribers("watcher-1", "watcher-1", "watcher-2"),
		);

		await createDocumentRefreshNotifications(baseArgs);

		expect(recipientsOf()).toEqual(["watcher-1", "watcher-2"]);
	});

	it("names the refresh agent as the actor, not 'a teammate'", async () => {
		await createDocumentRefreshNotifications(baseArgs);

		const row = rowFor("watcher-1");
		expect(row.title).toBe(
			`${DOCUMENT_REFRESH_AGENT_NAME} updated Architecture Overview`,
		);
		expect(DOCUMENT_REFRESH_AGENT_NAME).toBe("Fabric Refresh Agent");
		expect(row.title).not.toMatch(/teammate/i);
		// The FK column stays null (the agent has no `user` row); the sentinel
		// travels in the payload instead.
		expect(row.actorUserId).toBeUndefined();
		expect(row.payload.actorUserId).toBe(DOCUMENT_REFRESH_AGENT_ID);
	});

	describe("proposed vs committed", () => {
		it("says the agent PROPOSED an update when it is waiting for a human", async () => {
			// The default mode. The document has NOT changed — telling a watcher it
			// was "updated" would send them looking for an edit that is not there.
			await createDocumentRefreshNotifications({
				...baseArgs,
				kind: "proposed",
			});

			expect(rowFor("watcher-1").title).toBe(
				`${DOCUMENT_REFRESH_AGENT_NAME} proposed an update to Architecture Overview`,
			);
		});

		it("says the agent UPDATED the document when it applied the change", async () => {
			await createDocumentRefreshNotifications({
				...baseArgs,
				kind: "committed",
			});

			expect(rowFor("watcher-1").title).toBe(
				`${DOCUMENT_REFRESH_AGENT_NAME} updated Architecture Overview`,
			);
		});
	});

	it("writes the SUBSCRIPTION/DOCUMENT_UPDATED shape the inbox already renders", async () => {
		await createDocumentRefreshNotifications({
			...baseArgs,
			summary: "Reflected the new auth flow from the latest ADR.",
		});

		expect(rowFor("watcher-1")).toMatchObject({
			userId: "watcher-1",
			organizationId: "org-1",
			type: "DOCUMENT_UPDATED",
			category: "SUBSCRIPTION",
			snippet: "Reflected the new auth flow from the latest ADR.",
			link: "projects/proj-1/documents/doc-1",
			projectId: "proj-1",
			documentId: "doc-1",
			payload: {
				subjectType: "DOCUMENT",
				subjectId: "doc-1",
				projectId: "proj-1",
				actorUserId: DOCUMENT_REFRESH_AGENT_ID,
				changeKind: "content",
			},
		});
	});

	it("carries a null organizationId through for a personal-project document", async () => {
		await createDocumentRefreshNotifications({
			...baseArgs,
			organizationId: null,
		});

		expect(rowFor("watcher-1").organizationId).toBeNull();
	});

	it("skips a subscriber who muted the SUBSCRIPTION category", async () => {
		enabledMock.mockImplementation((ids: string[]) =>
			Promise.resolve(new Set(ids.filter((id) => id !== "watcher-2"))),
		);

		await createDocumentRefreshNotifications(baseArgs);

		expect(enabledMock).toHaveBeenCalledWith(
			["watcher-1", "watcher-2"],
			"SUBSCRIPTION",
		);
		expect(recipientsOf()).toEqual(["watcher-1"]);
	});

	it("writes nothing when every subscriber muted the SUBSCRIPTION category", async () => {
		enabledMock.mockResolvedValue(new Set<string>());

		await createDocumentRefreshNotifications(baseArgs);

		expect(createMock).not.toHaveBeenCalled();
	});

	it("skips a subscriber who lost access to the project (stale subscription)", async () => {
		hasAccessMock.mockImplementation(
			async (_projectId: string, userId: string) =>
				userId !== "watcher-2",
		);

		await createDocumentRefreshNotifications(baseArgs);

		expect(recipientsOf()).toEqual(["watcher-1"]);
		// The dropped subscriber is not even offered to the preference filter.
		expect(enabledMock).toHaveBeenCalledWith(["watcher-1"], "SUBSCRIPTION");
	});

	it("writes nothing when no subscriber still has project access", async () => {
		hasAccessMock.mockResolvedValue(false);

		await createDocumentRefreshNotifications(baseArgs);

		expect(createMock).not.toHaveBeenCalled();
		expect(enabledMock).not.toHaveBeenCalled();
	});

	it("writes nothing — and runs no access check — when the document has no subscribers", async () => {
		findManyMock.mockResolvedValue([]);

		await createDocumentRefreshNotifications(baseArgs);

		expect(hasAccessMock).not.toHaveBeenCalled();
		expect(createMock).not.toHaveBeenCalled();
	});

	it("keys the dedupe per (document, recipient) so the fan-out does not self-collide", async () => {
		await createDocumentRefreshNotifications(baseArgs);

		const dedupeKeys = createMock.mock.calls
			.map((call) => call[0].data.dedupeKey)
			.sort();
		expect(dedupeKeys).toEqual([
			"sub:DOCUMENT:doc-1:watcher-1:ai",
			"sub:DOCUMENT:doc-1:watcher-2:ai",
		]);
	});

	describe("the :ai dedupe bucket", () => {
		/** The key a HUMAN document update writes (`fanOut.subscriptionUpdate`). */
		const humanKeyFor = (userId: string) => `sub:DOCUMENT:doc-1:${userId}`;

		it("never collides with a human edit's dedupe key", async () => {
			// THE load-bearing assertion of this file. The live-unread partial unique
			// index coalesces on dedupeKey, so if the refresh reused the human key,
			// "the AI rewrote your PRD" would be silently swallowed into an unread
			// "Alice updated your PRD" from the day before — and the one notification
			// this entire feature exists to send is exactly the one that vanishes.
			await createDocumentRefreshNotifications(baseArgs);

			const keys = createMock.mock.calls.map(
				(call) => call[0].data.dedupeKey,
			);
			for (const key of keys) {
				expect(key.endsWith(":ai")).toBe(true);
			}
			expect(keys).not.toContain(humanKeyFor("watcher-1"));
			expect(keys).not.toContain(humanKeyFor("watcher-2"));
		});

		it("survives an unread human edit sitting in the inbox for the same document", async () => {
			// Model the index: the human's row already occupies its key. The AI's
			// write must land in its OWN bucket rather than being rejected as a
			// duplicate of it.
			const rows = new Set<string>([
				humanKeyFor("watcher-1"),
				humanKeyFor("watcher-2"),
			]);
			createMock.mockImplementation(
				async ({ data }: { data: { dedupeKey: string } }) => {
					if (rows.has(data.dedupeKey)) {
						throw Object.assign(new Error("Unique constraint"), {
							code: "P2002",
						});
					}
					rows.add(data.dedupeKey);
					return {};
				},
			);

			await createDocumentRefreshNotifications(baseArgs);

			// Both AI rows were written — neither was coalesced away by the human's.
			expect(rows).toEqual(
				new Set([
					humanKeyFor("watcher-1"),
					humanKeyFor("watcher-2"),
					"sub:DOCUMENT:doc-1:watcher-1:ai",
					"sub:DOCUMENT:doc-1:watcher-2:ai",
				]),
			);
		});
	});

	it("coalesces a second refresh of the same document inside the dedupe window", async () => {
		// The live-unread partial unique index rejects the second write with
		// P2002 — the existing unread row stands, and the writer still resolves.
		const rows = new Set<string>();
		createMock.mockImplementation(
			async ({ data }: { data: { dedupeKey: string } }) => {
				if (rows.has(data.dedupeKey)) {
					throw Object.assign(new Error("Unique constraint"), {
						code: "P2002",
					});
				}
				rows.add(data.dedupeKey);
				return {};
			},
		);

		await expect(
			createDocumentRefreshNotifications(baseArgs),
		).resolves.toBeUndefined();
		await expect(
			createDocumentRefreshNotifications(baseArgs),
		).resolves.toBeUndefined();

		// Four attempted writes (two recipients × two refreshes), but only two
		// rows survive the dedupe key — one unread notification per subscriber.
		expect(createMock).toHaveBeenCalledTimes(4);
		expect(rows).toEqual(
			new Set([
				"sub:DOCUMENT:doc-1:watcher-1:ai",
				"sub:DOCUMENT:doc-1:watcher-2:ai",
			]),
		);
	});

	it("swallows and logs a recipient-resolution failure — the caller is unaffected", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		findManyMock.mockRejectedValue(new Error("db is down"));

		await expect(
			createDocumentRefreshNotifications(baseArgs),
		).resolves.toBeUndefined();

		expect(createMock).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[DocumentRefreshNotification] subscriber dispatch failed",
			{ documentId: "doc-1", projectId: "proj-1" },
			expect.any(Error),
		);
		warn.mockRestore();
	});

	it("swallows and logs a failed write without dropping the other recipients", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		createMock.mockImplementation(
			async ({ data }: { data: { userId: string } }) => {
				if (data.userId === "watcher-1") {
					throw new Error("write failed");
				}
				return {};
			},
		);

		await expect(
			createDocumentRefreshNotifications(baseArgs),
		).resolves.toBeUndefined();

		expect(createMock).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledWith(
			"[DocumentRefreshNotification] notification write failed",
			{ documentId: "doc-1", recipientUserId: "watcher-1" },
			expect.any(Error),
		);
		warn.mockRestore();
	});
});
