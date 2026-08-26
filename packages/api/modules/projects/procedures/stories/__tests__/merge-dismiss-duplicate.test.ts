/**
 * Tests for `mergeDuplicateProcedure` and `dismissDuplicateProcedure`:
 * tenant access, the self-merge guard, NOT_FOUND on a stale dismiss, clean
 * delegation to the DB queries, and the merge-time asset carry-over.
 *
 * The carry-over (Fizzy #2048) is exercised through the REAL
 * `copyStoryAssetsToStory` with only the storage provider mocked, because the
 * property under test is a sequencing one — copy first, reference only what
 * copied — and it lives across the procedure and the helper together. Mocking
 * the helper would assert the procedure calls it, not that an image survives.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlerList, uses } = vi.hoisted(() => ({
	handlerList: [] as Array<(...args: unknown[]) => unknown>,
	uses: [] as unknown[],
}));

const mockHasProjectAccess = vi.fn(async () => true);
const mockMergeDuplicateStories = vi.fn(async () => ({
	survivorId: "s1",
	duplicateId: "s2",
}));
const mockDismissDuplicateLink = vi.fn(async () => 1);
const mockUpdateStory = vi.fn(async () => ({
	id: "s1",
	pmAutoSyncEnabled: false,
}));
// The survivor's prior description, read by the procedure to preserve the
// survivor's own attachments through an AI-combine. Default: no description.
const mockUserStoryFindFirst = vi.fn(
	async (
		_args?: unknown,
	): Promise<{ description: string | null } | null> => ({
		description: null,
	}),
);
const mockEnqueuePmSync = vi.fn(async () => undefined);
// The duplicate's live attachment rows, read so their objects can be copied into
// the survivor's keyspace before the rows are re-parented. Default: none.
const mockStoryAttachmentFindMany = vi.fn(
	async (): Promise<Array<{ id: string; storageKey: string }>> => [],
);
// The storage boundary: a within-bucket server-side copy. Resolves by default.
const mockCopyFile = vi.fn(async (_from: string, _to: string) => undefined);

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findFirst: (...a: unknown[]) => mockUserStoryFindFirst(...a),
		},
		storyAttachment: {
			findMany: (...a: unknown[]) => mockStoryAttachmentFindMany(...a),
		},
	},
	hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
	mergeDuplicateStories: (...a: unknown[]) => mockMergeDuplicateStories(...a),
	dismissDuplicateLink: (...a: unknown[]) => mockDismissDuplicateLink(...a),
	updateStory: (...a: unknown[]) => mockUpdateStory(...a),
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		copyFile: (...a: [string, string, { bucket: string }]) =>
			mockCopyFile(a[0], a[1]),
	}),
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: (...a: unknown[]) => mockEnqueuePmSync(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlerList.push(fn);
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: (perm: string) => {
			uses.push({ requireProjectPermission: perm });
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

// Import order fixes handlerList indices.
import "../merge-duplicate";
import "../dismiss-duplicate";

const mergeHandler = handlerList[0];
const dismissHandler = handlerList[1];

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockMergeDuplicateStories.mockResolvedValue({
		survivorId: "s1",
		duplicateId: "s2",
	});
	mockDismissDuplicateLink.mockResolvedValue(1);
	mockUpdateStory.mockResolvedValue({ id: "s1", pmAutoSyncEnabled: false });
	mockUserStoryFindFirst.mockResolvedValue({ description: null });
	mockEnqueuePmSync.mockResolvedValue(undefined);
	mockStoryAttachmentFindMany.mockResolvedValue([]);
	mockCopyFile.mockResolvedValue(undefined);
});

/**
 * The procedure reads a prior description for BOTH sides — the survivor's (to
 * keep its own images) and the duplicate's (to find the images to carry over).
 * Route each lookup by story id so a test can give the two sides different
 * bodies.
 */
function setStoryDescriptions(byId: Record<string, string | null>): void {
	mockUserStoryFindFirst.mockImplementation(async (args?: unknown) => {
		const id = (args as { where?: { id?: string } } | undefined)?.where?.id;
		return { description: (id && byId[id]) ?? null };
	});
}

/** The description the procedure actually persisted on the survivor. */
function persistedDescription(): string | undefined {
	const data = mockUpdateStory.mock.calls[0]?.[2] as
		| { description?: string }
		| undefined;
	return data?.description;
}

/** The attachment moves handed to the merge transaction. */
function attachmentMoves(): Array<{
	attachmentId: string;
	storageKey: string;
}> {
	const arg = mockMergeDuplicateStories.mock.calls[0]?.[0] as {
		attachmentKeyUpdates?: Array<{
			attachmentId: string;
			storageKey: string;
		}>;
	};
	return arg?.attachmentKeyUpdates ?? [];
}

describe("mergeDuplicateProcedure", () => {
	const input = {
		projectId: "proj-1",
		organizationId: null,
		survivorId: "s1",
		duplicateId: "s2",
	};

	it("delegates to mergeDuplicateStories and returns the result", async () => {
		const result = await mergeHandler({ input, context: ctx });
		expect(mockMergeDuplicateStories).toHaveBeenCalledWith({
			attachmentKeyUpdates: undefined,
			projectId: "proj-1",
			survivorId: "s1",
			duplicateId: "s2",
			userId: "user-1",
			lastEditedByName: null,
			pmLink: undefined,
		});
		expect(result).toEqual({ survivorId: "s1", duplicateId: "s2" });
	});

	it("does not touch the survivor description for a plain merge", async () => {
		await mergeHandler({ input, context: ctx });
		expect(mockUpdateStory).not.toHaveBeenCalled();
		expect(mockEnqueuePmSync).not.toHaveBeenCalled();
	});

	it("denies a non-member tenant (FORBIDDEN) and never merges", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		await expect(mergeHandler({ input, context: ctx })).rejects.toThrow(
			/access/i,
		);
		expect(mockMergeDuplicateStories).not.toHaveBeenCalled();
	});

	it("rejects merging a story into itself (BAD_REQUEST)", async () => {
		await expect(
			mergeHandler({
				input: { ...input, duplicateId: "s1" },
				context: ctx,
			}),
		).rejects.toThrow(/into itself/i);
		expect(mockMergeDuplicateStories).not.toHaveBeenCalled();
	});

	it("maps a query failure to BAD_REQUEST with the message", async () => {
		mockMergeDuplicateStories.mockRejectedValue(
			new Error("Both stories must belong to the project"),
		);
		await expect(mergeHandler({ input, context: ctx })).rejects.toThrow(
			/belong to the project/i,
		);
	});
});

describe("mergeDuplicateProcedure — true merge (combined content)", () => {
	const input = {
		projectId: "proj-1",
		organizationId: null,
		survivorId: "s1",
		duplicateId: "s2",
		mergedDescription: "Combined requirements from both items.",
	};

	it("writes the combined description to the survivor before the merge", async () => {
		await mergeHandler({ input, context: ctx });
		expect(mockUpdateStory).toHaveBeenCalledWith(
			"s1",
			"proj-1",
			{ description: "Combined requirements from both items." },
			expect.objectContaining({ userId: "user-1", changedBy: "user-1" }),
		);
		// The survivor description update is applied before the duplicate is
		// retired, so a failure there cannot lose the duplicate's content.
		const updateOrder = mockUpdateStory.mock.invocationCallOrder[0];
		const mergeOrder =
			mockMergeDuplicateStories.mock.invocationCallOrder[0];
		expect(updateOrder).toBeLessThan(mergeOrder);
	});

	it("enqueues a PM sync only when the survivor has auto-sync enabled", async () => {
		mockUpdateStory.mockResolvedValue({
			id: "s1",
			pmAutoSyncEnabled: true,
		});
		await mergeHandler({ input, context: ctx });
		expect(mockEnqueuePmSync).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "s1",
				itemType: "story",
				projectId: "proj-1",
			}),
		);
	});

	it("skips PM sync when the survivor has auto-sync disabled", async () => {
		mockUpdateStory.mockResolvedValue({
			id: "s1",
			pmAutoSyncEnabled: false,
		});
		await mergeHandler({ input, context: ctx });
		expect(mockEnqueuePmSync).not.toHaveBeenCalled();
	});

	it("ignores a whitespace-only mergedDescription (no description write)", async () => {
		await mergeHandler({
			input: { ...input, mergedDescription: "   \n  " },
			context: ctx,
		});
		expect(mockUpdateStory).not.toHaveBeenCalled();
		// The merge itself still proceeds.
		expect(mockMergeDuplicateStories).toHaveBeenCalled();
	});

	it("writes both description and acceptance criteria when supplied", async () => {
		await mergeHandler({
			input: {
				...input,
				mergedAcceptanceCriteria: "Given X, when Y, then Z.",
			},
			context: ctx,
		});
		expect(mockUpdateStory).toHaveBeenCalledWith(
			"s1",
			"proj-1",
			{
				description: "Combined requirements from both items.",
				acceptanceCriteria: "Given X, when Y, then Z.",
			},
			expect.objectContaining({ userId: "user-1", changedBy: "user-1" }),
		);
	});

	it("writes acceptance criteria alone when no description is supplied", async () => {
		await mergeHandler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				survivorId: "s1",
				duplicateId: "s2",
				mergedAcceptanceCriteria: "Given X, when Y, then Z.",
			},
			context: ctx,
		});
		expect(mockUpdateStory).toHaveBeenCalledWith(
			"s1",
			"proj-1",
			{ acceptanceCriteria: "Given X, when Y, then Z." },
			expect.objectContaining({ userId: "user-1" }),
		);
		expect(mockMergeDuplicateStories).toHaveBeenCalled();
	});

	it("ignores whitespace-only acceptance criteria (description still written)", async () => {
		await mergeHandler({
			input: { ...input, mergedAcceptanceCriteria: "   \n " },
			context: ctx,
		});
		expect(mockUpdateStory).toHaveBeenCalledWith(
			"s1",
			"proj-1",
			{ description: "Combined requirements from both items." },
			expect.objectContaining({ userId: "user-1" }),
		);
	});

	it("preserves the survivor's own attachments through an AI-combined merge", async () => {
		// Survivor's prior description carries one of its own media keys that the
		// AI-combined text dropped — the procedure must re-append it.
		mockUserStoryFindFirst.mockResolvedValue({
			description:
				"Original text.\n\n![shot](story-media/proj-1/s1/shot.png)",
		});
		await mergeHandler({ input, context: ctx });
		const applied = mockUpdateStory.mock.calls[0]?.[2] as {
			description?: string;
		};
		expect(applied.description).toContain("story-media/proj-1/s1/shot.png");
		expect(applied.description).toContain("Combined requirements");
	});

	it("strips the duplicate's (cross-story) attachments from the merged description", async () => {
		// A foreign key (duplicate s2's keyspace) would 404 on the survivor, so
		// it must be removed rather than written verbatim.
		await mergeHandler({
			input: {
				...input,
				mergedDescription:
					"Combined.\n\n![d](story-media/proj-1/s2/diagram.png)",
			},
			context: ctx,
		});
		const applied = mockUpdateStory.mock.calls[0]?.[2] as {
			description?: string;
		};
		expect(applied.description).not.toContain(
			"story-media/proj-1/s2/diagram.png",
		);
		expect(applied.description).toContain("Combined.");
	});
});

/**
 * Fizzy #2048 — both items' assets survive the merge.
 *
 * Before this, only the survivor's assets survived: the duplicate's inline
 * images were stripped from the merged body and its uploaded attachment rows
 * stayed bound to the retired item. Both keyspaces are prefix-gated against the
 * owning item, so carrying an asset over means COPYING the object under the
 * survivor and referencing the new key — never re-pointing the old one.
 */
describe("mergeDuplicateProcedure — asset carry-over (combined merge)", () => {
	const base = {
		projectId: "proj-1",
		organizationId: null,
		survivorId: "s1",
		duplicateId: "s2",
		mergedDescription: "Combined requirements from both items.",
	};
	const survivorKey = "story-media/proj-1/s1/own.png";
	const duplicateKey = "story-media/proj-1/s2/repro.png";
	const carriedKey = "story-media/proj-1/s1/merged-s2-repro.png";

	it("keeps the survivor's images when only it has any", async () => {
		setStoryDescriptions({
			s1: `Old ![o](${survivorKey})`,
			s2: "No media.",
		});
		await mergeHandler({ input: base, context: ctx });
		expect(persistedDescription()).toContain(survivorKey);
		expect(mockCopyFile).not.toHaveBeenCalled();
	});

	it("copies the duplicate's images and references the NEW keys", async () => {
		setStoryDescriptions({
			s1: "Survivor had no media.",
			s2: `Steps ![r](${duplicateKey})`,
		});
		await mergeHandler({ input: base, context: ctx });

		expect(mockCopyFile).toHaveBeenCalledWith(duplicateKey, carriedKey);
		const description = persistedDescription();
		expect(description).toContain(carriedKey);
		// The duplicate's ORIGINAL key resolves to nothing on the survivor, so it
		// must never appear in the persisted body.
		expect(description).not.toContain(duplicateKey);
	});

	it("keeps both items' images, with no key collision", async () => {
		setStoryDescriptions({
			s1: `Old ![o](${survivorKey})`,
			s2: `Steps ![r](${duplicateKey})`,
		});
		await mergeHandler({ input: base, context: ctx });
		const description = persistedDescription() ?? "";
		expect(description).toContain(survivorKey);
		expect(description).toContain(carriedKey);
		expect(description.split(survivorKey).length - 1).toBe(1);
		expect(description.split(carriedKey).length - 1).toBe(1);
	});

	it("copies nothing for a key outside the duplicate's own prefix", async () => {
		// Media keys are scraped from free-text markdown, so a body can name any
		// key at all. Copying an unvalidated one would pull a stranger's object
		// into this project's keyspace, where it would then resolve.
		const foreign = "story-media/other-proj/other-story/secret.png";
		setStoryDescriptions({ s1: null, s2: `Pasted ![x](${foreign})` });
		await mergeHandler({ input: base, context: ctx });

		expect(mockCopyFile).not.toHaveBeenCalled();
		const description = persistedDescription() ?? "";
		expect(description).not.toContain(foreign);
		expect(description).not.toContain("secret.png");
	});

	it("completes the merge when a copy fails, referencing only what copied", async () => {
		const goodKey = "story-media/proj-1/s2/good.png";
		const badKey = "story-media/proj-1/s2/bad.png";
		setStoryDescriptions({
			s1: null,
			s2: `![g](${goodKey})\n![b](${badKey})`,
		});
		mockCopyFile.mockImplementation(async (from: string) => {
			if (from === badKey) {
				throw new Error("copy failed");
			}
			return undefined;
		});

		await mergeHandler({ input: base, context: ctx });

		// The merge is not rolled back by a storage failure.
		expect(mockMergeDuplicateStories).toHaveBeenCalled();
		const description = persistedDescription() ?? "";
		expect(description).toContain("merged-s2-good.png");
		expect(description).not.toContain("merged-s2-bad.png");
		expect(description).not.toContain(badKey);
	});

	it("copies before the survivor body that references the copies is written", async () => {
		setStoryDescriptions({ s1: null, s2: `![r](${duplicateKey})` });
		await mergeHandler({ input: base, context: ctx });
		expect(mockCopyFile.mock.invocationCallOrder[0]).toBeLessThan(
			mockUpdateStory.mock.invocationCallOrder[0],
		);
	});
});

describe("mergeDuplicateProcedure — attachment row carry-over", () => {
	const base = {
		projectId: "proj-1",
		organizationId: null,
		survivorId: "s1",
		duplicateId: "s2",
	};
	const dupAttachmentKey = "story-attachments/proj-1/s2/file-1.pdf";
	const carriedAttachmentKey =
		"story-attachments/proj-1/s1/merged-s2-file-1.pdf";

	it("attaches the duplicate's rows to the survivor under the survivor's prefix", async () => {
		mockStoryAttachmentFindMany.mockResolvedValue([
			{ id: "att-1", storageKey: dupAttachmentKey },
		]);
		await mergeHandler({
			input: { ...base, mergedDescription: "Combined." },
			context: ctx,
		});

		expect(mockCopyFile).toHaveBeenCalledWith(
			dupAttachmentKey,
			carriedAttachmentKey,
		);
		// A re-parented row that kept the duplicate's key would render as a dead
		// entry — download only signs keys under the owning item's prefix.
		expect(attachmentMoves()).toEqual([
			{ attachmentId: "att-1", storageKey: carriedAttachmentKey },
		]);
	});

	it("moves the rows on a plain merge with no combined body", async () => {
		// A plain merge writes no survivor body, so inline images have nowhere to
		// land — but the uploaded attachments must still move.
		mockStoryAttachmentFindMany.mockResolvedValue([
			{ id: "att-1", storageKey: dupAttachmentKey },
		]);
		setStoryDescriptions({
			s2: "Body with ![r](story-media/proj-1/s2/x.png)",
		});

		await mergeHandler({ input: base, context: ctx });

		expect(mockUpdateStory).not.toHaveBeenCalled();
		expect(attachmentMoves()).toEqual([
			{ attachmentId: "att-1", storageKey: carriedAttachmentKey },
		]);
		// No inline-image copy on this path.
		expect(mockCopyFile).toHaveBeenCalledTimes(1);
		expect(mockCopyFile).toHaveBeenCalledWith(
			dupAttachmentKey,
			carriedAttachmentKey,
		);
	});

	it("leaves a row whose object failed to copy on the duplicate", async () => {
		mockStoryAttachmentFindMany.mockResolvedValue([
			{ id: "att-1", storageKey: dupAttachmentKey },
			{
				id: "att-2",
				storageKey: "story-attachments/proj-1/s2/file-2.pdf",
			},
		]);
		mockCopyFile.mockImplementation(async (from: string) => {
			if (from === dupAttachmentKey) {
				throw new Error("copy failed");
			}
			return undefined;
		});

		await mergeHandler({ input: base, context: ctx });

		expect(mockMergeDuplicateStories).toHaveBeenCalled();
		expect(attachmentMoves()).toEqual([
			{
				attachmentId: "att-2",
				storageKey: "story-attachments/proj-1/s1/merged-s2-file-2.pdf",
			},
		]);
	});

	/**
	 * Scoped through the project, not by id alone. `duplicateId` is
	 * caller-supplied, and the two checks that would otherwise catch a foreign
	 * one — the copy helper's prefix filter and the merge query's same-project
	 * assertion — both run AFTER this read.
	 */
	it("reads only the duplicate's live rows, and only within the project", async () => {
		await mergeHandler({ input: base, context: ctx });
		expect(mockStoryAttachmentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					storyId: "s2",
					story: { projectId: "proj-1" },
					deletedAt: null,
				},
			}),
		);
	});

	it("behaves as before when neither item has assets", async () => {
		await mergeHandler({ input: base, context: ctx });
		expect(mockCopyFile).not.toHaveBeenCalled();
		expect(attachmentMoves()).toEqual([]);
		expect(mockMergeDuplicateStories).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				survivorId: "s1",
				duplicateId: "s2",
			}),
		);
	});
});

describe("mergeDuplicateProcedure — PM link resolution (pmLink)", () => {
	const base = {
		projectId: "proj-1",
		organizationId: null,
		survivorId: "s1",
		duplicateId: "s2",
	};

	it("forwards pmLink=transfer-from-duplicate to the query", async () => {
		await mergeHandler({
			input: { ...base, pmLink: "transfer-from-duplicate" },
			context: ctx,
		});
		expect(mockMergeDuplicateStories).toHaveBeenCalledWith(
			expect.objectContaining({ pmLink: "transfer-from-duplicate" }),
		);
	});

	it("forwards pmLink=keep-survivor to the query", async () => {
		await mergeHandler({
			input: { ...base, pmLink: "keep-survivor" },
			context: ctx,
		});
		expect(mockMergeDuplicateStories).toHaveBeenCalledWith(
			expect.objectContaining({ pmLink: "keep-survivor" }),
		);
	});

	it("defaults pmLink to undefined when omitted (query applies keep-survivor)", async () => {
		await mergeHandler({ input: base, context: ctx });
		const arg = mockMergeDuplicateStories.mock.calls[0]?.[0] as {
			pmLink?: unknown;
		};
		expect(arg.pmLink).toBeUndefined();
	});

	it("still enforces the self-merge guard regardless of pmLink", async () => {
		await expect(
			mergeHandler({
				input: {
					...base,
					duplicateId: "s1",
					pmLink: "transfer-from-duplicate",
				},
				context: ctx,
			}),
		).rejects.toThrow(/into itself/i);
		expect(mockMergeDuplicateStories).not.toHaveBeenCalled();
	});

	it("denies a non-member tenant even with a pmLink set", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		await expect(
			mergeHandler({
				input: { ...base, pmLink: "transfer-from-duplicate" },
				context: ctx,
			}),
		).rejects.toThrow(/access/i);
		expect(mockMergeDuplicateStories).not.toHaveBeenCalled();
	});

	it("surfaces a query failure as BAD_REQUEST even with pmLink (FR-14)", async () => {
		mockMergeDuplicateStories.mockRejectedValue(
			new Error("constraint violation during link transfer"),
		);
		await expect(
			mergeHandler({
				input: { ...base, pmLink: "transfer-from-duplicate" },
				context: ctx,
			}),
		).rejects.toThrow(/constraint violation/i);
	});
});

describe("dismissDuplicateProcedure", () => {
	const input = {
		projectId: "proj-1",
		organizationId: null,
		linkId: "link-1",
	};

	it("dismisses and returns { dismissed: true }", async () => {
		const result = await dismissHandler({ input, context: ctx });
		expect(mockDismissDuplicateLink).toHaveBeenCalledWith(
			"link-1",
			"proj-1",
			"user-1",
		);
		expect(result).toEqual({ dismissed: true });
	});

	it("returns NOT_FOUND when no pending link matched (count 0)", async () => {
		mockDismissDuplicateLink.mockResolvedValue(0);
		await expect(dismissHandler({ input, context: ctx })).rejects.toThrow(
			/not found/i,
		);
	});

	it("denies a non-member tenant (FORBIDDEN) and never dismisses", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		await expect(dismissHandler({ input, context: ctx })).rejects.toThrow(
			/access/i,
		);
		expect(mockDismissDuplicateLink).not.toHaveBeenCalled();
	});
});
