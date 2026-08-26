/**
 * Tests for the type-conversion body regeneration activity (Fizzy #2048).
 *
 * This is the one AI rewrite that lands in the database with nobody reviewing
 * the diff, so these tests pin the behaviours that stand in for that review:
 * what gets written, what refuses to be written, who history credits, and which
 * guard is allowed anywhere near the path.
 *
 * The model call is NOT stubbed out at `draftBodyByKind`. `getBoundPromptForAgent`
 * resolves a template whose content names the agent it was bound under, and the
 * `generateObject` stub answers with the body THAT template would produce. So an
 * assertion on the persisted body is an assertion about which template actually
 * ran — a test that only checked which prompt was resolved would not prove that
 * the body the user ends up with changed shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		// @repo/ai
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		// @repo/database
		getStoryById: vi.fn(),
		createFeatureVersion: vi.fn(),
		updateStory: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		getPromptById: vi.fn(),
		createStory: vi.fn(),
		buildFabricStoryUrl: vi.fn(),
		projectFindUnique: vi.fn(),
		promptVersionFindFirst: vi.fn(),
		// @repo/logs
		loggerInfo: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
		// @repo/rag
		retrieveProjectContexts: vi.fn(),
		formatContextsForPrompt: vi.fn(),
		fetchLiveIntegrationContext: vi.fn(),
		formatLiveContextForPrompt: vi.fn(),
		// @repo/utils
		renderTemplate: vi.fn(),
		// @repo/storage
		getSignedUrl: vi.fn(),
		// classifier (imported by create-story-from-proposal)
		classifyWorkItem: vi.fn(),
		// the guard that must NEVER run on this path
		detectDestructiveRewrite: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));
vi.mock("@repo/database", () => ({
	buildFabricStoryUrl: mocks.buildFabricStoryUrl,
	createFeatureVersion: mocks.createFeatureVersion,
	createStory: mocks.createStory,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		promptVersion: { findFirst: mocks.promptVersionFindFirst },
	},
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getPromptById: mocks.getPromptById,
	getStoryById: mocks.getStoryById,
	// Faithful mini-implementation: the activity now distinguishes a lost race
	// by type rather than by message, so the mock has to hand back a real class
	// — `instanceof` compares identity, and a stub would make every write look
	// like a genuine failure.
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
	// Faithful mini-implementation: the anchor lands at the end of the
	// acceptance criteria when there are any, else at the end of the body.
	placeFabricBackLink: ({
		description,
		acceptanceCriteria,
		fabricUrl,
	}: {
		description: string | null | undefined;
		acceptanceCriteria: string | null | undefined;
		fabricUrl: string;
	}) => {
		const anchor = `<p><a href="${fabricUrl}">View in Fabric</a></p>`;
		const criteria = (acceptanceCriteria ?? "").trim();
		return criteria.length > 0
			? {
					description: description ?? "",
					acceptanceCriteria: `${criteria}\n${anchor}`,
				}
			: {
					description: `${description ?? ""}\n${anchor}`,
					acceptanceCriteria: null,
				};
	},
	updateStory: mocks.updateStory,
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		debug: vi.fn(),
	},
}));
vi.mock("@repo/rag", () => ({
	formatContextsForPrompt: mocks.formatContextsForPrompt,
	retrieveProjectContexts: mocks.retrieveProjectContexts,
}));
vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: mocks.fetchLiveIntegrationContext,
	formatLiveContextForPrompt: mocks.formatLiveContextForPrompt,
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ getSignedUrl: mocks.getSignedUrl }),
}));
vi.mock("@repo/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/utils")>();
	return { ...actual, renderTemplate: mocks.renderTemplate };
});
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../src/lib/classify-work-item", () => ({
	classifyWorkItem: mocks.classifyWorkItem,
}));
/**
 * The section-signature matcher is wrapped, not replaced: the real
 * implementation still runs for anyone who calls it, but this path must never be
 * one of them, and the spy is how that is asserted. `detectContentFloorBreach`
 * is deliberately left REAL — the content floor is the thing under test.
 */
vi.mock("../src/lib/structure-guards", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/lib/structure-guards")>();
	return {
		...actual,
		detectDestructiveRewrite:
			mocks.detectDestructiveRewrite.mockImplementation(
				actual.detectDestructiveRewrite,
			),
	};
});

import { StoryVersionConflictError } from "@repo/database";
import { regenerateBodyForKindActivity } from "../src/activities/stories/regenerate-body-for-kind";
import {
	BUG_SIGNATURE_SECTIONS,
	FEATURE_ONLY_SECTIONS,
} from "../src/lib/structure-guards";

// =============================================================================
// Fixtures
// =============================================================================

const PROJECT_ID = "p1";
const STORY_ID = "s1";
const ORG_ID = "org-1";
/** The user who pressed Convert. Never the author of the body being replaced. */
const ACTOR_ID = "u1";
/** The author of the work item, and so of the body being replaced. */
const AUTHOR_ID = "author-1";

const TITLE = "Roadmap export finishes with an empty archive";

/** A bug-shaped body: every heading is from BUG_SIGNATURE_SECTIONS. */
const BUG_BODY = [
	"## Steps to Reproduce",
	"1. Open a project holding more than five hundred work items.",
	"2. Choose Export from the roadmap toolbar and confirm the dialog.",
	"3. Wait for the browser download to finish and open the archive.",
	"",
	"## Expected Result",
	"The downloaded archive contains one markdown file per work item, each with",
	"its identifier, title and body.",
	"",
	"## Actual Result",
	"The archive downloads but holds a single zero-byte file with no name.",
	"",
	"## Environment",
	"Current release, desktop browser, a project well past the item ceiling.",
	"",
	"## Impact",
	"Nobody on the team can take an offline copy of the backlog, which blocks",
	"the offline review that happens before every planning session.",
	"",
	"## Root Cause",
	"Unknown, pending investigation by whoever picks this up next.",
].join("\n");

/** A feature-shaped body: every heading is from FEATURE_ONLY_SECTIONS. */
const FEATURE_BODY = [
	"## Feature Narrative",
	"Exporting the roadmap should produce a readable offline copy of the backlog",
	"so a planning session can run without the app open in front of everyone.",
	"",
	"## User Story",
	"As a delivery lead, I want the roadmap export to contain every work item so",
	"that I can review the backlog offline before planning.",
	"",
	"## Benefit Hypothesis",
	"Planning sessions stop stalling on people re-reading items in the app, and",
	"the offline copy becomes the artifact the session is run from.",
].join("\n");

const FEATURE_CRITERIA = [
	"- GIVEN a project with work items WHEN the export finishes THEN the archive",
	"  contains one file per item.",
	"- GIVEN an empty project WHEN the export finishes THEN the archive is empty",
	"  rather than absent.",
].join("\n");

/** What the FEATURE template returns when it redraws the bug body. */
const FEATURE_REDRAFT = [
	"## Feature Narrative",
	"The roadmap export should hand back a complete offline copy of the backlog,",
	"one file per work item, so the export is trustworthy for planning work.",
	"",
	"## User Story",
	"As a delivery lead, I want every work item in the exported archive so that",
	"the offline copy matches what the roadmap shows.",
	"",
	"## Benefit Hypothesis",
	"Teams stop re-checking the app during planning because the exported copy is",
	"known to be complete.",
].join("\n");

const FEATURE_REDRAFT_CRITERIA = [
	"- GIVEN a large project WHEN the export finishes THEN every work item has a",
	"  file in the archive.",
].join("\n");

/** What the BUG template returns when it redraws the feature body. */
const BUG_REDRAFT = [
	"## Steps to Reproduce",
	"1. Open a project holding more than five hundred work items.",
	"2. Choose Export from the roadmap toolbar.",
	"3. Open the downloaded archive.",
	"",
	"## Expected Result",
	"One markdown file per work item is present in the archive.",
	"",
	"## Actual Result",
	"The archive holds a single zero-byte file.",
	"",
	"## Environment",
	"Current release, desktop browser, a project past the item ceiling.",
	"",
	"## Impact",
	"The offline copy the team plans from cannot be produced at all.",
].join("\n");

interface StoryOverrides {
	kind?: "BUG" | "FEATURE";
	description?: string | null;
	acceptanceCriteria?: string | null;
	version?: number;
	lastEditedSource?: string | null;
	createdById?: string;
}

function storyRow(overrides: StoryOverrides = {}) {
	return {
		id: STORY_ID,
		projectId: PROJECT_ID,
		title: TITLE,
		kind: overrides.kind ?? "FEATURE",
		description:
			overrides.description === undefined
				? BUG_BODY
				: overrides.description,
		acceptanceCriteria: overrides.acceptanceCriteria ?? null,
		draftingStage: "DRAFT",
		version: overrides.version ?? 4,
		createdById: overrides.createdById ?? AUTHOR_ID,
		lastEditedSource: overrides.lastEditedSource ?? null,
		needsMoreInfo: false,
	};
}

const INPUT = {
	storyId: STORY_ID,
	projectId: PROJECT_ID,
	organizationId: ORG_ID,
	userId: ACTOR_ID,
};

/**
 * Bind both kinds' Clean Spec templates and make the model answer with the body
 * the RESOLVED template would produce. The template's content names the agent it
 * came from, so the branch below is the coupling under test.
 */
function bindTemplatesToRedrafts() {
	mocks.getBoundPromptForAgent.mockImplementation(
		async ({ agentName }: { agentName: string }) => ({
			version: { content: `TEMPLATE::${agentName}` },
			format: "MARKDOWN",
			key: agentName,
		}),
	);
	mocks.generateObject.mockImplementation(
		async ({ prompt }: { prompt: string }) => {
			if (prompt.includes("TEMPLATE::feature_clean_spec_generator")) {
				return {
					object: {
						description: FEATURE_REDRAFT,
						acceptanceCriteria: FEATURE_REDRAFT_CRITERIA,
					},
					usage: {},
				};
			}
			if (prompt.includes("TEMPLATE::bug_clean_spec_generator")) {
				return {
					object: {
						title: "",
						needsMoreInfo: true,
						markdown: BUG_REDRAFT,
					},
					usage: {},
				};
			}
			throw new Error("no recognisable template reached the model");
		},
	);
}

/** The `data` argument of the single `updateStory` write. */
function writtenData() {
	expect(mocks.updateStory).toHaveBeenCalledTimes(1);
	return mocks.updateStory.mock.calls[0][2] as {
		description: string;
		acceptanceCriteria: string | null;
		needsMoreInfo: boolean;
	};
}

/** The `versionContext` argument of the single `updateStory` write. */
function writtenVersionContext() {
	expect(mocks.updateStory).toHaveBeenCalledTimes(1);
	return mocks.updateStory.mock.calls[0][3] as Record<string, unknown>;
}

/** Which of `needles` appear as markdown headings in `body`. */
function headingsFrom(body: string, needles: readonly string[]): string[] {
	const headings = body
		.split("\n")
		.filter((line) => /^#{1,6}\s/.test(line.trim()))
		.map((line) => line.trim().toLowerCase());
	return needles.filter((needle) =>
		headings.some((heading) => heading.includes(needle.toLowerCase())),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
	mocks.renderTemplate.mockImplementation(
		async ({ template }: { template: string }) => ({
			rendered: template,
			error: null,
		}),
	);
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.projectFindUnique.mockResolvedValue({ organizationId: ORG_ID });
	mocks.buildFabricStoryUrl.mockResolvedValue(
		"https://app.example/app/projects/p1/stories/s1",
	);
	mocks.createFeatureVersion.mockResolvedValue({ id: "fv1" });
	mocks.updateStory.mockResolvedValue({ id: STORY_ID });
	mocks.detectDestructiveRewrite.mockClear();
	bindTemplatesToRedrafts();
});

// =============================================================================
// The rewrite itself
// =============================================================================

describe("regenerateBodyForKindActivity — the rewrite", () => {
	it("regenerates a bug-shaped body through the FEATURE template after a conversion to feature", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: BUG_BODY }),
		);

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result).toMatchObject({
			status: "regenerated",
			kind: "FEATURE",
		});
		// Resolved from the STORED kind, not from anything the caller passed.
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "feature_clean_spec_generator",
				storyKind: "FEATURE",
			}),
		);
		expect(writtenData().description).toContain("## Benefit Hypothesis");
	});

	it("regenerates a feature-shaped body through the BUG template after a conversion to bug", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({
				kind: "BUG",
				description: FEATURE_BODY,
				acceptanceCriteria: FEATURE_CRITERIA,
			}),
		);

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result).toMatchObject({ status: "regenerated", kind: "BUG" });
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "bug_clean_spec_generator",
				storyKind: "BUG",
			}),
		);
		expect(writtenData().description).toContain("## Steps to Reproduce");
	});

	/**
	 * The requirement is about the BODY THE USER ENDS UP WITH, so it is asserted
	 * on the persisted output using the guard's own section vocabulary rather
	 * than on which prompt was resolved.
	 */
	it.each([
		{
			label: "bug converted to feature",
			kind: "FEATURE" as const,
			body: BUG_BODY,
			expected: FEATURE_ONLY_SECTIONS,
			forbidden: BUG_SIGNATURE_SECTIONS,
		},
		{
			label: "feature converted to bug",
			kind: "BUG" as const,
			body: FEATURE_BODY,
			expected: BUG_SIGNATURE_SECTIONS,
			forbidden: FEATURE_ONLY_SECTIONS,
		},
	])(
		"persists the target kind's signature sections and none of the source kind's ($label)",
		async ({ kind, body, expected, forbidden }) => {
			mocks.getStoryById.mockResolvedValue(
				storyRow({ kind, description: body }),
			);

			await regenerateBodyForKindActivity(INPUT);

			const persisted = writtenData().description;
			// The prior body carried the source kind's signature...
			expect(headingsFrom(body, forbidden).length).toBeGreaterThan(0);
			// ...and the persisted body carries the target kind's instead.
			expect(headingsFrom(persisted, expected).length).toBeGreaterThan(1);
			expect(headingsFrom(persisted, forbidden)).toEqual([]);
		},
	);

	it("clears acceptance criteria when the target kind is BUG", async () => {
		// The bleed this closes: `draftBodyByKind` falls back to the INPUT
		// criteria because the bug schema never returns any, so persisting what
		// it returns would leave a converted bug holding its feature checklist.
		mocks.getStoryById.mockResolvedValue(
			storyRow({
				kind: "BUG",
				description: FEATURE_BODY,
				acceptanceCriteria: FEATURE_CRITERIA,
			}),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(writtenData().acceptanceCriteria).toBeNull();
		expect(writtenData().description).not.toContain("GIVEN a project");
	});

	it("takes acceptance criteria from the redraft when the target kind is FEATURE", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: BUG_BODY }),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(writtenData().acceptanceCriteria).toContain(
			"every work item has a",
		);
	});

	it("persists the needsMoreInfo the bug redraft returned", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "BUG", description: FEATURE_BODY }),
		);

		await regenerateBodyForKindActivity(INPUT);

		// The bug template stub reports the report is still ambiguous.
		expect(writtenData().needsMoreInfo).toBe(true);
	});

	it("re-places the Fabric back-link on the regenerated body", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "BUG", description: FEATURE_BODY }),
		);

		await regenerateBodyForKindActivity(INPUT);

		// BUG clears the criteria, so the anchor belongs on the body.
		expect(writtenData().description).toContain(">View in Fabric</a>");
	});
});

// =============================================================================
// Refusals — the three mechanisms that replaced human diff review
// =============================================================================

describe("regenerateBodyForKindActivity — refusals", () => {
	it("writes nothing when no template is bound", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));
		mocks.getBoundPromptForAgent.mockResolvedValue(null);

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result.status).toBe("model_did_not_run");
		expect(mocks.updateStory).not.toHaveBeenCalled();
		// A refused regeneration writes NOTHING — not even the snapshot.
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
	});

	it("writes nothing when the model call fails, leaving the prior body intact", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));
		mocks.generateObject.mockRejectedValue(new Error("provider timeout"));

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result.status).toBe("model_did_not_run");
		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
	});

	it("writes nothing and records the reason when the redraft collapses the body", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: BUG_BODY }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { description: "## Feature Narrative\nTBD." },
			usage: {},
		});

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result).toMatchObject({
			status: "below_content_floor",
			reason: "body_collapsed",
		});
		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
		// The reason reaches the logs — a silent refusal is indistinguishable
		// from a regeneration that never started.
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("content floor"),
			expect.objectContaining({ reason: "body_collapsed" }),
		);
		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			"[regenerateBodyForKind] resolved",
			expect.objectContaining({
				outcome: "refused",
				reason: "body_collapsed",
			}),
		);
	});

	it("writes nothing when the redraft comes back empty", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: BUG_BODY }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { description: "   " },
			usage: {},
		});

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result).toMatchObject({
			status: "below_content_floor",
			reason: "empty_output",
		});
		expect(mocks.updateStory).not.toHaveBeenCalled();
	});

	it("writes nothing when the work item no longer exists", async () => {
		mocks.getStoryById.mockResolvedValue(null);

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result.status).toBe("story_not_found");
		expect(mocks.updateStory).not.toHaveBeenCalled();
	});
});

// =============================================================================
// The stale-write guard
// =============================================================================

describe("regenerateBodyForKindActivity — the stale-write guard", () => {
	it("writes under the row version captured before the model call", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", version: 7 }),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(writtenVersionContext()).toMatchObject({ expectedVersion: 7 });
	});

	it("discards a redraft that a double toggle back to the same kind left stale", async () => {
		// The scenario a kind-based compare-and-set cannot catch: this workflow
		// read the row as a BUG at version 4; by the time it writes, the item has
		// been toggled FEATURE and back to BUG and sits at version 6. The kind it
		// read is the kind it finds — only the version says the body is stale.
		const rowAtStart = storyRow({
			kind: "BUG",
			description: FEATURE_BODY,
			version: 4,
		});
		mocks.getStoryById.mockResolvedValue(rowAtStart);
		const versionNow = 6;
		mocks.updateStory.mockImplementation(
			async (
				_storyId: string,
				_projectId: string,
				_data: unknown,
				versionContext: { expectedVersion?: number },
			) => {
				if (versionContext?.expectedVersion !== versionNow) {
					throw new StoryVersionConflictError(STORY_ID);
				}
				return { id: STORY_ID };
			},
		);

		const result = await regenerateBodyForKindActivity(INPUT);

		expect(result).toMatchObject({ status: "stale", reason: "stale" });
		expect(writtenVersionContext()).toMatchObject({ expectedVersion: 4 });
		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			"[regenerateBodyForKind] resolved",
			expect.objectContaining({ outcome: "refused", reason: "stale" }),
		);
	});

	it("rethrows a write failure that is not a lost race, so Temporal can retry it", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));
		mocks.updateStory.mockRejectedValue(new Error("connection reset"));

		await expect(regenerateBodyForKindActivity(INPUT)).rejects.toThrow(
			"connection reset",
		);
	});
});

// =============================================================================
// Inline images
// =============================================================================

describe("regenerateBodyForKindActivity — inline images", () => {
	const MEDIA_KEY = `story-media/${PROJECT_ID}/${STORY_ID}/screenshot.png`;
	const bodyWithImage = `${BUG_BODY}\n\n![](${MEDIA_KEY})`;

	it("keeps the images when the model returns them", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: bodyWithImage }),
		);
		mocks.generateObject.mockResolvedValue({
			object: {
				description: `${FEATURE_REDRAFT}\n\n![](${MEDIA_KEY})`,
				acceptanceCriteria: FEATURE_REDRAFT_CRITERIA,
			},
			usage: {},
		});

		await regenerateBodyForKindActivity(INPUT);

		expect(writtenData().description).toContain(MEDIA_KEY);
		// Nothing was dropped, so nothing needed re-signing.
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("reinjects the images when the model drops them", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: bodyWithImage }),
		);
		mocks.getSignedUrl.mockResolvedValue(
			`https://storage.example/${MEDIA_KEY}?signature=abc`,
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.getSignedUrl).toHaveBeenCalledWith(
			MEDIA_KEY,
			expect.objectContaining({ expiresIn: 3600 }),
		);
		const persisted = writtenData().description;
		expect(persisted).toContain("## Attachments");
		expect(persisted).toContain(MEDIA_KEY);
	});

	it("skips a key that does not belong to this work item's keyspace", async () => {
		const foreignKey = "story-media/other-project/other-story/leak.png";
		mocks.getStoryById.mockResolvedValue(
			storyRow({
				kind: "FEATURE",
				description: `${BUG_BODY}\n\n![](${foreignKey})`,
			}),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
		expect(writtenData().description).not.toContain(foreignKey);
		expect(mocks.loggerError).toHaveBeenCalledWith(
			expect.stringContaining("out-of-prefix"),
			expect.objectContaining({ key: foreignKey }),
		);
	});
});

// =============================================================================
// Tenant plumbing
// =============================================================================

describe("regenerateBodyForKindActivity — tenant plumbing", () => {
	it("passes the organization and the user through to the redraft unchanged", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));

		await regenerateBodyForKindActivity(INPUT);

		// Template binding resolves in the organization's scope...
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG_ID,
				userId: ACTOR_ID,
			}),
		);
		// ...and so do the AI model settings and the retrieval context.
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				userId: ACTOR_ID,
			}),
		);
		expect(mocks.retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG_ID,
				userId: ACTOR_ID,
			}),
		);
	});

	it("resolves in personal context when there is no organization", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));

		await regenerateBodyForKindActivity({
			...INPUT,
			organizationId: null,
		});

		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: undefined,
				userId: ACTOR_ID,
			}),
		);
	});
});

// =============================================================================
// Version history attribution
// =============================================================================

describe("regenerateBodyForKindActivity — version history", () => {
	it("snapshots the prior body before the rewrite, attributed to its own author", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({
				kind: "FEATURE",
				description: BUG_BODY,
				acceptanceCriteria: FEATURE_CRITERIA,
				version: 4,
				createdById: AUTHOR_ID,
			}),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.createFeatureVersion).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: STORY_ID,
				version: 4,
				description: BUG_BODY,
				acceptanceCriteria: FEATURE_CRITERIA,
				// The author of the content being replaced — NOT the user who
				// pressed Convert. History must not show a user's name against
				// content an AI replaced.
				changedBy: AUTHOR_ID,
			}),
		);
		expect(mocks.createFeatureVersion).not.toHaveBeenCalledWith(
			expect.objectContaining({ changedBy: ACTOR_ID }),
		);
	});

	it("credits nobody when the body it is replacing was itself AI-written", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({
				kind: "FEATURE",
				lastEditedSource: "AI_BACKLOG_UPDATE",
			}),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.createFeatureVersion).toHaveBeenCalledWith(
			expect.objectContaining({ changedBy: undefined }),
		);
	});

	it("attributes the regenerated body to the AI, not to the converting user", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));

		await regenerateBodyForKindActivity(INPUT);

		expect(writtenVersionContext()).toMatchObject({
			lastEditedByName: null,
			lastEditedSource: "AI_MATURATION",
		});
	});
});

// =============================================================================
// The guard that must never run here
// =============================================================================

describe("regenerateBodyForKindActivity — guard selection", () => {
	it("never calls the section-signature matcher on a successful regeneration", async () => {
		// Running it would refuse this conversion by construction: a bug body
		// redrawn in feature shape drops every bug section BY DESIGN, so
		// `bug_sections_dropped` would fire deterministically.
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: BUG_BODY }),
		);

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
		expect(mocks.detectDestructiveRewrite).not.toHaveBeenCalled();
	});

	it("never calls the section-signature matcher on a refused regeneration either", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ kind: "FEATURE", description: BUG_BODY }),
		);
		mocks.generateObject.mockResolvedValue({
			object: { description: "## Feature Narrative\nTBD." },
			usage: {},
		});

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.detectDestructiveRewrite).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Observability
// =============================================================================

describe("regenerateBodyForKindActivity — resolution log", () => {
	it("records the resolved key, kind, entry point and outcome on a hit", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			"[regenerateBodyForKind] resolved",
			expect.objectContaining({
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				storyKind: "FEATURE",
				documentType: "CLEAN_SPEC",
				agentName: "feature_clean_spec_generator",
				entryPoint: "typeConversionRegeneration",
				outcome: "hit",
				promptKey: "feature_clean_spec_generator",
				promptSource: "bound",
			}),
		);
	});

	it("records a miss when nothing was bound", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));
		mocks.getBoundPromptForAgent.mockResolvedValue(null);

		await regenerateBodyForKindActivity(INPUT);

		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			"[regenerateBodyForKind] resolved",
			expect.objectContaining({
				outcome: "miss",
				promptKey: null,
				promptSource: null,
			}),
		);
	});

	it("never logs resolved prompt content", async () => {
		mocks.getStoryById.mockResolvedValue(storyRow({ kind: "FEATURE" }));

		await regenerateBodyForKindActivity(INPUT);

		// The stub's template content is `TEMPLATE::<agent>`; the key alone is
		// `<agent>`. Prompt bodies are tenant-authored and must never reach a log.
		const logged = JSON.stringify([
			...mocks.loggerInfo.mock.calls,
			...mocks.loggerWarn.mock.calls,
			...mocks.loggerError.mock.calls,
		]);
		expect(logged).not.toContain("TEMPLATE::");
	});
});
