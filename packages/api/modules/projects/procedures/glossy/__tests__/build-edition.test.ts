/**
 * `projects.glossy.build` (Fizzy #2589, R3, R5, R9, R10, R23, R24, KTD4,
 * KTD10, KTD19, KTD21, AE6, AE7, AE10).
 *
 * The permission decision, the Glossy gate, the claim/reclaim/start logic of
 * `dispatchGlossyBuild`, `planGlossyKeys`, and `resolveGlossyModel` are real.
 * The claim query, Temporal, and the provider resolver underneath
 * `resolveGlossyModel` are mocks over the world in `glossy-harness.ts`.
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

import {
	computeDocumentContentHash,
	glossyEditionBuildWorkflowId,
} from "@repo/database";
import {
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE,
	planGlossyKeys,
} from "@repo/temporal";
import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { GLOSSY_BUILD_STALE_AFTER_MS } from "../../../lib/dispatch-glossy-build";
import { buildGlossyEditionProcedure } from "../build-edition";
import {
	call,
	DOC_A,
	DOC_B,
	DOC_PRD,
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

const ROLL_THE_DICE = { mode: "roll_the_dice", lengthMode: "brief" } as const;

const build = (
	userId: string = USERS.editor,
	options: Record<string, unknown> = ROLL_THE_DICE,
	target: { projectId: string; documentId: string } = {
		projectId: PROJECT_A,
		documentId: DOC_A,
	},
) => call(buildGlossyEditionProcedure, { ...target, options }, userId);

const STARTED_AT = new Date("2026-09-24T12:00:00.000Z");

function claimed(buildId: string) {
	return {
		outcome: "claimed" as const,
		buildId,
		editionId: "edition-1",
		organizationId: ORG_A,
		workflowId: glossyEditionBuildWorkflowId(DOC_A, buildId),
		startedAt: STARTED_AT,
	};
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function holder(heartbeatMinutesAgo: number) {
	return {
		buildId: "build-1",
		startedById: USERS.owner,
		startedAt: minutesAgo(heartbeatMinutesAgo + 5),
		heartbeatAt: minutesAgo(heartbeatMinutesAgo),
		workflowId: glossyEditionBuildWorkflowId(DOC_A, "build-1"),
	};
}

function setDocument(overrides: Record<string, unknown>) {
	const document = world.documents.get(DOC_A);
	world.documents.set(DOC_A, {
		...(document as NonNullable<typeof document>),
		...overrides,
	});
}

/** The one workflow start's options. */
function startOptions(index = 0) {
	return mocks.workflowStart.mock.calls[index][1];
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	mocks.claimGlossyBuild.mockResolvedValue(claimed("build-2"));
});

describe("projects.glossy.build — who may build (R5, AE7)", () => {
	it("an editor starts the build on the glossy-edition queue with a 30-minute execution timeout", async () => {
		const result = await runWithCorrelationId("corr-example-1", () =>
			build(),
		);

		expect(result).toEqual({ outcome: "started", startedAt: STARTED_AT });
		expect(mocks.claimGlossyBuild).toHaveBeenCalledTimes(1);
		expect(mocks.claimGlossyBuild.mock.calls[0][0]).toMatchObject({
			documentId: DOC_A,
			projectId: PROJECT_A,
			organizationId: ORG_A,
			startedById: USERS.editor,
			options: ROLL_THE_DICE,
			// The single read of the document is the snapshot.
			snapshot: {
				title: "Example Proposal",
				content: PROPOSAL_BODY,
				version: 5,
				contentHash: computeDocumentContentHash(PROPOSAL_BODY),
			},
		});
		expect(mocks.claimGlossyBuild.mock.calls[0][0].reclaim).toBeUndefined();

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.workflowStart.mock.calls[0][0]).toBe(
			"glossyEditionBuildWorkflow",
		);
		expect(startOptions()).toMatchObject({
			taskQueue: "glossy-edition",
			workflowId: glossyEditionBuildWorkflowId(DOC_A, "build-2"),
			workflowExecutionTimeout: "30 minutes",
			memo: { correlationId: "corr-example-1" },
			args: [
				{
					buildId: "build-2",
					documentId: DOC_A,
					projectId: PROJECT_A,
					organizationId: ORG_A,
					startedById: USERS.editor,
					options: ROLL_THE_DICE,
				},
			],
		});

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit.mock.calls[0][1]).toMatchObject({
			action: "project.glossy_edition.build_started",
			organizationId: ORG_A,
			projectId: PROJECT_A,
			resource: { type: "project_document", id: DOC_A },
			metadata: {
				buildId: "build-2",
				mode: "roll_the_dice",
				lengthMode: "brief",
				confirmedOpportunities: 0,
				reclaimed: false,
			},
		});
	});

	it("covers AE7: a guest viewer's build is FORBIDDEN, with nothing claimed", async () => {
		expect(await errorCode(build(USERS.guestViewer))).toBe("FORBIDDEN");
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("a guest editor can build, and every row and the run land in the host organization", async () => {
		// The guest's session names their own organization; the host's comes
		// from the project row.
		const result = await build(USERS.guestEditor);

		expect(result.outcome).toBe("started");
		expect(mocks.claimGlossyBuild.mock.calls[0][0]).toMatchObject({
			organizationId: ORG_A,
			startedById: USERS.guestEditor,
		});
		expect(startOptions().args[0]).toMatchObject({
			organizationId: ORG_A,
			startedById: USERS.guestEditor,
		});
		// BYOK resolves as the guest editor, in the host organization.
		expect(mocks.getAIModel).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: USERS.guestEditor,
				organizationId: ORG_A,
				projectId: PROJECT_A,
				featureKey: "glossy-edition",
			}),
		);
		expect(mocks.recordAudit.mock.calls[0][1].organizationId).toBe(ORG_A);
	});
});

describe("projects.glossy.build — NOT_FOUND", () => {
	it("covers AE10: the rollout gate off", async () => {
		world.flags.set(ORG_A, false);
		expect(await errorCode(build())).toBe("NOT_FOUND");
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});

	it("a trashed project", async () => {
		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-09-23T00:00:00.000Z"),
		});
		expect(await errorCode(build())).toBe("NOT_FOUND");
	});

	it("another project's document, another project, and another tenant", async () => {
		expect(
			await errorCode(
				build(USERS.editor, ROLL_THE_DICE, {
					projectId: PROJECT_A,
					documentId: DOC_B,
				}),
			),
		).toBe("NOT_FOUND");
		expect(
			await errorCode(
				build(USERS.guestEditor, ROLL_THE_DICE, {
					projectId: PROJECT_B,
					documentId: DOC_B,
				}),
			),
		).toBe("NOT_FOUND");
		expect(await errorCode(build(USERS.outsider))).toBe("NOT_FOUND");
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});
});

describe("projects.glossy.build — eligibility (R2, R3)", () => {
	it("a PRD is not eligible", async () => {
		expect(
			await build(USERS.editor, ROLL_THE_DICE, {
				projectId: PROJECT_A,
				documentId: DOC_PRD,
			}),
		).toEqual({ outcome: "notEligible", reason: "documentType" });
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});

	it("a generating document is refused", async () => {
		setDocument({ status: "GENERATING" });
		expect(await build()).toEqual({
			outcome: "notEligible",
			reason: "generating",
		});
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});

	it("an empty document is refused", async () => {
		setDocument({ content: "   \n" });
		expect(await build()).toEqual({
			outcome: "notEligible",
			reason: "empty",
		});
	});
});

describe("projects.glossy.build — BYOK (R10, KTD21)", () => {
	it("covers AE6: no organization key and no personal key → aiProviderNotConfigured, with no claim and no start", async () => {
		world.orgProviderKeys.delete(ORG_A);

		expect(await build()).toEqual({
			outcome: "aiProviderNotConfigured",
			message: GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE,
		});
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("covers AE6: with the editor's personal key only, the build starts", async () => {
		world.orgProviderKeys.delete(ORG_A);
		world.personalProviderKeys.add(USERS.editor);

		expect((await build()).outcome).toBe("started");
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
});

describe("projects.glossy.build — the claim (KTD4)", () => {
	it("two quick builds: the second returns alreadyBuilding with the holder", async () => {
		mocks.claimGlossyBuild
			.mockResolvedValueOnce(claimed("build-1"))
			.mockResolvedValueOnce({
				outcome: "alreadyBuilding",
				holder: { ...holder(0), startedById: USERS.editor },
			});

		expect((await build()).outcome).toBe("started");
		const second = await build(USERS.guestEditor);

		expect(second).toEqual({
			outcome: "alreadyBuilding",
			holder: {
				startedBy: { id: USERS.editor, name: "Eddie Editor" },
				startedAt: expect.any(Date),
			},
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		// A fresh holder is live without asking Temporal.
		expect(mocks.describe).not.toHaveBeenCalled();
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
	});

	it("a failed workflow start releases the claim, and a retry succeeds", async () => {
		mocks.claimGlossyBuild
			.mockResolvedValueOnce(claimed("build-2"))
			.mockResolvedValueOnce(claimed("build-3"));
		mocks.workflowStart.mockRejectedValueOnce(
			new Error(
				"connect ECONNREFUSED temporal.internal.example.com:7233",
			),
		);

		let thrown: unknown;
		try {
			await build();
		} catch (error) {
			thrown = error;
		}
		expect((thrown as { code?: string }).code).toBe(
			"INTERNAL_SERVER_ERROR",
		);
		// A fixed message: no host or driver text reaches the editor.
		expect((thrown as Error).message).toBe(
			"The build could not be started. Try again.",
		);
		expect(mocks.releaseGlossyClaim).toHaveBeenCalledWith("build-2");
		expect(mocks.recordAudit).not.toHaveBeenCalled();

		expect((await build()).outcome).toBe("started");
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
		expect(startOptions(1).workflowId).toBe(
			glossyEditionBuildWorkflowId(DOC_A, "build-3"),
		);
	});

	it("a claim whose holder hit its execution timeout is reclaimed", async () => {
		const stuck = holder(45);
		mocks.claimGlossyBuild
			.mockResolvedValueOnce({
				outcome: "alreadyBuilding",
				holder: stuck,
			})
			.mockResolvedValueOnce(claimed("build-2"));
		mocks.describe.mockResolvedValue({ status: { name: "TIMED_OUT" } });

		const before = Date.now();
		expect((await build()).outcome).toBe("started");

		expect(mocks.describe).toHaveBeenCalledWith(stuck.workflowId);
		expect(mocks.claimGlossyBuild).toHaveBeenCalledTimes(2);
		const reclaim = mocks.claimGlossyBuild.mock.calls[1][0].reclaim;
		expect(reclaim.holderBuildId).toBe("build-1");
		// The database re-checks the stale half against this bound.
		expect(reclaim.staleBefore.getTime()).toBeGreaterThan(
			stuck.heartbeatAt.getTime(),
		);
		expect(reclaim.staleBefore.getTime()).toBeLessThanOrEqual(
			Date.now() - GLOSSY_BUILD_STALE_AFTER_MS,
		);
		expect(reclaim.staleBefore.getTime()).toBeGreaterThanOrEqual(
			before - GLOSSY_BUILD_STALE_AFTER_MS,
		);
		expect(mocks.recordAudit.mock.calls[0][1].metadata.reclaimed).toBe(
			true,
		);
	});

	it("a holder Temporal has never heard of is reclaimed too", async () => {
		mocks.claimGlossyBuild
			.mockResolvedValueOnce({
				outcome: "alreadyBuilding",
				holder: holder(45),
			})
			.mockResolvedValueOnce(claimed("build-2"));
		const notFound = new Error("workflow not found");
		notFound.name = "WorkflowNotFoundError";
		mocks.describe.mockRejectedValue(notFound);

		expect((await build()).outcome).toBe("started");
		expect(mocks.claimGlossyBuild).toHaveBeenCalledTimes(2);
	});

	it("a stale holder that is still running, or that Temporal cannot be asked about, keeps the claim", async () => {
		mocks.claimGlossyBuild.mockResolvedValue({
			outcome: "alreadyBuilding",
			holder: holder(45),
		});

		mocks.describe.mockResolvedValueOnce({ status: { name: "RUNNING" } });
		expect((await build()).outcome).toBe("alreadyBuilding");

		mocks.describe.mockRejectedValueOnce(new Error("deadline exceeded"));
		expect((await build()).outcome).toBe("alreadyBuilding");

		// Only the plain claim, never a reclaim.
		for (const [input] of mocks.claimGlossyBuild.mock.calls) {
			expect(input.reclaim).toBeUndefined();
		}
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("a holder whose heartbeat is recent is not even asked about", async () => {
		mocks.claimGlossyBuild.mockResolvedValue({
			outcome: "alreadyBuilding",
			holder: holder(10),
		});
		expect((await build()).outcome).toBe("alreadyBuilding");
		expect(mocks.describe).not.toHaveBeenCalled();
	});
});

describe("projects.glossy.build — Align first (R24, KTD10)", () => {
	const plan = () =>
		planGlossyKeys({
			content: PROPOSAL_BODY,
			projectId: PROJECT_A,
			documentType: "PROPOSAL",
		});

	function alignFirst(overrides: Record<string, unknown> = {}) {
		const keys = plan().sectionKeys;
		return {
			mode: "align_first",
			lengthMode: "standard",
			styleDirection: "  Crisp, for a finance audience.  ",
			preparerOverrides: { primary: "#AABBCC", accents: ["#112233"] },
			detection: {
				contentHash: computeDocumentContentHash(PROPOSAL_BODY),
				opportunities: [
					{ sectionKey: keys[2], kind: "org_chart" },
					{ sectionKey: keys[0], kind: "stat" },
					{ sectionKey: keys[2], kind: "org_chart" },
				],
			},
			...overrides,
		};
	}

	it("carries the confirmed opportunities to the workflow and runs no detection of its own", async () => {
		const keys = plan().sectionKeys;

		expect((await build(USERS.editor, alignFirst())).outcome).toBe(
			"started",
		);

		expect(startOptions().args[0].options).toEqual({
			mode: "align_first",
			lengthMode: "standard",
			styleDirection: "Crisp, for a finance audience.",
			confirmedOpportunities: [
				{ sectionKey: keys[2], kind: "org_chart" },
				{ sectionKey: keys[0], kind: "stat" },
			],
		});
		// The render-time colors are recorded with the options, not run.
		expect(mocks.claimGlossyBuild.mock.calls[0][0].options).toMatchObject({
			mode: "align_first",
			preparerOverrides: { primary: "#aabbcc", accents: ["#112233"] },
		});
		expect(mocks.detect).not.toHaveBeenCalled();
		expect(mocks.getCacheEntries).not.toHaveBeenCalled();
		// A build spends the same AI budget as detect and regenerate.
		expect(mocks.enforceAiRateLimit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit.mock.calls[0][1].metadata).toMatchObject({
			mode: "align_first",
			confirmedOpportunities: 2,
		});
		// Free text never reaches the audit row.
		expect(JSON.stringify(mocks.recordAudit.mock.calls)).not.toContain(
			"finance",
		);
	});

	it("after an edit, answers draftStale with nothing claimed", async () => {
		setDocument({
			content: `${PROPOSAL_BODY}\n\nA paragraph added later.`,
		});

		expect(await build(USERS.editor, alignFirst())).toEqual({
			outcome: "draftStale",
		});
		expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled();
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("answers draftStale for an opportunity detection could not have proposed: a best-fit slot's section, or a kind the section already shows", async () => {
		const slotted = PROPOSAL_BODY.replace(
			"First we discover. Then we build and measure.",
			'First we discover. Then we build and measure.\n\n<visual-slot data-slot-id="slot-bf" data-hint="phases"></visual-slot>',
		).replace(
			"Alex leads delivery. Sam owns design.",
			'Alex leads delivery. Sam owns design.\n\n<visual-slot data-slot-id="slot-oc" data-kind="org_chart" data-hint="team"></visual-slot>',
		);
		setDocument({ content: slotted });
		const keys = planGlossyKeys({
			content: slotted,
			projectId: PROJECT_A,
			documentType: "PROPOSAL",
		}).sectionKeys;

		for (const opportunity of [
			// "Approach" holds a best-fit slot: detection never proposes there.
			{ sectionKey: keys[1], kind: "timeline" },
			// "Team" already shows an org chart through its slot.
			{ sectionKey: keys[2], kind: "org_chart" },
		]) {
			const input = alignFirst({
				detection: {
					contentHash: computeDocumentContentHash(slotted),
					opportunities: [opportunity],
				},
			});
			expect(await build(USERS.editor, input)).toEqual({
				outcome: "draftStale",
			});
		}
		expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled();
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});

	it("answers draftStale when a confirmed section is not one of this body's", async () => {
		const input = alignFirst();
		(input.detection as { opportunities: unknown[] }).opportunities = [
			{ sectionKey: "a-section-keyed-by-another-pipeline", kind: "stat" },
		];
		expect(await build(USERS.editor, input)).toEqual({
			outcome: "draftStale",
		});
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});

	it("refuses more than eight confirmed opportunities at the input", async () => {
		const keys = plan().sectionKeys;
		const input = alignFirst();
		(input.detection as { opportunities: unknown[] }).opportunities =
			Array.from({ length: 9 }, () => ({
				sectionKey: keys[0],
				kind: "stat",
			}));
		await expect(build(USERS.editor, input)).rejects.toThrow();
		expect(mocks.claimGlossyBuild).not.toHaveBeenCalled();
	});
});
