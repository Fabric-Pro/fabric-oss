/**
 * `projects.glossy.reviewVisual` (Fizzy #2589, R26, R28, R29, R30, KTD8,
 * KTD10, KTD19, AE7, AE10).
 *
 * The permission decision and the Glossy gate are real; the edition queries
 * run over `useEditionStore`, and the audit writer is a mock. That a build
 * prunes a decision only when its section is gone — so a discard survives a
 * rebuild of the unchanged section — is proven against real Postgres in
 * `packages/database/__tests__/glossy-editions.integration.test.ts`; here,
 * that the decision is filed under the section that shows the visual, and
 * that a discard reads back by visual key alone.
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

import { specHash } from "@repo/utils/glossy/visual-spec";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { GLOSSY_APPENDIX_SECTION_KEY } from "../../../lib/glossy-access";
import { getGlossyEditionProcedure } from "../get-edition";
import { reviewGlossyVisualProcedure } from "../review-visual";
import {
	call,
	DOC_A,
	DOC_B,
	errorCode,
	mocks,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./glossy-harness";
import {
	claimBy,
	storedContent,
	usePublishedEdition,
} from "./glossy-visual-fixture";

usePermissionCheck(assertProjectPermission);

type Decision = "accept" | "discard" | "restore";

const review = (
	visualKey: string,
	decision: Decision,
	options: {
		specHash?: string;
		userId?: string;
		projectId?: string;
		documentId?: string;
	} = {},
) =>
	call(
		reviewGlossyVisualProcedure,
		{
			projectId: options.projectId ?? PROJECT_A,
			documentId: options.documentId ?? DOC_A,
			visualKey,
			decision,
			...(options.specHash ? { specHash: options.specHash } : {}),
		},
		options.userId ?? USERS.editor,
	);

/** The decisions `get` shows: what the page's badges read. */
async function badges(userId: string = USERS.editor) {
	const result = (await call(
		getGlossyEditionProcedure,
		{ projectId: PROJECT_A, documentId: DOC_A },
		userId,
	)) as {
		edition: { decisions: Array<{ visualKey: string; decision: string }> };
	};
	return Object.fromEntries(
		result.edition.decisions.map((entry) => [
			entry.visualKey,
			entry.decision,
		]),
	);
}

beforeEach(() => {
	resetWorld();
	resetMocks();
});

describe("projects.glossy.reviewVisual — accept, discard, restore (R28, R29)", () => {
	it("accept stores the approved spec hash under the visual's section, and records the decision and key", async () => {
		const { store, keys, sections, content } = usePublishedEdition();
		const approved = content.visuals[keys.team].specHash;

		expect(
			await review(keys.team, "accept", { specHash: approved }),
		).toEqual({
			outcome: "reviewed",
			visualKey: keys.team,
			decision: "ACCEPTED",
		});
		expect(mocks.upsertVisualDecision).toHaveBeenCalledWith({
			documentId: DOC_A,
			projectId: PROJECT_A,
			visualKey: keys.team,
			sectionKey: sections.team.key,
			decision: "ACCEPTED",
			specHash: approved,
			decidedById: USERS.editor,
		});
		expect(store.decisions.get(keys.team)?.specHash).toBe(approved);
		expect(await badges()).toEqual({ [keys.team]: "ACCEPTED" });

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0][1];
		expect(audit).toEqual({
			action: "project.glossy_edition.visual_reviewed",
			category: "project",
			outcome: "success",
			organizationId: ORG_A,
			projectId: PROJECT_A,
			resource: { type: "project_document", id: DOC_A, name: null },
			metadata: { decision: "accept", visualKey: keys.team },
		});
	});

	it("an accept of a spec the visual no longer shows records nothing and names the current one", async () => {
		const { store, keys, content } = usePublishedEdition();

		const seenBefore = specHash({
			kind: "org_chart",
			nodes: [{ id: "a", label: "Alex", parentId: null }],
		});

		expect(
			await review(keys.team, "accept", { specHash: seenBefore }),
		).toEqual({
			outcome: "visualChanged",
			specHash: content.visuals[keys.team].specHash,
		});
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();
		expect(store.decisions.size).toBe(0);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("an accept must name the spec hash it approves", async () => {
		const { keys } = usePublishedEdition();
		await expect(review(keys.team, "accept")).rejects.toThrow();
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();
	});

	it("covers R29: discard, then restore → included again", async () => {
		const { store, keys, sections } = usePublishedEdition();

		expect(await review(keys.exec, "discard")).toEqual({
			outcome: "reviewed",
			visualKey: keys.exec,
			decision: "DISCARDED",
		});
		// A discard applies by visual key alone (KTD10).
		expect(store.decisions.get(keys.exec)).toMatchObject({
			sectionKey: sections.exec.key,
			decision: "DISCARDED",
			specHash: null,
		});
		expect(await badges()).toEqual({ [keys.exec]: "DISCARDED" });

		expect(await review(keys.exec, "restore")).toEqual({
			outcome: "reviewed",
			visualKey: keys.exec,
			decision: null,
		});
		expect(mocks.clearVisualDecision).toHaveBeenCalledWith({
			documentId: DOC_A,
			projectId: PROJECT_A,
			visualKey: keys.exec,
		});
		// No decision: pending, and included in downloads (R28).
		expect(await badges()).toEqual({});

		expect(
			mocks.recordAudit.mock.calls.map(([, entry]) => entry.metadata),
		).toEqual([
			{ decision: "discard", visualKey: keys.exec },
			{ decision: "restore", visualKey: keys.exec },
		]);
	});

	it("a discard survives a rebuild of its unchanged section, even when the rebuild re-extracted the visual", async () => {
		const { store, keys, sections } = usePublishedEdition();
		await review(keys.team, "discard");
		await review(keys.exec, "accept", {
			specHash: storedContent(store).visuals[keys.exec].specHash,
		});

		// The rebuild: a new published attempt whose unchanged sections keep
		// their visual keys and their decisions (finalize prunes decisions
		// by missing section only), with fresh specs.
		const rebuilt = storedContent(store);
		rebuilt.visuals[keys.team] = {
			...rebuilt.visuals[keys.team],
			spec: {
				kind: "org_chart",
				nodes: [
					{ id: "s", label: "Sam", parentId: null },
					{ id: "a", label: "Alex", parentId: "s" },
				],
			},
			specHash: "rebuilt-team",
		};
		rebuilt.visuals[keys.exec] = {
			...rebuilt.visuals[keys.exec],
			specHash: "rebuilt-exec",
		};
		store.publishedBuildId = "build-rebuilt";
		store.contentRevision += 1;
		expect(store.decisions.get(keys.team)?.sectionKey).toBe(
			sections.team.key,
		);

		// The discard still applies; the acceptance approved an older spec.
		expect(await badges()).toEqual({ [keys.team]: "DISCARDED" });
	});

	it("an existing diagram can be reviewed too", async () => {
		const { keys, sections } = usePublishedEdition();
		await review(keys.mermaid, "discard");
		expect(mocks.upsertVisualDecision.mock.calls[0][0]).toMatchObject({
			visualKey: keys.mermaid,
			sectionKey: sections.approach.key,
		});
	});

	it("a diagram only the appendix shows is reviewed under the appendix key", async () => {
		const { store, keys } = usePublishedEdition();
		const content = storedContent(store);
		content.sections = content.sections.map((section) => ({
			...section,
			anchors: section.anchors.filter(
				(anchor) =>
					anchor.ref.type !== "visual" ||
					anchor.ref.visualKey !== keys.mermaid,
			),
		}));
		content.appendix.additionalMaterial = [
			{
				heading: "Appendix",
				level: 2,
				markdown: "Supporting material.",
				anchors: [
					{
						blockIndex: 1,
						ref: { type: "visual", visualKey: keys.mermaid },
					},
				],
			},
		];

		await review(keys.mermaid, "discard");
		expect(mocks.upsertVisualDecision.mock.calls[0][0]).toMatchObject({
			visualKey: keys.mermaid,
			sectionKey: GLOSSY_APPENDIX_SECTION_KEY,
		});
	});

	it("review is not refused while a build runs: it writes no content", async () => {
		const { store, keys } = usePublishedEdition();
		claimBy(store, "build-running");

		expect((await review(keys.team, "discard")).outcome).toBe("reviewed");
		expect(store.decisions.get(keys.team)?.decision).toBe("DISCARDED");
	});
});

describe("projects.glossy.reviewVisual — refusals", () => {
	it("an unknown visual key is refused, and nothing is written", async () => {
		const { store } = usePublishedEdition();

		for (const decision of ["accept", "discard", "restore"] as const) {
			expect(
				await review("not-a-visual", decision, { specHash: "0000" }),
			).toEqual({ outcome: "visualNotFound" });
		}
		expect(await review("__proto__", "discard")).toEqual({
			outcome: "visualNotFound",
		});
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();
		expect(mocks.clearVisualDecision).not.toHaveBeenCalled();
		expect(store.decisions.size).toBe(0);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("an edition gone between the read and the decision write is visualNotFound, with no audit row", async () => {
		const { store, keys } = usePublishedEdition();
		const current = storedContent(store).visuals[keys.team].specHash;
		// The edition row disappears (a deletion, a cleanup sweep) after this
		// procedure located the visual: the decision write finds no edition.
		mocks.upsertVisualDecision.mockResolvedValue(null);

		expect(
			await review(keys.team, "accept", { specHash: current }),
		).toEqual({ outcome: "visualNotFound" });
		expect(await review(keys.team, "discard")).toEqual({
			outcome: "visualNotFound",
		});

		expect(mocks.upsertVisualDecision).toHaveBeenCalledTimes(2);
		expect(store.decisions.size).toBe(0);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("a document with no published edition has no visual to review", async () => {
		mocks.getGlossyEdition.mockResolvedValue(null);
		expect(await review("any", "discard")).toEqual({
			outcome: "visualNotFound",
		});
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();
	});
});

describe("projects.glossy.reviewVisual — access (KTD19)", () => {
	it("covers AE10: the rollout gate off → NOT_FOUND", async () => {
		const { keys } = usePublishedEdition();
		world.flags.set(ORG_A, false);

		expect(await errorCode(review(keys.team, "discard"))).toBe("NOT_FOUND");
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();
	});

	it("covers AE7: a guest viewer is FORBIDDEN; a guest editor reviews, in the host organization", async () => {
		const { store, keys } = usePublishedEdition();

		expect(
			await errorCode(
				review(keys.team, "discard", { userId: USERS.guestViewer }),
			),
		).toBe("FORBIDDEN");
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();

		expect(
			(await review(keys.team, "discard", { userId: USERS.guestEditor }))
				.outcome,
		).toBe("reviewed");
		expect(store.decisions.get(keys.team)?.decidedById).toBe(
			USERS.guestEditor,
		);
		expect(mocks.recordAudit.mock.calls[0][1]).toMatchObject({
			organizationId: ORG_A,
		});
		// The viewer still reads the decision.
		expect(await badges(USERS.guestViewer)).toEqual({
			[keys.team]: "DISCARDED",
		});
	});

	it("NOT_FOUND: another tenant, another project's document, and a trashed project", async () => {
		const { keys } = usePublishedEdition();

		expect(
			await errorCode(
				review(keys.team, "discard", { userId: USERS.outsider }),
			),
		).toBe("NOT_FOUND");
		expect(
			await errorCode(
				review(keys.team, "discard", { documentId: DOC_B }),
			),
		).toBe("NOT_FOUND");
		expect(
			await errorCode(
				review(keys.team, "discard", {
					userId: USERS.guestEditor,
					projectId: PROJECT_B,
				}),
			),
		).toBe("NOT_FOUND");

		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-09-20T00:00:00.000Z"),
		});
		expect(await errorCode(review(keys.team, "discard"))).toBe("NOT_FOUND");
		expect(mocks.upsertVisualDecision).not.toHaveBeenCalled();
	});

	it("is a write: DOCUMENT_UPDATE", () => {
		expect(
			(reviewGlossyVisualProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("document:update");
	});
});
