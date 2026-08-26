/**
 * Unit tests for the in-body attachment auto-reinject guard at
 * `updateDraftingStageWithVersionProcedure`.
 *
 * The stage-transition mutation persists the AI-rewritten description on
 * the reporter's primary path. When the model drops a `story-media/` key
 * that was present in the prior description, the guard re-signs the
 * dropped keys and appends a `## Attachments` markdown footer so the
 * post-fix invariant holds regardless of model behavior.
 *
 * Mocks `@repo/database`, `@repo/config`, `@repo/storage`, `@repo/logs`,
 * the PM-sync enqueue helper, and the oRPC procedure base so the handler
 * can be invoked directly. Mocking shape mirrors the sibling
 * `update-drafting-stage-with-version-pm-sync.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getStoryById: vi.fn(),
		userStoryUpdate: vi.fn(),
		createFeatureVersion: vi.fn(),
		enqueuePmSync: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
		getSignedUrl: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	// Faithful mini-implementation: the handler distinguishes a lost race by
	// TYPE, so a stub would make every write look like a genuine failure.
	StoryVersionConflictError: class StoryVersionConflictError extends Error {
		readonly storyId: string;
		constructor(storyId: string) {
			super(
				"Feature was updated by another request. Please refresh and try again.",
			);
			this.name = "StoryVersionConflictError";
			this.storyId = storyId;
		}
	},
	getStoryById: mocks.getStoryById,
	createFeatureVersion: mocks.createFeatureVersion,
	db: {
		userStory: {
			update: mocks.userStoryUpdate,
			// Auto-draft eligibility, read only on arrival at Ready for Dev.
			// `null` means "no such feature", so the trigger short-circuits and
			// this suite stays about the attachment guard.
			findUnique: vi.fn(async () => null),
		},
	},
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"PASSIVE_ANALYSIS",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-bucket",
			},
		},
	},
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		type: "s3",
		getSignedUrl: mocks.getSignedUrl,
	})),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: mocks.loggerError,
		debug: vi.fn(),
	},
}));

// Reaching Ready for Dev can start a test-case drafting run. Mocked at the
// claim/dispatch boundary so the Temporal client — and the `@repo/ai` graph
// behind it — never loads here; its module-level `setAiUsageRecorder` call
// would otherwise need adding to this file's exhaustive `@repo/database` mock,
// which has no interest in it.
vi.mock("../../../lib/start-test-case-draft", () => ({
	startTestCaseDraft: vi.fn(async () => ({
		started: true,
		jobId: "job-1",
		status: "PENDING",
	})),
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

// Mock the notification service so importing the SUT does not pull the real
// notification-service graph (@repo/mail / @repo/payments) into the test.
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { subscriptionUpdate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateStage = fn;
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
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../update-drafting-stage-with-version");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

/** Default sign behaviour: return a deterministic stub URL per key. */
function stubSign(key: string): string {
	return `https://stub-bucket.local/${key}?signed=1`;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf_test",
	});
	mocks.userStoryUpdate.mockImplementation(
		async ({ data }: { data: { description: string | null } }) => ({
			id: "story-guard",
			description: data.description,
			pmAutoSyncEnabled: false,
		}),
	);
	mocks.getSignedUrl.mockImplementation(async (key: string) => stubSign(key));
});

describe("updateDraftingStageWithVersionProcedure attachment guard", () => {
	it("happy path: incoming description preserves all prior keys → no reinject, no warn log", async () => {
		const key = "story-media/project-1/story-guard/img.png";
		const url =
			"https://signed.cf/story-media/project-1/story-guard/img.png?signed=abc";
		const priorDescription = `<p>hello</p><img data-s3-key="${key}" src="${url}">`;
		const incomingDescription = `# Hello\n\n![](${url})\n\nrewritten body`;

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 1,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "PASSIVE_ANALYSIS",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "ACTIVE_ANALYSIS",
				description: incomingDescription,
			},
			context: ctx,
		});

		expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		expect(updateCall.data.description).toBe(incomingDescription);
		expect(updateCall.data.description).not.toContain("## Attachments");
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.any(Object),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("drop case (one image): reinjects \\n\\n## Attachments\\n\\n![](url) and emits one warn log with droppedKeyCount: 1", async () => {
		const key = "story-media/project-1/story-guard/screenshot.png";
		const priorDescription = `<p>here is a screenshot</p><img data-s3-key="${key}" src="https://signed.cf/${key}?signed=old">`;
		const incomingDescription =
			"# Rewritten\n\nThe AI removed the image but kept the prose.";

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 2,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "ACTIVE_ANALYSIS",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "SANITY_CHECK",
				description: incomingDescription,
			},
			context: ctx,
		});

		expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		expect(updateCall.data.description).toBe(
			`${incomingDescription}\n\n## Attachments\n\n![](${stubSign(key)})`,
		);
		expect(updateCall.data.description).toContain(key);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				storyId: "story-guard",
				projectId: "project-1",
				surface: "stage-transition",
				targetStage: "SANITY_CHECK",
				droppedKeyCount: 1,
				droppedKeys: [key],
				draftingStage: "ACTIVE_ANALYSIS",
			}),
		);
	});

	it("drop case (multiple, order preserved): reinjects k1 then k3 in original insertion order", async () => {
		const k1 = "story-media/project-1/story-guard/k1.png";
		const k2 = "story-media/project-1/story-guard/k2.png";
		const k3 = "story-media/project-1/story-guard/k3.png";
		const priorDescription = [
			`<p>first</p><img data-s3-key="${k1}" src="https://signed.cf/${k1}?signed=a">`,
			`<p>second</p><img data-s3-key="${k2}" src="https://signed.cf/${k2}?signed=b">`,
			`<p>third</p><img data-s3-key="${k3}" src="https://signed.cf/${k3}?signed=c">`,
		].join("");
		// AI rewrite drops k1 and k3 but keeps k2 (in markdown form).
		const incomingDescription = `# Rewrite\n\nKept the middle image:\n\n![](https://signed.cf/${k2}?signed=b2)`;

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 1,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: incomingDescription,
			},
			context: ctx,
		});

		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		expect(updateCall.data.description).toBe(
			[
				incomingDescription,
				"",
				"## Attachments",
				"",
				`![](${stubSign(k1)})`,
				`![](${stubSign(k3)})`,
			].join("\n"),
		);
		// Order check: k1 must appear before k3 in the reinjected block.
		const k1Idx = updateCall.data.description.indexOf(k1);
		const k3Idx = updateCall.data.description.indexOf(k3);
		expect(k1Idx).toBeGreaterThan(-1);
		expect(k3Idx).toBeGreaterThan(k1Idx);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				droppedKeyCount: 2,
				droppedKeys: [k1, k3],
			}),
		);
	});

	it("idempotency: re-invoking with the already-reinjected description is a no-op (no further reinjection, no warn log)", async () => {
		const key = "story-media/project-1/story-guard/image.png";
		const priorDescription = `<p>orig</p><img data-s3-key="${key}" src="https://signed.cf/${key}?signed=a">`;
		// Simulate what the caller would resubmit on the second invocation:
		// the already-reinjected output from the first run.
		const alreadyReinjected = `# AI Rewrite\n\n(prose only)\n\n## Attachments\n\n![](${stubSign(key)})`;

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 1,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: alreadyReinjected,
			},
			context: ctx,
		});

		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		// No further reinjection — the description is persisted byte-for-byte.
		expect(updateCall.data.description).toBe(alreadyReinjected);
		// And the `## Attachments` heading appears exactly once, not twice.
		const occurrences = updateCall.data.description.split("## Attachments");
		expect(occurrences).toHaveLength(2);
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.any(Object),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("empty prior: prior description is null → guard is a no-op regardless of incoming", async () => {
		const incomingDescription = "# New content with no images";

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 1,
			description: null,
			acceptanceCriteria: null,
			draftingStage: "PLACEHOLDER",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "PASSIVE_ANALYSIS",
				description: incomingDescription,
			},
			context: ctx,
		});

		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		expect(updateCall.data.description).toBe(incomingDescription);
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.any(Object),
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("key-prefix safety: extracted key for a different story is skipped + error-logged; valid keys still reinjected", async () => {
		const validKey = "story-media/project-1/story-guard/legit.png";
		const foreignKey = "story-media/project-1/OTHER-STORY/leaked.png";
		const priorDescription =
			`<img data-s3-key="${validKey}" src="https://signed.cf/${validKey}?signed=a">` +
			`<img data-s3-key="${foreignKey}" src="https://signed.cf/${foreignKey}?signed=b">`;
		const incomingDescription = "# Rewrite\n\n(no images)";

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 1,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: incomingDescription,
			},
			context: ctx,
		});

		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		// Only the valid key was reinjected.
		expect(updateCall.data.description).toBe(
			`${incomingDescription}\n\n## Attachments\n\n![](${stubSign(validKey)})`,
		);
		expect(updateCall.data.description).not.toContain(foreignKey);
		// The foreign key produced an `error` log.
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"[stage-transition] dropped key failed prefix check",
			expect.objectContaining({
				key: foreignKey,
				expectedPrefix: "story-media/project-1/story-guard/",
				storyId: "story-guard",
				projectId: "project-1",
				surface: "stage-transition",
			}),
		);
		// The warn log reports only the safely-reinjected key.
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				droppedKeyCount: 1,
				droppedKeys: [validKey],
			}),
		);
	});

	it("sign failure: one of two keys fails getSignedUrl → successful key still reinjected, failed key error-logged, procedure resolves", async () => {
		const okKey = "story-media/project-1/story-guard/ok.png";
		const badKey = "story-media/project-1/story-guard/bad.png";
		const priorDescription =
			`<img data-s3-key="${okKey}" src="https://signed.cf/${okKey}?signed=a">` +
			`<img data-s3-key="${badKey}" src="https://signed.cf/${badKey}?signed=b">`;
		const incomingDescription = "# Rewrite removed both images";

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 1,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});

		mocks.getSignedUrl.mockImplementation(async (key: string) => {
			if (key === badKey) {
				throw new Error("S3 NoSuchKey");
			}
			return stubSign(key);
		});

		const result = await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: incomingDescription,
			},
			context: ctx,
		});

		expect(result).toBeDefined();
		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		expect(updateCall.data.description).toBe(
			`${incomingDescription}\n\n## Attachments\n\n![](${stubSign(okKey)})`,
		);
		expect(updateCall.data.description).not.toContain(badKey);
		expect(mocks.loggerError).toHaveBeenCalledWith(
			"[stage-transition] sign failed for dropped key",
			expect.objectContaining({
				key: badKey,
				storyId: "story-guard",
				projectId: "project-1",
				surface: "stage-transition",
				error: "S3 NoSuchKey",
			}),
		);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				droppedKeyCount: 1,
				droppedKeys: [okKey],
			}),
		);
	});

	it("snapshot ordering: FeatureVersion[newVersion] description matches the persisted row (post-guard), not the pre-guard input", async () => {
		// Regression for the bug where the second `createFeatureVersion`
		// call snapshotted `input.description` BEFORE the reinject guard
		// ran, leaving the audit row out of sync with the live story row.
		// Rolling back to that snapshot from FeatureVersionHistory used to
		// lose the reinjected attachments. After the fix, the snapshot
		// records exactly what `db.userStory.update` persists.
		const key = "story-media/project-1/story-guard/snapshot-check.png";
		const priorDescription = `<img data-s3-key="${key}" src="https://signed.cf/${key}?signed=old">`;
		const incomingDescription =
			"# AI rewrite removed the image but kept the prose.";

		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 5,
			description: priorDescription,
			acceptanceCriteria: null,
			draftingStage: "ACTIVE_ANALYSIS",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "SANITY_CHECK",
				description: incomingDescription,
			},
			context: ctx,
		});

		// Two FeatureVersion rows are written per spec §6.3: the pre-AI
		// snapshot (currentVersion) and the post-AI/post-guard snapshot
		// (newVersion = currentVersion + 1).
		expect(mocks.createFeatureVersion).toHaveBeenCalledTimes(2);

		const priorSnapshot = mocks.createFeatureVersion.mock.calls[0][0] as {
			version: number;
			description: string | null;
			changeDescription: string;
		};
		const newSnapshot = mocks.createFeatureVersion.mock.calls[1][0] as {
			version: number;
			description: string | null;
			changeDescription: string;
		};

		// Prior snapshot is the verbatim pre-AI description — unchanged by the fix.
		expect(priorSnapshot.version).toBe(5);
		expect(priorSnapshot.description).toBe(priorDescription);
		expect(priorSnapshot.changeDescription).toMatch(/^Before /);

		// New snapshot MUST equal the persisted row (post-guard description)
		// so FeatureVersionHistory rollback recovers attachments, not the
		// AI's truncated draft.
		expect(newSnapshot.version).toBe(6);
		expect(newSnapshot.changeDescription).toMatch(/^AI-enhanced /);

		const updateCall = mocks.userStoryUpdate.mock.calls[0][0] as {
			data: { description: string };
		};
		expect(newSnapshot.description).toBe(updateCall.data.description);

		// And both must contain the reinjected key + heading.
		expect(newSnapshot.description).toContain(key);
		expect(newSnapshot.description).toContain("## Attachments");
		expect(updateCall.data.description).toContain(key);
		expect(updateCall.data.description).toContain("## Attachments");
	});
});

// =============================================================================
// Optimistic-concurrency guard
// =============================================================================

describe("updateDraftingStageWithVersionProcedure concurrency guard", () => {
	it("writes under the version it read, so a row that moved cannot be clobbered", async () => {
		// The window is real: this handler reads `version`, then awaits a
		// version snapshot and the attachment guard before it writes, while the
		// editor autosaves the same row every 10s. Without `version` in the
		// predicate the write landed on whatever was there.
		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 7,
			description: "<p>before</p>",
			acceptanceCriteria: null,
			draftingStage: "PASSIVE_ANALYSIS",
			kind: "FEATURE",
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-guard",
				organizationId: null,
				targetStage: "ACTIVE_ANALYSIS",
				description: "rewritten",
			},
			context: ctx,
		});

		const where = mocks.userStoryUpdate.mock.calls[0][0] as {
			where: { version?: number };
			data: { version?: number };
		};
		expect(where.where.version).toBe(7);
		// And it still claims the next version, so two writers cannot both win.
		expect(where.data.version).toBe(8);
	});

	it("turns Prisma's no-such-row into a conflict, not a silent success", async () => {
		// P2025 is what Prisma raises when the predicate matches nothing, which
		// on this path means only one thing: someone else wrote first. It has to
		// surface as a conflict the client can recognise — the old behaviour
		// overwrote the other write and reported success.
		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 7,
			description: "<p>before</p>",
			acceptanceCriteria: null,
			draftingStage: "PASSIVE_ANALYSIS",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockRejectedValue(
			Object.assign(new Error("Record to update not found."), {
				code: "P2025",
			}),
		);

		await expect(
			handlers.updateStage({
				input: {
					projectId: "project-1",
					storyId: "story-guard",
					organizationId: null,
					targetStage: "ACTIVE_ANALYSIS",
					description: "rewritten",
				},
				context: ctx,
			}),
		).rejects.toThrow("Feature was updated by another request");
	});

	it("rethrows a non-P2025 write failure so it is not misread as a conflict", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-guard",
			version: 7,
			description: "<p>before</p>",
			acceptanceCriteria: null,
			draftingStage: "PASSIVE_ANALYSIS",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockRejectedValue(new Error("connection reset"));

		await expect(
			handlers.updateStage({
				input: {
					projectId: "project-1",
					storyId: "story-guard",
					organizationId: null,
					targetStage: "ACTIVE_ANALYSIS",
					description: "rewritten",
				},
				context: ctx,
			}),
		).rejects.toThrow("connection reset");
	});
});
