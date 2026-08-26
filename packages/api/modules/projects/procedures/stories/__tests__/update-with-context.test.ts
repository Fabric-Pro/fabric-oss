/**
 * Fizzy #2048 — the work item "Update using context" path becomes kind-aware.
 *
 * The shared engine keeps ONE system prompt; kind-awareness enters through this
 * caller, which resolves a kind-scoped instruction addendum from the prompt
 * catalog off the item's STORED kind and hands it to the engine. Three things
 * are asserted here, and each one is a way the flow previously went wrong or
 * could newly go wrong:
 *
 *  1. The kind comes from the row this handler loads, never from the caller. A
 *     reviewer can convert an item from the roadmap card while the detail view
 *     holds a stale copy.
 *  2. Nothing bound for a kind means NO addendum — the engine stays on its own
 *     system prompt. It never borrows the other kind's record; the wrong kind's
 *     instructions are worse than none.
 *  3. The `## Description` / `## Acceptance Criteria` wrapper survives. Those
 *     headings are the anchors `parseUpdatedDocument` splits the reply on, so a
 *     bug's stored criteria must round-trip through them unchanged rather than
 *     coming back empty and proposing to wipe the column.
 *
 * Mocks `@repo/database`, `@repo/storage`, `@repo/config`, `@repo/logs`,
 * `@repo/temporal`, the PM-comment fetch, `enqueuePmSync` and the oRPC procedure
 * base so the handler can be invoked directly.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getStoryById: vi.fn(),
		updateStory: vi.fn(),
		setLastContextUpdateAt: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		enqueuePmSync: vi.fn(),
		fetchProjectContextSources: vi.fn(),
		fetchStoryPmComments: vi.fn(),
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
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "test-bucket" } } },
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ type: "s3", getSignedUrl: vi.fn() }),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/temporal", () => ({
	fetchProjectContextSources: mocks.fetchProjectContextSources,
	runContextUpdate: mocks.runContextUpdate,
	ContextUpdateTruncatedError: class ContextUpdateTruncatedError extends Error {},
}));

vi.mock("../../shared/pm-comments-context", () => ({
	fetchStoryPmComments: mocks.fetchStoryPmComments,
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
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

const PROJECT_ID = "project-1";
const STORY_ID = "story-1";

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

/** The catalog coordinates the caller must use — one agent key, kind-scoped. */
const CONTEXT_UPDATE_AGENT = "context_update_instructions";
const CONTEXT_UPDATE_DOCUMENT_TYPE = "CONTEXT_UPDATE";

const BUG_ADDENDUM =
	"The specification you are editing is a BUG report. Keep the diagnostic sections; add no feature-narrative sections.";
const FEATURE_ADDENDUM =
	"The specification you are editing is a FEATURE. Add no bug diagnostic sections.";

/** A bug body carrying the sections the structure guards recognise. */
const BUG_BODY = [
	"The export button silently does nothing on the roadmap view.",
	"",
	"## Steps to Reproduce",
	"1. Open the roadmap view.",
	"2. Press Export.",
	"",
	"## Expected Result",
	"A CSV download starts.",
	"",
	"## Actual Result",
	"Nothing happens and no error is shown.",
	"",
	"## Environment",
	"Latest release, desktop browser.",
	"",
	"## Impact",
	"Reviewers cannot export a roadmap at all.",
].join("\n");

const BUG_CRITERIA = [
	"- Pressing Export downloads a CSV of the visible rows.",
	"- A failure surfaces an error instead of failing silently.",
].join("\n");

function makeStory(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: STORY_ID,
		projectId: PROJECT_ID,
		title: "Export does nothing",
		description: BUG_BODY,
		acceptanceCriteria: BUG_CRITERIA,
		draftingStage: "DRAFT",
		kind: "BUG",
		identifier: "B-001",
		version: 4,
		externalId: null,
		externalUrl: null,
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		...overrides,
	};
}

function previewInput(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		input: {
			projectId: PROJECT_ID,
			storyId: STORY_ID,
			organizationId: null,
			preview: true,
			...overrides,
		},
		context: ctx,
	};
}

/** The single argument object the handler hands the shared engine. */
function engineArgs(): Record<string, unknown> {
	expect(mocks.runContextUpdate).toHaveBeenCalledTimes(1);
	return mocks.runContextUpdate.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.getStoryById.mockResolvedValue(makeStory());
	mocks.fetchProjectContextSources.mockResolvedValue({
		contextItems: [
			{
				sourceLabel: "DSU",
				sourceType: "TRANSCRIPT",
				sourceDate: "2026-05-04",
				sourceLinkOrId: "ctx-1",
				content: "Export was re-scoped to CSV only.",
			},
		],
		transcriptCount: 1,
		teamsCount: 0,
		slackCount: 0,
		huddleNotesCount: 0,
		featureDecisionCount: 0,
		retrievalFailed: false,
	});
	mocks.fetchStoryPmComments.mockResolvedValue([]);
	mocks.getBoundPromptForAgent.mockResolvedValue({
		key: "bug_context_update_instructions",
		version: { content: BUG_ADDENDUM },
	});
	mocks.runContextUpdate.mockResolvedValue({
		hasRelevantContext: true,
		updatedDocument: `## Description\n\n${BUG_BODY}\n\n## Acceptance Criteria\n\n${BUG_CRITERIA}`,
		needsHumanResolution: false,
		summary: "Applied the re-scope.",
	});
});

describe("updateWithContextProcedure — kind-scoped instruction addendum", () => {
	it("a bug run resolves and appends the bug addendum", async () => {
		await handlers.updateWithContext(previewInput());

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledTimes(1);
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: CONTEXT_UPDATE_AGENT,
				documentType: CONTEXT_UPDATE_DOCUMENT_TYPE,
				storyKind: "BUG",
				userId: "user-1",
			}),
		);
		expect(engineArgs().instructionAddendum).toBe(BUG_ADDENDUM);
	});

	it("a feature run resolves and appends the feature addendum", async () => {
		mocks.getStoryById.mockResolvedValue(
			makeStory({ kind: "FEATURE", identifier: "F-001" }),
		);
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "feature_context_update_instructions",
			version: { content: FEATURE_ADDENDUM },
		});

		await handlers.updateWithContext(previewInput());

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({ storyKind: "FEATURE" }),
		);
		expect(engineArgs().instructionAddendum).toBe(FEATURE_ADDENDUM);
	});

	it("the STORED kind decides, not anything the caller sends", async () => {
		// The input schema has no kind field at all — this bogus one stands in for
		// a stale client that believes the item is still a feature. The item was
		// converted to a bug from another surface, and the bug record is what must
		// resolve.
		await handlers.updateWithContext(previewInput({ kind: "FEATURE" }));

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({ storyKind: "BUG" }),
		);
	});

	it("nothing bound for this kind: no addendum is passed and the other kind's is not substituted", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue(null);

		await handlers.updateWithContext(previewInput());

		const args = engineArgs();
		expect("instructionAddendum" in args).toBe(false);
		expect(JSON.stringify(args)).not.toContain(FEATURE_ADDENDUM);
	});

	it("a bound record with blank content is treated as unbound", async () => {
		mocks.getBoundPromptForAgent.mockResolvedValue({
			key: "bug_context_update_instructions",
			version: { content: "   \n\t " },
		});

		await handlers.updateWithContext(previewInput());

		expect("instructionAddendum" in engineArgs()).toBe(false);
	});

	it("a failed lookup is logged and degrades to no addendum rather than failing the update", async () => {
		mocks.getBoundPromptForAgent.mockRejectedValue(new Error("db down"));

		const result = (await handlers.updateWithContext(previewInput())) as {
			hasRelevantContext: boolean;
		};

		expect("instructionAddendum" in engineArgs()).toBe(false);
		expect(result.hasRelevantContext).toBe(true);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[UpdateWithContext] kind-scoped instruction lookup failed",
			expect.objectContaining({ storyKind: "BUG", storyId: STORY_ID }),
		);
	});
});

describe("updateWithContextProcedure — the bug round trip", () => {
	it("a bug's stored acceptance criteria come back unchanged", async () => {
		const result = (await handlers.updateWithContext(previewInput())) as {
			proposedDescription: string;
			proposedAcceptanceCriteria: string | null;
		};

		// The regression this guards: an AC heading missing from the reply parses
		// as `""`, which is proposed as the new value — i.e. a proposal to wipe the
		// bug's stored criteria.
		expect(result.proposedAcceptanceCriteria).toBe(BUG_CRITERIA);
		expect(result.proposedAcceptanceCriteria).not.toBe("");
	});

	it("the diagnostic sections survive into the proposed description", async () => {
		const result = (await handlers.updateWithContext(previewInput())) as {
			proposedDescription: string;
		};

		for (const section of [
			"## Steps to Reproduce",
			"## Expected Result",
			"## Actual Result",
			"## Environment",
			"## Impact",
		]) {
			expect(result.proposedDescription).toContain(section);
		}
		expect(result.proposedDescription).not.toContain("## Description");
	});

	it("the load-bearing wrapper headings are still what the engine is handed", async () => {
		await handlers.updateWithContext(previewInput());

		const documentMarkdown = engineArgs().documentMarkdown as string;
		expect(documentMarkdown.startsWith("## Description")).toBe(true);
		expect(documentMarkdown).toContain("\n## Acceptance Criteria\n");
		expect(documentMarkdown).toContain(BUG_CRITERIA);
	});
});

describe("the document path passes no addendum (R10)", () => {
	it("the interactive document procedure never names the field", () => {
		// Asserted against the source rather than by driving the procedure: the
		// ONLY reason the document path would name `instructionAddendum` is to
		// pass one, and passing one moves a system string that must not move.
		const source = readFileSync(
			new URL("../../documents/update-with-context.ts", import.meta.url),
			"utf8",
		);

		expect(source).toContain("runContextUpdate({");
		expect(source).not.toContain("instructionAddendum");
	});
});
