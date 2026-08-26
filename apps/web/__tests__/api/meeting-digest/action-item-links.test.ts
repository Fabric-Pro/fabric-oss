import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findFirstActionItem,
	findFirstStory,
	findFirstTranscript,
	hasAccess,
	isFeatureEnabled,
	upsertPersonLink,
	dismissActionItemLink,
	workflowStart,
} = vi.hoisted(() => ({
	findFirstActionItem: vi.fn(),
	findFirstStory: vi.fn(),
	findFirstTranscript: vi.fn(),
	hasAccess: vi.fn(),
	isFeatureEnabled: vi.fn(),
	upsertPersonLink: vi.fn(),
	dismissActionItemLink: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		hasProjectAccess: hasAccess,
		isFeatureEnabled,
		upsertPersonLink,
		dismissActionItemLink,
		db: {
			...(actual.db as object),
			projectMeetingActionItem: { findFirst: findFirstActionItem },
			userStory: { findFirst: findFirstStory },
			projectMeetingTranscript: { findFirst: findFirstTranscript },
		},
	};
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: workflowStart } }),
}));

type Handler = (a: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;

/**
 * Handlers are keyed by their route path, not by import order: several modules
 * imported here register a handler (get-meeting does too), so positional
 * indexing would silently bind the wrong procedure the moment an import moves.
 */
const { handlers, routeState } = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	routeState: { path: "" },
}));

vi.mock("../../../../../packages/api/orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: (config: { path?: string }) => {
			routeState.path = config?.path ?? "";
			return chainable;
		},
		input: () => chainable,
		output: () => chainable,
		handler: (fn: Handler) => {
			handlers.set(routeState.path, fn);
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

import {
	groupLinksByItemKey,
	toActionItemPayload,
} from "@repo/api/modules/projects/procedures/meeting-digest/get-meeting";
import { shouldStartActionItemLinking } from "@repo/api/modules/projects/procedures/meeting-digest/link-action-items";
import { computeActionItemKey } from "@repo/database";
import "@repo/api/modules/projects/procedures/meeting-digest/manage-action-item-links";

function handlerFor(path: string): Handler {
	const fn = handlers.get(path);
	if (!fn) {
		throw new Error(
			`No handler registered for ${path}. Registered: ${[...handlers.keys()].join(", ")}`,
		);
	}
	return fn;
}

const addLink = handlerFor(
	"/projects/{projectId}/meeting-digest/action-items/{actionItemId}/links",
);
const removeLink = handlerFor(
	"/projects/{projectId}/meeting-digest/action-item-links/{linkId}/remove",
);

const context = { user: { id: "u1" }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	isFeatureEnabled.mockResolvedValue(true);
	hasAccess.mockResolvedValue(true);
});

describe("shouldStartActionItemLinking", () => {
	it("starts when the meeting has never been matched", () => {
		expect(
			shouldStartActionItemLinking({
				actionItemsLinkVersion: null,
				actionItemCount: 3,
			}),
		).toBe(true);
	});

	it("skips a meeting already matched at the current version", () => {
		expect(
			shouldStartActionItemLinking({
				actionItemsLinkVersion: 1,
				actionItemCount: 3,
			}),
		).toBe(false);
	});

	it("starts again when the link version moved on", () => {
		expect(
			shouldStartActionItemLinking({
				actionItemsLinkVersion: 0,
				actionItemCount: 3,
			}),
		).toBe(true);
	});

	it("never starts for a meeting with no action items, even with force", () => {
		expect(
			shouldStartActionItemLinking(
				{ actionItemsLinkVersion: null, actionItemCount: 0 },
				{ force: true },
			),
		).toBe(false);
	});

	it("re-runs a fresh meeting when forced", () => {
		expect(
			shouldStartActionItemLinking(
				{ actionItemsLinkVersion: 1, actionItemCount: 2 },
				{ force: true },
			),
		).toBe(true);
	});
});

describe("groupLinksByItemKey", () => {
	const link = (itemKey: string, id: string) =>
		({
			id,
			itemKey,
			storyId: `s-${id}`,
			origin: "AUTO",
			confidence: 0.9,
			similarity: 0.8,
			reasoning: null,
			identifier: "F-1",
			title: "T",
			statusName: null,
			isDone: false,
		}) as never;

	it("returns an empty map for no links (FR8 — nothing to render)", () => {
		expect(groupLinksByItemKey([])).toEqual({});
	});

	it("groups every link on the same item together (AC3)", () => {
		const grouped = groupLinksByItemKey([
			link("key-a", "1"),
			link("key-a", "2"),
			link("key-b", "3"),
		]);
		expect(grouped["key-a"]).toHaveLength(2);
		expect(grouped["key-b"]).toHaveLength(1);
	});
});

describe("addActionItemLink", () => {
	const item = {
		text: "Ship the digest",
		transcriptId: "tr-cuid",
		transcript: { userId: null, organizationId: "org-1" },
	};

	it("is invisible when the feature flag is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(
			addLink({
				input: { projectId: "p1", actionItemId: "a1", storyId: "s1" },
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});

	it("rejects a caller without project access", async () => {
		hasAccess.mockResolvedValue(false);

		await expect(
			addLink({
				input: { projectId: "p1", actionItemId: "a1", storyId: "s1" },
				context,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("creates a MANUAL link and mirrors the transcript's tenancy", async () => {
		findFirstActionItem.mockResolvedValue(item);
		findFirstStory.mockResolvedValue({ id: "s1" });
		upsertPersonLink.mockResolvedValue({ id: "link-1" });

		const result = await addLink({
			input: { projectId: "p1", actionItemId: "a1", storyId: "s1" },
			context,
		});

		expect(result).toEqual({ linkId: "link-1" });
		expect(upsertPersonLink).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptId: "tr-cuid",
				projectId: "p1",
				storyId: "s1",
				origin: "MANUAL",
				createdById: "u1",
				itemTextSnapshot: "Ship the digest",
				// Copied from the parent transcript, NOT derived from the session.
				userId: null,
				organizationId: "org-1",
			}),
		);
	});

	it("scopes the action item lookup to the project", async () => {
		findFirstActionItem.mockResolvedValue(item);
		findFirstStory.mockResolvedValue({ id: "s1" });
		upsertPersonLink.mockResolvedValue({ id: "link-1" });

		await addLink({
			input: { projectId: "p1", actionItemId: "a1", storyId: "s1" },
			context,
		});

		expect(findFirstActionItem).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "a1", transcript: { projectId: "p1" } },
			}),
		);
	});

	it("refuses to link a work item from another project", async () => {
		findFirstActionItem.mockResolvedValue(item);
		findFirstStory.mockResolvedValue(null);

		await expect(
			addLink({
				input: {
					projectId: "p1",
					actionItemId: "a1",
					storyId: "other",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(upsertPersonLink).not.toHaveBeenCalled();
	});

	it("scopes the work item lookup to the project", async () => {
		findFirstActionItem.mockResolvedValue(item);
		findFirstStory.mockResolvedValue({ id: "s1" });
		upsertPersonLink.mockResolvedValue({ id: "link-1" });

		await addLink({
			input: { projectId: "p1", actionItemId: "a1", storyId: "s1" },
			context,
		});

		expect(findFirstStory).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "s1", projectId: "p1" } }),
		);
	});
});

describe("removeActionItemLink", () => {
	it("is invisible when the feature flag is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(
			removeLink({ input: { projectId: "p1", linkId: "l1" }, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dismissActionItemLink).not.toHaveBeenCalled();
	});

	it("tombstones the link, scoped by project (FR3)", async () => {
		dismissActionItemLink.mockResolvedValue(true);

		const result = await removeLink({
			input: { projectId: "p1", linkId: "l1" },
			context,
		});

		expect(result).toEqual({ removed: true });
		expect(dismissActionItemLink).toHaveBeenCalledWith({
			linkId: "l1",
			projectId: "p1",
			dismissedById: "u1",
		});
	});

	it("reports NOT_FOUND rather than a success that changed nothing", async () => {
		dismissActionItemLink.mockResolvedValue(false);

		await expect(
			removeLink({ input: { projectId: "p1", linkId: "l1" }, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects a caller without project access", async () => {
		hasAccess.mockResolvedValue(false);

		await expect(
			removeLink({ input: { projectId: "p1", linkId: "l1" }, context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(dismissActionItemLink).not.toHaveBeenCalled();
	});
});

describe("toActionItemPayload itemKey (link join key)", () => {
	it("stamps the same key the matcher writes, so links can be joined", () => {
		const [payload] = toActionItemPayload({
			rows: [
				{
					id: "a1",
					orderIndex: 0,
					text: "Ship the digest",
					tentativeOwnerName: null,
					dueHint: null,
					completedAt: null,
					sourceQuote: null,
					anchorLine: null,
				},
			],
			legacyJson: null,
		});
		// Without this the client has no join key and NO chip can ever render,
		// however many links the matcher stored.
		expect(payload.itemKey).toBe(computeActionItemKey("Ship the digest"));
	});

	it("stamps a key on legacy Json items too", () => {
		const [payload] = toActionItemPayload({
			rows: [],
			legacyJson: [{ text: "Legacy item" }],
		});
		expect(payload.id).toBeNull();
		expect(payload.itemKey).toBe(computeActionItemKey("Legacy item"));
	});

	it("gives items differing only in case and spacing the same key", () => {
		const [a] = toActionItemPayload({
			rows: [],
			legacyJson: [{ text: "Ship  The Digest" }],
		});
		const [b] = toActionItemPayload({
			rows: [],
			legacyJson: [{ text: "ship the digest" }],
		});
		expect(a.itemKey).toBe(b.itemKey);
	});
});
