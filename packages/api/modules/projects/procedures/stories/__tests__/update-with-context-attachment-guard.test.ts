/**
 * Unit tests for the attachment-preservation guard in
 * `updateWithContextProcedure` (Phase-2 apply branch).
 *
 * The "Update using context" flow has two phases. Phase 1 returns proposed
 * AI changes WITHOUT saving; Phase 2 (`preview: false`) applies the
 * user-confirmed document. The Phase-2 path runs the same diff-and-reinject
 * guard as the stage-transition mutation (spec §6, surface
 * "update-with-context"): keys present in the prior story description but
 * absent in `input.confirmedDescription` are re-signed via the storage
 * provider and reinjected under an `## Attachments` H2 so inline
 * `story-media/` images survive AI rewrites — even when the model
 * misbehaves and drops the markdown despite the system-prompt clause.
 *
 * Mocks `@repo/database`, `@repo/storage`, `@repo/config`, `@repo/logs`,
 * `enqueuePmSync`, the shared context-update helpers, and the oRPC
 * procedure base so the handler can be invoked directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getStoryById: vi.fn(),
		updateStory: vi.fn(),
		setLastContextUpdateAt: vi.fn(),
		getSignedUrl: vi.fn(),
		enqueuePmSync: vi.fn(),
		fetchProjectContextSources: vi.fn(),
		runContextUpdate: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	updateStory: mocks.updateStory,
	setLastContextUpdateAt: mocks.setLastContextUpdateAt,
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
	getStorageProvider: () => ({
		type: "s3",
		getSignedUrl: mocks.getSignedUrl,
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("@repo/temporal", () => ({
	fetchProjectContextSources: mocks.fetchProjectContextSources,
	runContextUpdate: mocks.runContextUpdate,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateWithContext = fn;
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

await import("../update-with-context");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const PROJECT_ID = "project-1";
const STORY_ID = "story-1";

function makeStory(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: STORY_ID,
		projectId: PROJECT_ID,
		title: "Example feature",
		description: null,
		acceptanceCriteria: null,
		draftingStage: "DRAFT",
		kind: "FEATURE",
		identifier: "F-001",
		version: 4,
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		...overrides,
	};
}

function applyInput(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		input: {
			projectId: PROJECT_ID,
			storyId: STORY_ID,
			organizationId: null,
			preview: false,
			storyVersion: 4,
			confirmedDescription: "AI-rewritten body",
			confirmedAcceptanceCriteria: null,
			...overrides,
		},
		context: ctx,
	};
}

function imgMarkdown(key: string, suffix = "signed=1"): string {
	return `![](https://cdn.example.com/${key}?${suffix})`;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: false,
		workflowId: null,
	});
	// updateStory returns whatever the caller passed for `description` so the
	// assertions can read back the persisted value through `result.story`.
	mocks.updateStory.mockImplementation(
		async (
			_storyId: string,
			_projectId: string,
			data: { description?: string | null },
		) => ({
			id: STORY_ID,
			description: data.description ?? null,
			pmAutoSyncEnabled: false,
		}),
	);
	// Deterministic signed-URL stub so assertions can match exactly.
	mocks.getSignedUrl.mockImplementation(
		async (key: string) => `https://stub-bucket.local/${key}?signed=1`,
	);
});

describe("updateWithContextProcedure — attachment preservation guard", () => {
	it("happy path: prior and incoming both contain the same key — no reinjection, no warn log", async () => {
		const key = `story-media/${PROJECT_ID}/${STORY_ID}/preserved.png`;
		mocks.getStoryById.mockResolvedValue(
			makeStory({
				description: `<p>Prior body with ${imgMarkdown(key)} embedded.</p>`,
			}),
		);

		const incoming = `Rewritten body that keeps ${imgMarkdown(key, "signed=2")}.`;
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		);

		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(persisted.description).toBe(incoming);
		expect(persisted.description).not.toContain("## Attachments");
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
	});

	it("drop case (one image): missing key is re-signed and reinjected; one structured warn fires", async () => {
		const key = `story-media/${PROJECT_ID}/${STORY_ID}/dropped.png`;
		mocks.getStoryById.mockResolvedValue(
			makeStory({
				description: `<p>Original with ${imgMarkdown(key)}.</p>`,
				draftingStage: "ACTIVE_ANALYSIS",
			}),
		);

		const incoming = "AI rewrite that dropped the image entirely.";
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		);

		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		// Exact bytes, not `toContain`. Every assertion on this branch used
		// `toContain`, so when the inline builder was replaced by the shared
		// `mergeEntriesInto` helper the spacing changed — a blank line before
		// the heading and a trailing newline — and nothing failed. The
		// spacing is now the shared helper's, which is the point of sharing it;
		// pinning it means the next change to either side has to be deliberate.
		expect(persisted.description).toBe(
			`${incoming}\n\n## Attachments\n\n![](https://stub-bucket.local/${key}?signed=1)\n`,
		);
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(key, {
			bucket: "test-bucket",
			expiresIn: 3600,
		});

		const warnCalls = mocks.loggerWarn.mock.calls.filter(
			(c) =>
				typeof c[0] === "string" &&
				(c[0] as string).startsWith("[stage-transition]"),
		);
		expect(warnCalls).toHaveLength(1);
		expect(warnCalls[0][1]).toMatchObject({
			storyId: STORY_ID,
			projectId: PROJECT_ID,
			surface: "update-with-context",
			targetStage: null,
			droppedKeyCount: 1,
			droppedKeys: [key],
			draftingStage: "ACTIVE_ANALYSIS",
		});
	});

	it("drop case (multiple, order preserved): reinjected block lists missing keys in original document order", async () => {
		const k1 = `story-media/${PROJECT_ID}/${STORY_ID}/k1.png`;
		const k2 = `story-media/${PROJECT_ID}/${STORY_ID}/k2.png`;
		const k3 = `story-media/${PROJECT_ID}/${STORY_ID}/k3.png`;
		mocks.getStoryById.mockResolvedValue(
			makeStory({
				description: [
					"<p>Pre-rewrite body</p>",
					imgMarkdown(k1),
					imgMarkdown(k2),
					imgMarkdown(k3),
				].join("\n"),
			}),
		);

		// Incoming preserves only k2; k1 and k3 are dropped.
		const incoming = `Rewritten body. ${imgMarkdown(k2, "signed=new")}`;
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		);

		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(persisted.description).toContain("## Attachments");
		const k1Idx = persisted.description?.indexOf(
			`![](https://stub-bucket.local/${k1}?signed=1)`,
		);
		const k3Idx = persisted.description?.indexOf(
			`![](https://stub-bucket.local/${k3}?signed=1)`,
		);
		expect(k1Idx).toBeGreaterThan(-1);
		expect(k3Idx).toBeGreaterThan(-1);
		// k1 (original first) precedes k3 (original third) per spec §6.1
		// insertion-order requirement; k2 was preserved and is not reinjected.
		expect(k1Idx).toBeLessThan(k3Idx as number);
		expect(persisted.description).not.toContain(
			`![](https://stub-bucket.local/${k2}?`,
		);

		const warnArgs = mocks.loggerWarn.mock.calls.find(
			(c) => c[0] === "[stage-transition] reinjected dropped attachments",
		)?.[1] as Record<string, unknown>;
		expect(warnArgs?.droppedKeyCount).toBe(2);
		expect(warnArgs?.droppedKeys).toEqual([k1, k3]);
	});

	it("idempotency: re-running with the already-reinjected description as input is a no-op", async () => {
		const key = `story-media/${PROJECT_ID}/${STORY_ID}/idempotent.png`;
		mocks.getStoryById.mockResolvedValue(
			makeStory({ description: imgMarkdown(key) }),
		);

		// First invocation: model dropped the image; guard reinjects.
		const firstIncoming = "AI rewrite without the image.";
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: firstIncoming }),
		);
		const firstPersisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(firstPersisted.description).toContain("## Attachments");

		// Second invocation: caller resubmits exactly what they saw — the
		// already-reinjected description. Prior description (mocked above) is
		// still the original single-image body so the diff math runs again,
		// but the incoming description carries the same key — so dropped = [].
		mocks.loggerWarn.mockReset();
		mocks.getSignedUrl.mockClear();
		mocks.updateStory.mockClear();

		const secondIncoming = firstPersisted.description as string;
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: secondIncoming }),
		);

		const secondPersisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(secondPersisted.description).toBe(secondIncoming);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
	});

	it("existing Attachments section: a newly dropped key is added under it, not under a second heading", async () => {
		// The gap the idempotency case above does not reach. There, the incoming
		// body still carried the key, so `dropped` was empty and the guard
		// returned before appending anything. Here a DIFFERENT key drops while
		// the body already carries an `## Attachments` section — which is what
		// happens to a spec that has been through this flow once already and
		// then has an inline image elsewhere rewritten away. Appending
		// unconditionally opened a second section each time, so the document
		// accumulated duplicate `## Attachments` headings.
		const keptKey = `story-media/${PROJECT_ID}/${STORY_ID}/kept.png`;
		const droppedKey = `story-media/${PROJECT_ID}/${STORY_ID}/dropped.png`;

		mocks.getStoryById.mockResolvedValue(
			makeStory({
				description: `Body with ${imgMarkdown(droppedKey)} inline.\n\n## Attachments\n\n${imgMarkdown(keptKey)}`,
			}),
		);

		// The rewrite keeps the Attachments section but loses the inline image.
		const incoming = `AI rewrite.\n\n## Attachments\n\n${imgMarkdown(keptKey)}`;
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		);

		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		const body = persisted.description as string;

		// Exactly one heading, and the recovered image is in the document.
		expect(body.match(/^##\s+Attachments\s*$/gm)).toHaveLength(1);
		expect(body).toContain(droppedKey);
		expect(body).toContain(keptKey);
	});

	it("empty prior: story.description is null — guard is a no-op regardless of incoming", async () => {
		mocks.getStoryById.mockResolvedValue(makeStory({ description: null }));

		const incoming = "AI rewrite with no prior image to preserve.";
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		);

		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(persisted.description).toBe(incoming);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		expect(mocks.loggerWarn).not.toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.anything(),
		);
	});

	it("key-prefix safety: cross-project key is skipped and logged at error; well-formed keys still reinjected", async () => {
		const safeKey = `story-media/${PROJECT_ID}/${STORY_ID}/legit.png`;
		const evilKey = "story-media/OTHER-PROJECT/OTHER-STORY/leaked.png";
		mocks.getStoryById.mockResolvedValue(
			makeStory({
				description: [imgMarkdown(evilKey), imgMarkdown(safeKey)].join(
					"\n",
				),
			}),
		);

		const incoming = "AI rewrite that dropped both keys.";
		await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		);

		// The cross-project key must NOT be re-signed (defense in depth).
		expect(mocks.getSignedUrl).toHaveBeenCalledTimes(1);
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(
			safeKey,
			expect.anything(),
		);

		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(persisted.description).toContain("?signed=1");
		expect(persisted.description).not.toContain(evilKey);

		// Error log for the prefix violation.
		const errorCalls = mocks.loggerError.mock.calls.filter(
			(c) =>
				typeof c[0] === "string" &&
				(c[0] as string).includes("prefix safety check"),
		);
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0][1]).toMatchObject({
			surface: "update-with-context",
			key: evilKey,
			expectedPrefix: `story-media/${PROJECT_ID}/${STORY_ID}/`,
		});

		// Procedure still succeeded — guard is a recovery action, not an error.
		const warnCalls = mocks.loggerWarn.mock.calls.filter(
			(c) =>
				typeof c[0] === "string" &&
				(c[0] as string).startsWith("[stage-transition]"),
		);
		expect(warnCalls).toHaveLength(1);
		expect(warnCalls[0][1]).toMatchObject({
			droppedKeyCount: 1,
			droppedKeys: [safeKey],
		});
	});

	it("sign failure: one of two re-sign calls rejects — the successful key is reinjected, the failed one is skipped, procedure still succeeds", async () => {
		const goodKey = `story-media/${PROJECT_ID}/${STORY_ID}/good.png`;
		const flakyKey = `story-media/${PROJECT_ID}/${STORY_ID}/flaky.png`;
		mocks.getStoryById.mockResolvedValue(
			makeStory({
				description: [imgMarkdown(goodKey), imgMarkdown(flakyKey)].join(
					"\n",
				),
			}),
		);

		mocks.getSignedUrl.mockImplementation(async (key: string) => {
			if (key === flakyKey) {
				throw new Error("S3 NoSuchKey");
			}
			return `https://stub-bucket.local/${key}?signed=1`;
		});

		const incoming = "AI rewrite that dropped both images.";
		const result = (await handlers.updateWithContext(
			applyInput({ confirmedDescription: incoming }),
		)) as { applied: boolean };

		expect(result.applied).toBe(true);

		const persisted = mocks.updateStory.mock.calls[0][2] as {
			description?: string;
		};
		expect(persisted.description).toContain("## Attachments");
		expect(persisted.description).toContain(
			`![](https://stub-bucket.local/${goodKey}?signed=1)`,
		);
		// The flaky key's markdown image line is not in the reinjected block.
		expect(persisted.description).not.toContain(
			`![](https://stub-bucket.local/${flakyKey}?signed=1)`,
		);

		// Error log for the sign failure.
		const errorCalls = mocks.loggerError.mock.calls.filter(
			(c) =>
				typeof c[0] === "string" &&
				(c[0] as string).includes("failed to re-sign"),
		);
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0][1]).toMatchObject({
			surface: "update-with-context",
			key: flakyKey,
		});

		// The warn log reflects only the keys that actually made it into the
		// reinjected block, not the failed ones.
		const warnArgs = mocks.loggerWarn.mock.calls.find(
			(c) => c[0] === "[stage-transition] reinjected dropped attachments",
		)?.[1] as Record<string, unknown>;
		expect(warnArgs?.droppedKeyCount).toBe(1);
		expect(warnArgs?.droppedKeys).toEqual([goodKey]);
	});
});
