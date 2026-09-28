/**
 * `projects.glossy.get` (Fizzy #2589, R4, R5, R7, R9, KTD5, KTD6, KTD16,
 * KTD19, AE7, AE10).
 *
 * The permission decision and the Glossy gate are real, over the world in
 * `glossy-harness.ts`; the edition query, Temporal, and storage are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./glossy-harness")).databaseModule(),
);
vi.mock("@repo/temporal", async () =>
	(await import("./glossy-harness")).temporalModule(),
);
vi.mock("@repo/ai", async () => (await import("./glossy-harness")).aiModule());
vi.mock("@repo/storage", async () =>
	(await import("./glossy-harness")).storageModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./glossy-harness")).proceduresModule(),
);
vi.mock("../../../../../lib/audit", async () => ({
	recordAuditFromRequest: (await import("./glossy-harness")).mocks
		.recordAudit,
}));

import { config } from "@repo/config";
import { computeDocumentContentHash } from "@repo/database";
import type { EditionContent } from "@repo/utils/glossy/edition-content";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { requireGlossyEnabled } from "../../../lib/glossy-feature";
import { getGlossyEditionProcedure } from "../get-edition";
import {
	buildSummary,
	call,
	DOC_A,
	DOC_B,
	DOC_PRD,
	editionView,
	errorCode,
	mocks,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	PROPOSAL_BODY,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./glossy-harness";

usePermissionCheck(assertProjectPermission);

const PROJECT_CONTEXTS = config.storage.bucketNames.projectContexts;
const AVATARS = config.storage.bucketNames.avatars;

const ORG_CHART = {
	kind: "org_chart",
	nodes: [
		{ id: "a", label: "Alex", parentId: null },
		{ id: "s", label: "Sam", parentId: "a" },
	],
} as const;

function visual(specHash: string) {
	return {
		kind: "org_chart",
		spec: ORG_CHART,
		specHash,
		source: "detected" as const,
		reason: "Roles and ownership",
	};
}

const OWN_IMAGE = `document-media/${PROJECT_A}/${DOC_A}/one.png`;
const APPENDIX_IMAGE = `document-media/${PROJECT_A}/${DOC_A}/appendix.png`;

function content(): EditionContent {
	return {
		title: "Example Proposal",
		pipelineVersion: "test",
		lengthMode: "brief",
		mode: "roll_the_dice",
		sections: [
			{
				sectionKey: "sec-team",
				headingPath: ["Team"],
				heading: "Team",
				level: 2,
				markdown: "Alex leads delivery. Sam owns design.",
				wording: "rewritten",
				anchors: [
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: "vis-accepted" },
					},
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: "vis-stale" },
					},
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: "vis-discarded" },
					},
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: "vis-pending" },
					},
					{ blockIndex: 0, ref: { type: "image", s3Key: OWN_IMAGE } },
					// Stored content is data: each of these must be refused.
					{
						blockIndex: 0,
						ref: {
							type: "image",
							s3Key: `document-media/${PROJECT_B}/${DOC_B}/foreign.png`,
						},
					},
					{
						blockIndex: 0,
						ref: {
							type: "image",
							s3Key: `document-media/${PROJECT_A}/../${PROJECT_B}/escape.png`,
						},
					},
					{
						blockIndex: 0,
						ref: {
							type: "image",
							s3Key: `workspace-files/${ORG_A}/x.png`,
						},
					},
					// Same project, another document: outside the document's own
					// media, as the regular export's resolution scopes it.
					{
						blockIndex: 0,
						ref: {
							type: "image",
							s3Key: `document-media/${PROJECT_A}/doc-other/sibling.png`,
						},
					},
				],
			},
		],
		visuals: {
			"vis-accepted": visual("hash-accepted"),
			"vis-stale": visual("hash-regenerated"),
			"vis-discarded": visual("hash-discarded"),
			"vis-pending": visual("hash-pending"),
		},
		appendix: {
			sources: [],
			details: [],
			placeholders: [],
			assumptions: [],
			additionalMaterial: [
				{
					heading: "Appendix",
					level: 2,
					markdown: "Supporting material.",
					anchors: [
						{
							blockIndex: 0,
							ref: { type: "image", s3Key: APPENDIX_IMAGE },
						},
					],
				},
			],
		},
		report: {
			keptOriginal: [],
			droppedVisuals: [],
			unfilledSlots: [],
			scaffoldingUnrecognized: false,
		},
		provenance: {
			sourceTitle: "Example Proposal",
			sourceVersion: 5,
			builtAt: "2026-09-24T10:05:00.000Z",
		},
	};
}

function decision(
	visualKey: string,
	value: "ACCEPTED" | "DISCARDED",
	specHash: string | null,
) {
	return {
		visualKey,
		sectionKey: "sec-team",
		decision: value,
		specHash,
		decidedById: USERS.editor,
		updatedAt: new Date("2026-09-24T11:00:00.000Z"),
	};
}

/** A published edition built from the document as it is now. */
function publishedEdition(overrides: Record<string, unknown> = {}) {
	return editionView({
		content: content(),
		publishedBuildId: "build-1",
		publishedBuild: buildSummary({
			sourceContentHash: computeDocumentContentHash(PROPOSAL_BODY),
		}),
		latestAttempt: buildSummary({
			sourceContentHash: computeDocumentContentHash(PROPOSAL_BODY),
		}),
		decisions: [
			decision("vis-accepted", "ACCEPTED", "hash-accepted"),
			decision("vis-stale", "ACCEPTED", "hash-before-regenerate"),
			decision("vis-discarded", "DISCARDED", null),
			decision("vis-gone", "DISCARDED", null),
		],
		lastOptions: {
			mode: "align_first",
			lengthMode: "standard",
			styleDirection: "Crisp.",
			confirmedOpportunities: [
				{ sectionKey: "sec-team", kind: "org_chart" },
			],
			preparerOverrides: { primary: "#aabbcc", accents: [] },
		},
		...overrides,
	});
}

const get = (
	userId: string = USERS.editor,
	input: Record<string, unknown> = {
		projectId: PROJECT_A,
		documentId: DOC_A,
	},
) => call(getGlossyEditionProcedure, input, userId);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeEach(() => {
	resetWorld();
	resetMocks();
	mocks.getGlossyEdition.mockResolvedValue(publishedEdition());
});

describe("projects.glossy.get — a project guest with read access (AE7)", () => {
	it("reads the edition, its decisions, the preparer Brand kit and the recipient logo, and cannot edit", async () => {
		world.recipientBrands.set(PROJECT_A, {
			version: 3,
			name: "Example Client",
			website: "https://client.example.com",
			colors: ["#224466"],
			logoKey: `project-brand/${PROJECT_A}/recipient-brand/current/logo-1.png`,
			updatedAt: new Date("2026-09-20T09:00:00.000Z"),
		});

		const result = await get(USERS.guestViewer);

		expect(result.canEdit).toBe(false);
		const edition = result.edition as Record<string, unknown>;
		expect((edition.content as EditionContent).title).toBe(
			"Example Proposal",
		);
		expect(edition.outOfDate).toBe(false);
		// An acceptance of an older spec reads as pending; a discard of a
		// visual the content no longer holds is not listed.
		expect(edition.decisions).toEqual([
			{
				visualKey: "vis-accepted",
				decision: "ACCEPTED",
				decidedAt: new Date("2026-09-24T11:00:00.000Z"),
			},
			{
				visualKey: "vis-discarded",
				decision: "DISCARDED",
				decidedAt: new Date("2026-09-24T11:00:00.000Z"),
			},
		]);
		expect(edition.lastOptions).toEqual({
			mode: "align_first",
			lengthMode: "standard",
			styleDirection: "Crisp.",
			preparerOverrides: { primary: "#aabbcc", accents: [] },
		});

		const brand = result.brand as {
			preparer: Record<string, unknown>;
			recipient: Record<string, unknown>;
			recipientVersion: number;
		};
		// The host organization's kit, not the guest's own organization's.
		expect(brand.preparer).toEqual({
			name: "Example Org",
			logoUrl: `https://storage.example.com/${AVATARS}/org-a/logo.png?signed`,
			brandColorName: "ocean",
			accentColors: ["#123456"],
			guidance: "Calm and precise.",
		});
		expect(brand.recipient.name).toBe("Example Client");
		expect(brand.recipient.logoUrl).toBe(
			`https://storage.example.com/${PROJECT_CONTEXTS}/project-brand/${PROJECT_A}/recipient-brand/current/logo-1.png?signed`,
		);
		expect(brand.recipientVersion).toBe(3);
		expect(result.build).toEqual({ status: "idle" });
	});

	it("an organization editor on the same document can edit", async () => {
		expect((await get(USERS.editor)).canEdit).toBe(true);
		expect((await get(USERS.guestEditor)).canEdit).toBe(true);
	});
});

describe("projects.glossy.get — NOT_FOUND", () => {
	it("a guest of project A asking for project B's document", async () => {
		expect(
			await errorCode(
				get(USERS.guestViewer, {
					projectId: PROJECT_B,
					documentId: DOC_B,
				}),
			),
		).toBe("NOT_FOUND");
	});

	it("a document of project B named under project A", async () => {
		expect(
			await errorCode(
				get(USERS.guestViewer, {
					projectId: PROJECT_A,
					documentId: DOC_B,
				}),
			),
		).toBe("NOT_FOUND");
		expect(
			await errorCode(
				get(USERS.owner, { projectId: PROJECT_A, documentId: DOC_B }),
			),
		).toBe("NOT_FOUND");
	});

	it("another tenant", async () => {
		expect(await errorCode(get(USERS.outsider))).toBe("NOT_FOUND");
		expect(mocks.getGlossyEdition).not.toHaveBeenCalled();
	});

	it("a trashed project", async () => {
		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-09-23T00:00:00.000Z"),
		});
		expect(await errorCode(get(USERS.editor))).toBe("NOT_FOUND");
	});

	it("answers a caller with no tie in the same words whether the id is unknown, gated off, or real", async () => {
		type Middleware = (
			options: { next: () => Promise<unknown> },
			input: unknown,
		) => Promise<unknown>;
		// The procedure's own order: the rollout gate, then the permission
		// decision, then the handler.
		const refusal = async (projectId: string) => {
			const input = { projectId, documentId: DOC_A };
			try {
				await (requireGlossyEnabled() as unknown as Middleware)(
					{ next: () => get(USERS.outsider, input) },
					input,
				);
			} catch (error) {
				const { code, message } = error as {
					code?: string;
					message?: string;
				};
				return { code, message };
			}
			throw new Error("Expected the call to be refused");
		};

		const unknownId = await refusal("proj-unknown");
		world.flags.set(ORG_A, false);
		const gatedOff = await refusal(PROJECT_A);
		world.flags.set(ORG_A, true);
		const noTie = await refusal(PROJECT_A);

		expect(noTie).toEqual({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(unknownId).toEqual(noTie);
		expect(gatedOff).toEqual(noTie);
		expect(mocks.getGlossyEdition).not.toHaveBeenCalled();
	});

	it("covers AE10: the rollout gate off, for editors and viewers alike", async () => {
		world.flags.set(ORG_A, false);
		expect(await errorCode(get(USERS.editor))).toBe("NOT_FOUND");
		expect(await errorCode(get(USERS.guestViewer))).toBe("NOT_FOUND");
		expect(mocks.getGlossyEdition).not.toHaveBeenCalled();
	});
});

describe("projects.glossy.get — eligibility", () => {
	it("a PRD reads as not eligible", async () => {
		mocks.getGlossyEdition.mockResolvedValue(null);
		const result = await get(USERS.editor, {
			projectId: PROJECT_A,
			documentId: DOC_PRD,
		});
		expect(result.eligibility).toEqual({
			eligible: false,
			reason: "documentType",
		});
		expect(result.edition).toBeNull();
	});

	it("a generating document reads as not eligible", async () => {
		const document = world.documents.get(DOC_A);
		world.documents.set(DOC_A, {
			...(document as NonNullable<typeof document>),
			status: "GENERATING",
		});
		expect((await get()).eligibility).toEqual({
			eligible: false,
			reason: "generating",
		});
	});
});

describe("projects.glossy.get — out of date (R7, KTD6)", () => {
	it("reports out of date after a revert that leaves the version unchanged", async () => {
		const document = world.documents.get(DOC_A);
		world.documents.set(DOC_A, {
			...(document as NonNullable<typeof document>),
			content: `${PROPOSAL_BODY}\n\nAn older paragraph restored by a revert.`,
			version: 5,
		});

		const edition = (await get()).edition as Record<string, unknown>;

		expect(edition.builtFrom).toEqual({
			title: "Example Proposal",
			version: 5,
			builtAt: new Date("2026-09-24T10:05:00.000Z"),
		});
		expect(edition.outOfDate).toBe(true);
	});

	it("reports out of date after a title change", async () => {
		const document = world.documents.get(DOC_A);
		world.documents.set(DOC_A, {
			...(document as NonNullable<typeof document>),
			title: "Example Proposal v2",
		});
		expect(
			((await get()).edition as Record<string, unknown>).outOfDate,
		).toBe(true);
	});
});

describe("projects.glossy.get — build state (R9)", () => {
	it("a running build reports its step, progress and starter without asking Temporal", async () => {
		mocks.getGlossyEdition.mockResolvedValue(
			publishedEdition({
				currentBuildId: "build-2",
				currentBuild: buildSummary({
					id: "build-2",
					status: "BUILDING",
					startedById: USERS.guestEditor,
					heartbeatAt: minutesAgo(2),
					finishedAt: null,
					progressStep: "rewriting",
					sectionsDone: 1,
					sectionsTotal: 3,
				}),
			}),
		);

		const result = await get(USERS.guestViewer);

		expect(result.build).toMatchObject({
			status: "building",
			step: "rewriting",
			sectionsDone: 1,
			sectionsTotal: 3,
			startedBy: { id: USERS.guestEditor, name: "Gus Guest" },
		});
		expect(mocks.describe).not.toHaveBeenCalled();
	});

	it("a stale heartbeat reads as failed only once Temporal confirms the run is gone", async () => {
		const stuck = buildSummary({
			id: "build-2",
			status: "BUILDING",
			heartbeatAt: minutesAgo(45),
			finishedAt: null,
			workflowId: `glossy-edition-build-${DOC_A}-build-2`,
		});
		mocks.getGlossyEdition.mockResolvedValue(
			publishedEdition({
				currentBuildId: "build-2",
				currentBuild: stuck,
			}),
		);

		// Still running (e.g. queued for a worker slot): building.
		mocks.describe.mockResolvedValueOnce({ status: { name: "RUNNING" } });
		expect((await get()).build).toMatchObject({ status: "building" });

		// Temporal cannot be asked: live, not failed.
		mocks.describe.mockRejectedValueOnce(new Error("connection reset"));
		expect((await get()).build).toMatchObject({ status: "building" });

		// Timed out: failed, and the published edition stays readable.
		mocks.describe.mockResolvedValueOnce({ status: { name: "TIMED_OUT" } });
		const result = await get();
		expect(result.build).toMatchObject({
			status: "failed",
			errorCode: "BUILD_FAILED",
			stuck: true,
		});
		expect(
			(result.edition as Record<string, unknown>).lastRebuildFailed,
		).toBe(true);
		expect(mocks.describe).toHaveBeenLastCalledWith(
			`glossy-edition-build-${DOC_A}-build-2`,
		);
	});

	it("a failed first build reports its code and fixed message", async () => {
		mocks.getGlossyEdition.mockResolvedValue(
			editionView({
				latestAttempt: buildSummary({
					status: "FAILED",
					errorCode: "WORKFLOW_START_FAILED",
					errorMessage: "The build could not be started.",
				}),
			}),
		);

		const result = await get();

		expect(result.build).toMatchObject({
			status: "failed",
			errorCode: "WORKFLOW_START_FAILED",
			errorMessage: "The build could not be started.",
			stuck: false,
		});
		const edition = result.edition as Record<string, unknown>;
		expect(edition.content).toBeNull();
		expect(edition.lastRebuildFailed).toBe(false);
	});
});

describe("projects.glossy.get — signed reads (KTD16)", () => {
	it("signs only the document's own uploads under this project's prefix", async () => {
		const result = await get(USERS.guestViewer);

		expect(result.imageUrls).toEqual({
			[OWN_IMAGE]: `https://storage.example.com/${PROJECT_CONTEXTS}/${OWN_IMAGE}?signed`,
			[APPENDIX_IMAGE]: `https://storage.example.com/${PROJECT_CONTEXTS}/${APPENDIX_IMAGE}?signed`,
		});
		const signedKeys = mocks.getSignedUrl.mock.calls.map(([key]) => key);
		expect(signedKeys).not.toContain(
			`document-media/${PROJECT_B}/${DOC_B}/foreign.png`,
		);
		expect(signedKeys).not.toContain(
			`document-media/${PROJECT_A}/doc-other/sibling.png`,
		);
		expect(signedKeys.some((key) => String(key).includes(".."))).toBe(
			false,
		);
		expect(
			signedKeys.some((key) =>
				String(key).startsWith("workspace-files/"),
			),
		).toBe(false);
	});

	it("signs the recipient logo for as long as every other read the page holds", async () => {
		const recipientLogo = `project-brand/${PROJECT_A}/recipient-brand/current/logo-1.png`;
		world.recipientBrands.set(PROJECT_A, {
			version: 1,
			name: "Example Client",
			website: null,
			colors: [],
			logoKey: recipientLogo,
			updatedAt: new Date("2026-09-20T09:00:00.000Z"),
		});

		await get(USERS.guestViewer);

		const ttlOf = (key: string) =>
			(
				mocks.getSignedUrl.mock.calls.find(
					([signed]) => signed === key,
				)?.[1] as { expiresIn?: number } | undefined
			)?.expiresIn;
		// The page refreshes its signed reads only after 45 minutes, so a
		// shorter recipient read would break the cover logo in between.
		expect(ttlOf(OWN_IMAGE)).toBe(60 * 60);
		expect(ttlOf("org-a/logo.png")).toBe(60 * 60);
		expect(ttlOf(recipientLogo)).toBe(ttlOf(OWN_IMAGE));
	});

	it("passes on no logo that is a URL of its own", async () => {
		world.organizations.set(ORG_A, {
			name: "Example Org",
			logo: "https://cdn.example.com/logo.png",
			brandColor: null,
		});
		const brand = (await get()).brand as { preparer: { logoUrl: unknown } };
		expect(brand.preparer.logoUrl).toBeNull();
	});
});
