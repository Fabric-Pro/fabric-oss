/**
 * `projects.proposalArtifact.getAnalysis` (Fizzy #2801, Fizzy #2946): the
 * run that describes the Proposal's current content, every finding's state,
 * answer and evidence, the answers to findings no longer raised, and the
 * status of a newer run — never the analyzed body, the source context or a
 * stored source address.
 *
 * Access is covered in `access.test.ts`; this file is about what comes back.
 * Section maps and answer states are the real ones, computed from the
 * world's document body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { Permissions } from "@repo/permissions";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	documentProseHash,
} from "@repo/utils/proposal-artifact/section-hash";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { getProposalAnalysisProcedure } from "../get-analysis";
import {
	call,
	DOC_A,
	mocks,
	ORG_A,
	ORG_A_SLUG,
	ORG_B,
	PROJECT_A,
	PROJECT_A2,
	PROPOSAL_BODY,
	resetMocks,
	resetWorld,
	USER_NAMES,
	USERS,
	usePermissionCheck,
	type WorldContext,
	type WorldResponse,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const MAP = buildSectionMap(PROPOSAL_BODY);
const SUMMARY = MAP.sections.find(
	(section) => section.headingText === "Executive Summary",
) as (typeof MAP.sections)[number];
const SCOPE = MAP.sections.find(
	(section) => section.headingText === "Scope",
) as (typeof MAP.sections)[number];

const KEY_SUMMARY = `GAP|${SUMMARY.key}|pilot-owner`;
const KEY_SCOPE = `SCOPE|${SCOPE.key}|data-migration`;
const KEY_GONE = `RISK|${SCOPE.key}|vendor-lock-in`;

const T0 = new Date("2026-10-10T10:00:00.000Z");
const minutesAfter = (minutes: number) =>
	new Date(T0.getTime() + minutes * 60_000);

function finding(position: number, overrides: Record<string, unknown> = {}) {
	return {
		id: `finding-${position}`,
		severity: "IMPORTANT",
		type: "SCOPE",
		title: `Finding ${position}`,
		detail: "The scope leaves the data migration unowned.",
		recommendation: "Name an owner for the migration.",
		sectionHeading: "Scope",
		position,
		stableKey: KEY_SCOPE,
		sectionKey: SCOPE.key,
		sectionHash: SCOPE.proseHash,
		sourceRefs: [],
		foldedTitles: [],
		...overrides,
	};
}

/** A shown run as the query returns it, describing the current body. */
function shownRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		runKey: `proposal-analysis-${DOC_A}-live-1`,
		status: "COMPLETE",
		kind: "GENERATION",
		sourceRunId: null,
		contentHash: "content-hash",
		proseHash: MAP.documentProseHash,
		documentVersion: 4,
		contextCount: 3,
		promptVersionId: "prompt-version-1",
		model: "example-model",
		errorCode: null,
		errorMessage: null,
		startedAt: minutesAfter(1),
		completedAt: minutesAfter(2),
		createdAt: T0,
		updatedAt: minutesAfter(2),
		findings: [
			finding(0, {
				severity: "BLOCKING",
				type: "GAP",
				title: "No pilot owner",
				sectionHeading: "Executive Summary",
				stableKey: KEY_SUMMARY,
				sectionKey: SUMMARY.key,
				sectionHash: SUMMARY.proseHash,
			}),
			finding(1),
			finding(2, {
				title: "Written before keys",
				stableKey: null,
				sectionKey: null,
				sectionHash: null,
			}),
		],
		sourceManifest: null,
		...overrides,
	};
}

/** A report as the report read returns it. */
function storedReport(overrides: Record<string, unknown> = {}) {
	return {
		assessment: "Ready to send after two fixes",
		summary: "The scope is clear; nobody owns the data migration.",
		scope: [
			{
				item: "Data migration",
				priority: "MUST",
				inProposal: "Partly",
				note: "No owner is named.",
			},
			{
				item: "Reporting dashboard",
				priority: null,
				inProposal: "Yes",
				note: "",
			},
		],
		beforeSending: ["Name an owner for the data migration."],
		duringDiscovery: ["Confirm how often reports are needed."],
		sources: [],
		textTruncated: false,
		plainText: false,
		text: "## Overall\n\nThe pilot is well framed, but the migration has no owner.",
		...overrides,
	};
}

/** Each run's stored report; the report read answers by run id. */
function reportsByRun(byRun: Record<string, ReturnType<typeof storedReport>>) {
	mocks.getAnalysisReport.mockImplementation(
		async (input: { analysisId: string }) =>
			byRun[input.analysisId] ?? null,
	);
}

function showing(
	run: ReturnType<typeof shownRun> | null,
	extra: Record<string, unknown> = {},
) {
	mocks.getAnalysisForCurrentContent.mockResolvedValue({
		run,
		isStale: false,
		newerRun: null,
		...extra,
	});
}

/** Store an answer, by default the editor's to the scope finding, now valid. */
function answer(overrides: Partial<WorldResponse> = {}): WorldResponse {
	const response: WorldResponse = {
		id: `response-${world.responses.length + 1}`,
		organizationId: ORG_A,
		projectId: PROJECT_A,
		documentId: DOC_A,
		stableKey: KEY_SCOPE,
		kind: "RESPONDED",
		text: "The client's team owns the migration.",
		findingTitle: "Finding 1",
		answeredRunId: "run-1",
		sectionKey: SCOPE.key,
		sectionHash: SCOPE.proseHash,
		authorId: USERS.editor,
		version: 1,
		createdAt: minutesAfter(5),
		updatedAt: minutesAfter(5),
		...overrides,
	};
	world.responses.push(response);
	return response;
}

function setBody(content: string) {
	const document = world.documents.get(DOC_A);
	world.documents.set(DOC_A, {
		...(document as NonNullable<typeof document>),
		content,
	});
}

type Read = {
	run: Record<string, unknown> | null;
	isStale: boolean;
	newerRun: Record<string, unknown> | null;
	findings: Array<Record<string, unknown>>;
	noLongerRaised: Array<Record<string, unknown>>;
	report:
		| (Record<string, unknown> & {
				text: string | null;
				citations: Array<Record<string, unknown>>;
		  })
		| null;
	viewer: { canRespond: boolean };
};

function getAnalysis(userId: string = USERS.editor) {
	return call(
		getProposalAnalysisProcedure,
		{ projectId: PROJECT_A, documentId: DOC_A },
		userId,
	) as Promise<Read>;
}

function findingWithKey(read: Read, stableKey: string) {
	return read.findings.find((entry) => entry.stableKey === stableKey);
}

beforeEach(() => {
	resetWorld();
	resetMocks();
});

describe("getAnalysis", () => {
	it("answers an empty read before any run completed", async () => {
		expect(await getAnalysis()).toEqual({
			run: null,
			isStale: false,
			newerRun: null,
			findings: [],
			noLongerRaised: [],
			report: null,
			viewer: { canRespond: true },
		});
		expect(mocks.getAnalysisReport).not.toHaveBeenCalled();
		expect(mocks.getAnalysisForCurrentContent).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentId: DOC_A,
			currentProseHash: documentProseHash(PROPOSAL_BODY),
			computeProseHash: documentProseHash,
		});
		expect(mocks.listResponsesForDocument).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentId: DOC_A,
		});
	});

	it("returns the shown run with its findings in order, each unaddressed until answered", async () => {
		showing(shownRun());

		const read = await getAnalysis();

		expect(read.run).toEqual({
			id: "run-1",
			kind: "GENERATION",
			status: "COMPLETE",
			documentVersion: 4,
			contextCount: 3,
			model: "example-model",
			startedAt: minutesAfter(1),
			completedAt: minutesAfter(2),
			createdAt: T0,
			updatedAt: minutesAfter(2),
		});
		expect(read.findings.map((entry) => entry.id)).toEqual([
			"finding-0",
			"finding-1",
			"finding-2",
		]);
		expect(read.findings[0]).toEqual({
			id: "finding-0",
			position: 0,
			severity: "BLOCKING",
			type: "GAP",
			title: "No pilot owner",
			detail: "The scope leaves the data migration unowned.",
			recommendation: "Name an owner for the migration.",
			sectionHeading: "Executive Summary",
			stableKey: KEY_SUMMARY,
			keyed: true,
			foldedTitles: [],
			state: "UNADDRESSED",
			reason: null,
			response: null,
			evidence: [],
			canApply: true,
		});
	});

	it("marks a finding written before stable keys as not keyed and unaddressed", async () => {
		showing(shownRun());

		const read = await getAnalysis();

		expect(read.findings[2]).toMatchObject({
			stableKey: null,
			keyed: false,
			state: "UNADDRESSED",
			response: null,
		});
	});

	it("never returns the analyzed body, the source context, the manifest, hashes, the workflow key, tenant columns or the report columns", async () => {
		reportsByRun({
			"run-1": storedReport({ text: "INTERNAL REPORT TEXT" }),
		});
		showing(
			shownRun({
				analyzedContent: "INTERNAL MAIN BODY",
				sourceContext: "INTERNAL SOURCE CONTEXT",
				report: { v: 1, assessment: "INTERNAL REPORT OBJECT" },
				reportText: "INTERNAL REPORT TEXT",
			}),
		);

		const read = await getAnalysis();
		const serialized = JSON.stringify(read);

		for (const key of [
			"analyzedContent",
			"sourceContext",
			"sourceManifest",
			"runKey",
			"organizationId",
			"projectId",
			"documentId",
			"contentHash",
			"proseHash",
			"promptVersionId",
			"report",
			"reportText",
		]) {
			expect(read.run).not.toHaveProperty(key);
		}
		expect(read.findings[0]).not.toHaveProperty("sectionHash");
		expect(read.findings[0]).not.toHaveProperty("sourceRefs");
		expect(read.report).not.toHaveProperty("sources");
		expect(serialized).not.toContain("INTERNAL MAIN BODY");
		expect(serialized).not.toContain("INTERNAL SOURCE CONTEXT");
		expect(serialized).not.toContain("INTERNAL REPORT OBJECT");
		// The report text is served in one place only: the report's own field.
		expect(read.report?.text).toBe("INTERNAL REPORT TEXT");
		expect(
			JSON.stringify({ ...read, report: { ...read.report, text: null } }),
		).not.toContain("INTERNAL REPORT TEXT");
	});

	it("passes the stale label and the newer run through", async () => {
		showing(shownRun(), {
			isStale: true,
			newerRun: {
				id: "run-2",
				kind: "RERUN",
				status: "RUNNING",
				errorCode: null,
				timedOut: true,
				createdAt: minutesAfter(30),
			},
		});

		const read = await getAnalysis();

		expect(read.isStale).toBe(true);
		expect(read.newerRun).toEqual({
			id: "run-2",
			kind: "RERUN",
			status: "RUNNING",
			errorCode: null,
			timedOut: true,
			createdAt: minutesAfter(30),
		});
	});

	it("keeps showing a complete run's findings and answers when a newer run failed", async () => {
		answer();
		showing(shownRun(), {
			newerRun: {
				id: "run-2",
				kind: "RERUN",
				status: "FAILED",
				errorCode: "MODEL_ERROR",
				timedOut: false,
				createdAt: minutesAfter(30),
			},
		});

		const read = await getAnalysis();

		expect(read.run).toMatchObject({ id: "run-1", status: "COMPLETE" });
		expect(read.newerRun).toMatchObject({
			status: "FAILED",
			errorCode: "MODEL_ERROR",
		});
		expect(findingWithKey(read, KEY_SCOPE)).toMatchObject({
			state: "RESPONDED",
		});
	});

	it("shows a newer failed run even before any run completed", async () => {
		showing(null, {
			newerRun: {
				id: "run-1",
				kind: "GENERATION",
				status: "FAILED",
				errorCode: "PROMPT_NOT_BOUND",
				timedOut: false,
				createdAt: T0,
			},
		});

		const read = await getAnalysis();

		expect(read.run).toBeNull();
		expect(read.newerRun).toMatchObject({ status: "FAILED" });
	});

	describe("answers", () => {
		it("shows an answer on its finding with its id, text, author and version, and no tenant column", async () => {
			answer();
			showing(shownRun());

			const scope = findingWithKey(await getAnalysis(), KEY_SCOPE);

			expect(scope).toMatchObject({
				state: "RESPONDED",
				reason: null,
				response: {
					id: "response-1",
					kind: "RESPONDED",
					text: "The client's team owns the migration.",
					version: 1,
					author: {
						id: USERS.editor,
						name: USER_NAMES[USERS.editor],
					},
					updatedAt: minutesAfter(5),
					settledSkipReason: null,
					versionUnknown: false,
				},
			});
			expect(scope?.response).not.toHaveProperty("findingTitle");
			for (const key of [
				"organizationId",
				"projectId",
				"documentId",
				"stableKey",
				"authorId",
			]) {
				expect(scope?.response).not.toHaveProperty(key);
			}
		});

		it("shows a confirmation without text as Confirmed", async () => {
			answer({ kind: "CONFIRMED", text: null });
			showing(shownRun());

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({
				state: "CONFIRMED",
				response: { kind: "CONFIRMED", text: null },
			});
		});

		it("shows Needs Review once the answered section's text changes, and the answer again once the edit is reverted", async () => {
			answer();
			showing(shownRun());

			setBody(
				PROPOSAL_BODY.replace(
					"the data migration and the reporting dashboard",
					"the reporting dashboard only",
				),
			);
			const edited = findingWithKey(await getAnalysis(), KEY_SCOPE);
			expect(edited).toMatchObject({
				state: "NEEDS_REVIEW",
				reason: "SECTION_CHANGED",
				response: { settledSkipReason: "NEEDS_REVIEW" },
			});

			setBody(PROPOSAL_BODY);
			const reverted = findingWithKey(await getAnalysis(), KEY_SCOPE);
			expect(reverted).toMatchObject({
				state: "RESPONDED",
				reason: null,
				response: { settledSkipReason: null },
			});
		});

		it("does not flag an answer when only another section changes", async () => {
			answer();
			showing(shownRun());

			setBody(
				PROPOSAL_BODY.replace(
					"We propose a pilot",
					"We propose a short pilot",
				),
			);

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({ state: "RESPONDED" });
		});

		it("shows Needs Review with section not found once the answered section is deleted", async () => {
			answer();
			showing(shownRun());

			setBody(PROPOSAL_BODY.split("\n## Scope")[0]);

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({
				state: "NEEDS_REVIEW",
				reason: "SECTION_NOT_FOUND",
			});
		});

		it("compares an answer to a finding that names no section against the whole document", async () => {
			answer({
				stableKey: "GAP|document|pricing",
				sectionKey: DOCUMENT_SECTION_KEY,
				sectionHash: MAP.documentProseHash,
			});
			showing(shownRun());

			const before = (await getAnalysis()).noLongerRaised[0];
			expect(before).toMatchObject({ state: "RESPONDED" });

			setBody(`${PROPOSAL_BODY}\n\nOne more line.`);
			const after = (await getAnalysis()).noLongerRaised[0];
			expect(after).toMatchObject({
				state: "NEEDS_REVIEW",
				reason: "SECTION_CHANGED",
			});
		});
	});

	describe("across runs", () => {
		it("shows Needs Review, raised again, when a later run raises an answered key", async () => {
			answer({ answeredRunId: "run-1", updatedAt: minutesAfter(5) });
			showing(shownRun({ id: "run-2", createdAt: minutesAfter(10) }));

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({
				state: "NEEDS_REVIEW",
				reason: "RAISED_AGAIN",
				response: { settledSkipReason: "NEEDS_REVIEW" },
			});
		});

		it("lists an answered key the shown run does not raise under no longer raised, with its stored title", async () => {
			answer({
				stableKey: KEY_GONE,
				findingTitle: "Vendor lock-in",
				kind: "CONFIRMED",
				text: null,
			});
			showing(shownRun({ id: "run-2", createdAt: minutesAfter(10) }));

			const read = await getAnalysis();

			expect(read.noLongerRaised).toEqual([
				{
					stableKey: KEY_GONE,
					findingTitle: "Vendor lock-in",
					state: "CONFIRMED",
					reason: null,
					response: {
						id: "response-1",
						kind: "CONFIRMED",
						text: null,
						version: 1,
						author: {
							id: USERS.editor,
							name: USER_NAMES[USERS.editor],
						},
						updatedAt: minutesAfter(5),
						settledSkipReason: null,
						versionUnknown: false,
					},
				},
			]);
			expect(findingWithKey(read, KEY_GONE)).toBeUndefined();
		});

		it("shows a no-longer-raised answer as Needs Review once its section is edited or deleted", async () => {
			answer({ stableKey: KEY_GONE, findingTitle: "Vendor lock-in" });
			showing(shownRun({ id: "run-2", createdAt: minutesAfter(10) }));

			setBody(
				PROPOSAL_BODY.replace("reporting dashboard", "reporting suite"),
			);
			expect((await getAnalysis()).noLongerRaised[0]).toMatchObject({
				state: "NEEDS_REVIEW",
				reason: "SECTION_CHANGED",
				response: { settledSkipReason: "NEEDS_REVIEW" },
			});

			setBody(PROPOSAL_BODY.split("\n## Scope")[0]);
			expect((await getAnalysis()).noLongerRaised[0]).toMatchObject({
				state: "NEEDS_REVIEW",
				reason: "SECTION_NOT_FOUND",
			});
		});

		it("shows a key no answer names as unaddressed", async () => {
			answer({ stableKey: KEY_GONE, findingTitle: "Vendor lock-in" });
			showing(shownRun({ id: "run-2", createdAt: minutesAfter(10) }));

			const read = await getAnalysis();

			expect(findingWithKey(read, KEY_SUMMARY)).toMatchObject({
				state: "UNADDRESSED",
				response: null,
			});
		});

		it("lists every answer under no longer raised while no run is shown", async () => {
			answer();

			const read = await getAnalysis();

			expect(read.findings).toEqual([]);
			expect(read.noLongerRaised).toHaveLength(1);
		});
	});

	describe("settled-decision skip reason", () => {
		it("marks an answer whose author lacks edit rights", async () => {
			answer({ authorId: USERS.memberViewer });
			showing(shownRun());

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({
				state: "RESPONDED",
				response: {
					author: { id: USERS.memberViewer },
					settledSkipReason: "AUTHOR_RIGHTS",
				},
			});
		});

		it("marks an answer whose author is no longer a member of the owning organization", async () => {
			answer({ authorId: USERS.editor });
			world.orgMembers.delete(`${ORG_A}:${USERS.editor}`);
			showing(shownRun());

			// Still an EDITOR on the project, now as a guest.
			expect(
				findingWithKey(await getAnalysis(USERS.owner), KEY_SCOPE),
			).toMatchObject({
				response: { settledSkipReason: "AUTHOR_RIGHTS" },
			});
		});

		it("marks an answer whose author was deleted, with no author", async () => {
			answer({ authorId: null });
			showing(shownRun());

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({
				response: { author: null, settledSkipReason: "AUTHOR_RIGHTS" },
			});
		});

		it("reports Needs Review over missing author rights", async () => {
			answer({ authorId: USERS.memberViewer });
			showing(shownRun());
			setBody(
				PROPOSAL_BODY.replace("reporting dashboard", "reporting suite"),
			);

			expect(
				findingWithKey(await getAnalysis(), KEY_SCOPE),
			).toMatchObject({
				response: { settledSkipReason: "NEEDS_REVIEW" },
			});
		});

		it("leaves an answer by the project owner and by an editor member unmarked", async () => {
			answer({ authorId: USERS.owner });
			answer({ stableKey: KEY_SUMMARY, authorId: USERS.editor });
			showing(shownRun());

			const read = await getAnalysis();

			expect(findingWithKey(read, KEY_SCOPE)).toMatchObject({
				response: { settledSkipReason: null },
			});
			expect(findingWithKey(read, KEY_SUMMARY)).toMatchObject({
				response: { settledSkipReason: null },
			});
		});
	});

	describe("evidence", () => {
		/**
		 * A manifest entry as a run stored it. Entries written before the
		 * manifest stopped keeping source text carry an `excerpt`; every entry
		 * here does, so a test that finds it in a read has caught the old text
		 * leaking back.
		 */
		const manifestEntry = (
			source: number,
			overrides: Record<string, unknown>,
		) => ({
			source,
			kind: "projectContext",
			id: null,
			contextType: null,
			title: null,
			sourceName: null,
			fingerprint: `fp-${source}`,
			excerpt: `Stored text of source ${source}.`,
			...overrides,
		});

		const MANIFEST = [
			manifestEntry(1, {
				id: "ctx-link",
				contextType: "LINK",
				title: "Stored link title",
			}),
			manifestEntry(2, {
				id: "ctx-text",
				contextType: "TEXT",
				title: "Stored notes title",
			}),
			manifestEntry(3, {
				kind: "company",
				id: "company-1",
				title: "Stored rate card chunk",
				sourceName: "Stored rate card",
			}),
			manifestEntry(4, {
				id: "ctx-deleted",
				contextType: "FILE",
				title: "Deleted brief",
				excerpt: "Text of a deleted brief.",
			}),
			manifestEntry(5, {
				id: "ctx-other-project",
				contextType: "LINK",
				title: "Another project's page",
				excerpt: "Text from another project.",
			}),
			manifestEntry(6, {
				kind: "company",
				id: "company-deleting",
				sourceName: "Retired price list",
				excerpt: "Text of a retired price list.",
			}),
			manifestEntry(7, { kind: "summary", title: "Project summary" }),
			manifestEntry(8, { kind: "other", title: null }),
			manifestEntry(9, {
				id: "ctx-meeting",
				contextType: "MEETING_TRANSCRIPT",
				title: "Stored call title",
			}),
			manifestEntry(10, {
				kind: "company",
				id: "company-other-org",
				sourceName: "Another org's source",
				excerpt: "Text from another organization.",
			}),
		];

		beforeEach(() => {
			world.contexts.set("ctx-link", {
				projectId: PROJECT_A,
				organizationId: ORG_A,
				type: "LINK",
				sourceTitle: "Client website",
				sourceUrl: "https://example.com/private-page",
				content:
					"Our client sells **industrial pumps**.\n\nThey want a new portal.",
			});
			world.contexts.set("ctx-text", {
				projectId: PROJECT_A,
				organizationId: ORG_A,
				type: "TEXT",
				sourceTitle: "Discovery notes",
				content: "# Discovery\n\nThe client wants SSO.",
			});
			world.contexts.set("ctx-meeting", {
				projectId: PROJECT_A,
				organizationId: ORG_A,
				type: "MEETING_TRANSCRIPT",
				sourceTitle: "Kickoff call",
				content: "Speaker 1: Welcome.",
			});
			world.contexts.set("ctx-other-project", {
				projectId: PROJECT_A2,
				organizationId: ORG_A,
				type: "LINK",
				sourceTitle: "Another project's page",
				content: "Text from another project.",
			});
			world.companySources.set("company-1", {
				organizationId: ORG_A,
				deletingAt: null,
				sourceTitle: "Rate card",
				content: "Senior rate is fixed.\nJunior rate varies.",
			});
			world.companySources.set("company-deleting", {
				organizationId: ORG_A,
				deletingAt: new Date("2026-10-12T00:00:00.000Z"),
				sourceTitle: "Retired price list",
				content: "Text of a retired price list.",
			});
			world.companySources.set("company-other-org", {
				organizationId: ORG_B,
				deletingAt: null,
				sourceTitle: "Another org's source",
				content: "Text from another organization.",
			});
		});

		async function evidenceFor(sourceRefs: number[], manifest = MANIFEST) {
			showing(
				shownRun({
					sourceManifest: manifest,
					findings: [finding(0, { sourceRefs })],
				}),
			);
			const read = await getAnalysis();
			return read.findings[0].evidence as Array<Record<string, unknown>>;
		}

		/** Give the context `id` new fields, as an edit of the row would. */
		function editContext(id: string, change: Partial<WorldContext>) {
			const row = world.contexts.get(id) as WorldContext;
			world.contexts.set(id, { ...row, ...change });
		}

		it("links a LINK or MEETING_TRANSCRIPT context of this project to its page, with its title and text as they are now", async () => {
			expect(await evidenceFor([1, 9])).toEqual([
				{
					source: 1,
					kind: "projectContext",
					contextType: "LINK",
					title: "Client website",
					excerpt:
						"Our client sells industrial pumps. They want a new portal.",
					link: {
						contextId: "ctx-link",
						href: `/app/${ORG_A_SLUG}/projects/${PROJECT_A}/contexts/ctx-link`,
					},
				},
				{
					source: 9,
					kind: "projectContext",
					contextType: "MEETING_TRANSCRIPT",
					title: "Kickoff call",
					excerpt: "Speaker 1: Welcome.",
					link: {
						contextId: "ctx-meeting",
						href: `/app/${ORG_A_SLUG}/projects/${PROJECT_A}/contexts/ctx-meeting`,
					},
				},
			]);
		});

		it("shows another context type's current title and excerpt without a link", async () => {
			expect(await evidenceFor([2])).toEqual([
				{
					source: 2,
					kind: "projectContext",
					contextType: "TEXT",
					title: "Discovery notes",
					excerpt: "Discovery The client wants SSO.",
					link: null,
				},
			]);
		});

		it("shows a company context source's current title and excerpt without a link", async () => {
			expect(await evidenceFor([3])).toEqual([
				{
					source: 3,
					kind: "company",
					title: "Rate card",
					excerpt: "Senior rate is fixed. Junior rate varies.",
				},
			]);
		});

		it("shows the project summary and other material by their stored label only, with no text", async () => {
			expect(await evidenceFor([7, 8])).toEqual([
				{ source: 7, kind: "summary", title: "Project summary" },
				{ source: 8, kind: "other", title: null },
			]);
		});

		it("never returns the text stored with the run, for any kind of source", async () => {
			const serialized = JSON.stringify(
				await evidenceFor([1, 2, 3, 7, 8, 9]),
			);

			expect(serialized).not.toContain("Stored text");
			expect(serialized).not.toContain("Stored link title");
			expect(serialized).not.toContain("Stored notes title");
			expect(serialized).not.toContain("Stored rate card");
			expect(serialized).not.toContain("Stored call title");
		});

		it("never returns a context's earlier text once it was edited after the run, though the row kept its id", async () => {
			editContext("ctx-text", {
				content: "Budget: 2M for the pilot.\n\nTimeline: Q3.",
			});
			const withBudget = MANIFEST.map((entry) =>
				entry.source === 2
					? {
							...entry,
							excerpt: "Budget: 2M for the pilot. Timeline: Q3.",
						}
					: entry,
			);
			expect(await evidenceFor([2], withBudget)).toEqual([
				expect.objectContaining({
					excerpt: "Budget: 2M for the pilot. Timeline: Q3.",
				}),
			]);

			editContext("ctx-text", { content: "Timeline: Q3." });

			const evidence = await evidenceFor([2], withBudget);
			expect(evidence).toEqual([
				expect.objectContaining({
					source: 2,
					kind: "projectContext",
					excerpt: "Timeline: Q3.",
				}),
			]);
			expect(JSON.stringify(evidence)).not.toContain("2M");
		});

		it("returns a renamed context's new title, never the one stored with the run", async () => {
			editContext("ctx-text", { sourceTitle: "Discovery notes (final)" });

			const evidence = await evidenceFor([2]);

			expect(evidence).toEqual([
				expect.objectContaining({ title: "Discovery notes (final)" }),
			]);
			expect(JSON.stringify(evidence)).not.toContain(
				"Stored notes title",
			);
		});

		it("titles a context with no title by its file name, then its path, and a company source never by its address", async () => {
			editContext("ctx-text", {
				sourceTitle: null,
				originalFilename: "brief.pdf",
			});
			editContext("ctx-meeting", {
				sourceTitle: "   ",
				sourcePath: "notes/kickoff.md",
			});
			world.companySources.set("company-1", {
				organizationId: ORG_A,
				deletingAt: null,
				sourceTitle: null,
				sourceUrl: "https://example.com/pricing",
				content: "Senior rate is fixed.",
			});

			const evidence = await evidenceFor([2, 9, 3]);

			expect(evidence.map((entry) => entry.title)).toEqual([
				"brief.pdf",
				"notes/kickoff.md",
				null,
			]);
			expect(JSON.stringify(evidence)).not.toContain("https://");
		});

		it("shows no excerpt for a source with no text yet", async () => {
			editContext("ctx-text", { content: "" });
			world.companySources.set("company-1", {
				organizationId: ORG_A,
				deletingAt: null,
				sourceTitle: "Rate card",
				content: "  \n\n ",
			});

			expect(await evidenceFor([2, 3])).toEqual([
				expect.objectContaining({ source: 2, excerpt: null }),
				expect.objectContaining({ source: 3, excerpt: null }),
			]);
		});

		it("shows plain text: markup, link targets and raw HTML gone, whitespace collapsed", async () => {
			editContext("ctx-text", {
				content: [
					"## Goals",
					"",
					"   Move  *every*   site to [the portal](https://example.com/portal).",
					"",
					"Intro <b>bold</b> text.",
					"",
					"- `SSO` first",
					"- reporting\tsecond",
				].join("\n"),
			});

			const [entry] = await evidenceFor([2]);

			expect(entry?.excerpt).toBe(
				"Goals Move every site to the portal. Intro bold text. SSO first reporting second",
			);
		});

		it("keeps an excerpt to 300 characters, never cut inside a surrogate pair", async () => {
			editContext("ctx-text", {
				content: `${"a".repeat(299)}😀 and more text after the cut`,
			});
			editContext("ctx-meeting", { content: "b".repeat(5000) });

			const [cut, long] = await evidenceFor([2, 9]);

			expect(cut?.excerpt).toBe("a".repeat(299));
			expect(long?.excerpt).toBe("b".repeat(300));
		});

		it("reports a deleted source as removed, with neither its stored title nor its text", async () => {
			const evidence = await evidenceFor([4, 6]);

			expect(evidence).toEqual([
				{ source: 4, kind: "removed" },
				{ source: 6, kind: "removed" },
			]);
			const serialized = JSON.stringify(evidence);
			expect(serialized).not.toContain("Deleted brief");
			expect(serialized).not.toContain("deleted brief");
			expect(serialized).not.toContain("Retired price list");
			expect(serialized).not.toContain("retired price list");
		});

		it("reports a context of another project, or a company source of another organization, as removed and nothing more", async () => {
			const evidence = await evidenceFor([5, 10]);

			expect(evidence).toEqual([
				{ source: 5, kind: "removed" },
				{ source: 10, kind: "removed" },
			]);
			const serialized = JSON.stringify(evidence);
			expect(serialized).not.toContain("ctx-other-project");
			expect(serialized).not.toContain("another project");
			expect(serialized).not.toContain("another organization");
		});

		it("reports a number the manifest does not hold as removed", async () => {
			expect(await evidenceFor([42])).toEqual([
				{ source: 42, kind: "removed" },
			]);
		});

		it("shows no evidence, and reads no row, for a run that has no manifest: nothing was checked, so nothing is called removed", async () => {
			expect(await evidenceFor([1, 3, 42], null as never)).toEqual([]);
			expect(mocks.readProposalEvidenceSources).not.toHaveBeenCalled();
		});

		it("keeps the evidence of a run whose manifest is empty: a cited number it does not hold is removed", async () => {
			expect(await evidenceFor([2], [] as never)).toEqual([
				{ source: 2, kind: "removed" },
			]);
		});

		it("reports a context or company entry stored without an id as removed", async () => {
			const withoutIds = [
				manifestEntry(1, { contextType: "LINK", title: "No id" }),
				manifestEntry(3, { kind: "company", sourceName: "No id" }),
			];

			expect(await evidenceFor([1, 3], withoutIds as never)).toEqual([
				{ source: 1, kind: "removed" },
				{ source: 3, kind: "removed" },
			]);
		});

		it("decides the link by the row's type now, not the type stored with the run", async () => {
			editContext("ctx-link", { type: "TEXT" });

			expect(await evidenceFor([1])).toEqual([
				expect.objectContaining({
					source: 1,
					kind: "projectContext",
					contextType: "TEXT",
					link: null,
				}),
			]);
		});

		it("lists a source cited twice once", async () => {
			expect(await evidenceFor([3, 3])).toHaveLength(1);
		});

		it("never returns a stored source address", async () => {
			const withUrl = MANIFEST.map((entry) => ({
				...entry,
				sourceUrl: "https://example.com/private-page",
			}));

			const serialized = JSON.stringify(
				await evidenceFor([1, 2, 3, 7, 8, 9], withUrl as never),
			);

			expect(serialized).not.toContain("https://");
		});

		it("reads the cited rows once, only in this project and the owning organization", async () => {
			await evidenceFor([1, 3, 7]);

			expect(mocks.readProposalEvidenceSources).toHaveBeenCalledTimes(1);
			expect(mocks.readProposalEvidenceSources).toHaveBeenCalledWith({
				organizationId: ORG_A,
				projectId: PROJECT_A,
				contextIds: ["ctx-link"],
				companySourceIds: ["company-1"],
			});
		});
	});

	describe("report", () => {
		const LINK_HREF = `/app/${ORG_A_SLUG}/projects/${PROJECT_A}/contexts/ctx-link`;

		const manifestEntry = (
			source: number,
			overrides: Record<string, unknown>,
		) => ({
			source,
			kind: "projectContext",
			id: null,
			contextType: null,
			title: null,
			sourceName: null,
			fingerprint: `fp-${source}`,
			...overrides,
		});

		const MANIFEST = [
			manifestEntry(1, { id: "ctx-text", contextType: "TEXT" }),
			manifestEntry(2, { id: "ctx-link", contextType: "LINK" }),
			manifestEntry(3, { id: "ctx-deleted", contextType: "FILE" }),
			manifestEntry(4, { kind: "summary", title: "Project summary" }),
		];

		const NEWER_RUN = {
			id: "run-2",
			kind: "RERUN",
			errorCode: null,
			timedOut: false,
			createdAt: minutesAfter(30),
		};

		beforeEach(() => {
			world.contexts.set("ctx-text", {
				projectId: PROJECT_A,
				organizationId: ORG_A,
				type: "TEXT",
				sourceTitle: "Discovery notes",
				content: "The client wants SSO.",
			});
			world.contexts.set("ctx-link", {
				projectId: PROJECT_A,
				organizationId: ORG_A,
				type: "LINK",
				sourceTitle: "Client website",
				sourceUrl: "https://example.com/private-page",
				content: "Our client sells industrial pumps.",
			});
		});

		async function reportOf(
			report: ReturnType<typeof storedReport>,
			run: Record<string, unknown> = {},
		) {
			reportsByRun({ "run-1": report });
			showing(shownRun({ sourceManifest: MANIFEST, ...run }));
			return (await getAnalysis()).report;
		}

		it("returns the shown run's report field by field, read for that run in the owning organization", async () => {
			const report = await reportOf(storedReport({ sources: [4, 1] }));

			expect(mocks.getAnalysisReport).toHaveBeenCalledTimes(1);
			expect(mocks.getAnalysisReport).toHaveBeenCalledWith({
				organizationId: ORG_A,
				documentId: DOC_A,
				analysisId: "run-1",
			});
			expect(report).toEqual({
				assessment: "Ready to send after two fixes",
				summary: "The scope is clear; nobody owns the data migration.",
				scope: [
					{
						item: "Data migration",
						priority: "MUST",
						inProposal: "Partly",
						note: "No owner is named.",
					},
					{
						item: "Reporting dashboard",
						priority: null,
						inProposal: "Yes",
						note: "",
					},
				],
				beforeSending: ["Name an owner for the data migration."],
				duringDiscovery: ["Confirm how often reports are needed."],
				text: "## Overall\n\nThe pilot is well framed, but the migration has no owner.",
				textTruncated: false,
				plainText: false,
				citations: [
					{
						source: 1,
						evidence: {
							source: 1,
							kind: "projectContext",
							contextType: "TEXT",
							title: "Discovery notes",
							excerpt: "The client wants SSO.",
							link: null,
						},
					},
					{
						source: 4,
						evidence: {
							source: 4,
							kind: "summary",
							title: "Project summary",
						},
					},
				],
			});
		});

		it("passes the truncation and plain-text flags through, and a report without text as a null text", async () => {
			expect(
				await reportOf(
					storedReport({ textTruncated: true, plainText: true }),
				),
			).toMatchObject({ textTruncated: true, plainText: true });
			expect(await reportOf(storedReport({ text: null }))).toMatchObject({
				assessment: "Ready to send after two fixes",
				text: null,
			});
		});

		it("links a LINK context that only the report cites, resolved in the same evidence read as the findings' sources", async () => {
			reportsByRun({ "run-1": storedReport({ sources: [2] }) });
			showing(
				shownRun({
					sourceManifest: MANIFEST,
					findings: [finding(0, { sourceRefs: [1] })],
				}),
			);

			const read = await getAnalysis();

			expect(read.report?.citations).toEqual([
				{
					source: 2,
					evidence: {
						source: 2,
						kind: "projectContext",
						contextType: "LINK",
						title: "Client website",
						excerpt: "Our client sells industrial pumps.",
						link: { contextId: "ctx-link", href: LINK_HREF },
					},
				},
			]);
			expect(read.findings[0].evidence).toEqual([
				expect.objectContaining({ source: 1, contextType: "TEXT" }),
			]);
			expect(mocks.readProposalEvidenceSources).toHaveBeenCalledTimes(1);
			expect(mocks.readProposalEvidenceSources).toHaveBeenCalledWith({
				organizationId: ORG_A,
				projectId: PROJECT_A,
				contextIds: ["ctx-text", "ctx-link"],
				companySourceIds: [],
			});
			expect(JSON.stringify(read.report)).not.toContain("https://");
		});

		it("cites a source deleted since the run as removed, and nothing more", async () => {
			const report = await reportOf(storedReport({ sources: [3] }));

			expect(report?.citations).toEqual([
				{ source: 3, evidence: { source: 3, kind: "removed" } },
			]);
		});

		it("drops a cited number the run's manifest does not hold, so it names no source", async () => {
			const report = await reportOf(storedReport({ sources: [2, 9] }));

			expect(
				report?.citations.map((citation) => citation.source),
			).toEqual([2]);
		});

		it("lists each cited source once, in ascending order", async () => {
			const report = await reportOf(storedReport({ sources: [4, 2, 4] }));

			expect(
				report?.citations.map((citation) => citation.source),
			).toEqual([2, 4]);
		});

		it("returns the report with no citations, and reads no source, for a run without a manifest", async () => {
			const report = await reportOf(storedReport({ sources: [1, 2] }), {
				sourceManifest: null,
			});

			expect(report).toMatchObject({
				assessment: "Ready to send after two fixes",
				citations: [],
			});
			expect(mocks.readProposalEvidenceSources).not.toHaveBeenCalled();
		});

		it("returns null for a shown run that stored no report", async () => {
			showing(shownRun({ sourceManifest: MANIFEST }));

			const read = await getAnalysis();

			expect(read.report).toBeNull();
			expect(read.findings).toHaveLength(3);
			expect(mocks.getAnalysisReport).toHaveBeenCalledWith({
				organizationId: ORG_A,
				documentId: DOC_A,
				analysisId: "run-1",
			});
		});

		it("reads no report while no run is shown, even with a newer run failed", async () => {
			reportsByRun({ "run-2": storedReport() });
			showing(null, { newerRun: { ...NEWER_RUN, status: "FAILED" } });

			const read = await getAnalysis();

			expect(read.report).toBeNull();
			expect(mocks.getAnalysisReport).not.toHaveBeenCalled();
		});

		it("returns a stale shown run's own report", async () => {
			reportsByRun({
				"run-1": storedReport({ assessment: "The stale run's view" }),
			});
			showing(shownRun({ sourceManifest: MANIFEST }), { isStale: true });

			const read = await getAnalysis();

			expect(read.isStale).toBe(true);
			expect(read.report).toMatchObject({
				assessment: "The stale run's view",
			});
		});

		it.each(["PENDING", "RUNNING", "FAILED"])(
			"reads only the shown run's report while a newer run is %s",
			async (status) => {
				reportsByRun({
					"run-1": storedReport(),
					"run-2": storedReport({
						assessment: "NEWER RUN ASSESSMENT",
						text: "NEWER RUN TEXT",
					}),
				});
				showing(shownRun({ sourceManifest: MANIFEST }), {
					newerRun: { ...NEWER_RUN, status },
				});

				const read = await getAnalysis();

				expect(mocks.getAnalysisReport.mock.calls).toEqual([
					[
						{
							organizationId: ORG_A,
							documentId: DOC_A,
							analysisId: "run-1",
						},
					],
				]);
				expect(read.report).toMatchObject({
					assessment: "Ready to send after two fixes",
				});
				expect(JSON.stringify(read)).not.toContain("NEWER RUN");
			},
		);
	});

	describe("can apply", () => {
		function canApplyOf(read: Read, id: string) {
			return read.findings.find((entry) => entry.id === id)?.canApply;
		}

		it("lets a member apply a keyed section finding whose section is as it was raised", async () => {
			showing(shownRun());

			const read = await getAnalysis();

			expect(canApplyOf(read, "finding-0")).toBe(true);
			expect(canApplyOf(read, "finding-1")).toBe(true);
		});

		it("refuses a finding written before stable keys", async () => {
			showing(shownRun());

			expect(canApplyOf(await getAnalysis(), "finding-2")).toBe(false);
		});

		it("refuses a finding about the whole document or the text before the first heading", async () => {
			showing(
				shownRun({
					findings: [
						finding(0, {
							stableKey: "GAP|document|pricing",
							sectionKey: DOCUMENT_SECTION_KEY,
							sectionHash: MAP.documentProseHash,
						}),
						finding(1, {
							stableKey: "GAP|preamble|intro",
							sectionKey: "p1:@preamble",
							sectionHash: SCOPE.proseHash,
						}),
						finding(2, { sectionKey: null, sectionHash: null }),
					],
				}),
			);

			const read = await getAnalysis();

			expect(read.findings.map((entry) => entry.canApply)).toEqual([
				false,
				false,
				false,
			]);
		});

		it("applies the title when there is no recommendation, and refuses a finding with neither", async () => {
			showing(
				shownRun({
					findings: [
						finding(0, { recommendation: null }),
						finding(1, {
							stableKey: KEY_GONE,
							recommendation: "  ",
							title: " ",
						}),
					],
				}),
			);

			const read = await getAnalysis();

			expect(canApplyOf(read, "finding-0")).toBe(true);
			expect(canApplyOf(read, "finding-1")).toBe(false);
		});

		it("refuses a finding whose section changed or is gone, and keeps the one whose section did not", async () => {
			showing(shownRun());

			setBody(
				PROPOSAL_BODY.replace(
					"the data migration and the reporting dashboard",
					"the reporting dashboard only",
				),
			);
			const edited = await getAnalysis();
			expect(canApplyOf(edited, "finding-0")).toBe(true);
			expect(canApplyOf(edited, "finding-1")).toBe(false);

			setBody(PROPOSAL_BODY.split("\n## Scope")[0] as string);
			expect(canApplyOf(await getAnalysis(), "finding-1")).toBe(false);
		});

		it("does not depend on whether the shown run is stale", async () => {
			showing(shownRun(), { isStale: true });

			const read = await getAnalysis();

			expect(read.isStale).toBe(true);
			expect(canApplyOf(read, "finding-0")).toBe(true);
			expect(canApplyOf(read, "finding-1")).toBe(true);
		});

		it("refuses every finding while a generation run is queued or writing", async () => {
			showing(shownRun());
			for (const status of ["QUEUED", "GENERATING"]) {
				const document = world.documents.get(DOC_A);
				world.documents.set(DOC_A, {
					...(document as NonNullable<typeof document>),
					status,
				});

				const read = await getAnalysis();

				expect(read.findings.map((entry) => entry.canApply)).toEqual([
					false,
					false,
					false,
				]);
			}
		});

		it("refuses a viewer who may not respond", async () => {
			showing(shownRun());

			const read = await getAnalysis(USERS.memberViewer);

			expect(read.viewer.canRespond).toBe(false);
			expect(read.findings.map((entry) => entry.canApply)).toEqual([
				false,
				false,
				false,
			]);
		});
	});

	describe("viewer", () => {
		const PLAIN_MEMBER = "user-plain-member";
		const DEMOTED_CREATOR = "user-demoted-creator";

		async function canRespond(userId: string) {
			showing(shownRun());
			return (await getAnalysis(userId)).viewer.canRespond;
		}

		/** Make `userId` the creator of project A. */
		function createdBy(userId: string) {
			const project = world.projects.get(PROJECT_A) as NonNullable<
				ReturnType<typeof world.projects.get>
			>;
			world.projects.set(PROJECT_A, { ...project, userId });
		}

		it("lets the project's owner and an editor member respond", async () => {
			expect(await canRespond(USERS.owner)).toBe(true);
			expect(await canRespond(USERS.editor)).toBe(true);
		});

		it("lets an organization member with no project-member row respond, through their organization role", async () => {
			world.orgMembers.set(`${ORG_A}:${PLAIN_MEMBER}`, "member");
			createdBy(PLAIN_MEMBER);

			expect(
				world.projectMembers.has(`${PROJECT_A}:${PLAIN_MEMBER}`),
			).toBe(false);
			expect(await canRespond(PLAIN_MEMBER)).toBe(true);
		});

		it("lets a project admin respond, whatever the page's legacy role says", async () => {
			world.projectMembers.set(
				`${PROJECT_A}:${USERS.memberViewer}`,
				"PROJECT_ADMIN",
			);

			expect(await canRespond(USERS.memberViewer)).toBe(true);
		});

		it("refuses a VIEWER or COMMENTER member", async () => {
			expect(await canRespond(USERS.memberViewer)).toBe(false);
			expect(await canRespond(USERS.memberCommenter)).toBe(false);
		});

		it("refuses the project's creator once their organization role no longer grants edits", async () => {
			world.orgMembers.set(`${ORG_A}:${DEMOTED_CREATOR}`, "viewer");
			createdBy(DEMOTED_CREATOR);

			expect(await canRespond(DEMOTED_CREATOR)).toBe(false);
		});

		it("answers exactly as a write would be decided", async () => {
			showing(shownRun());
			for (const userId of [
				USERS.owner,
				USERS.editor,
				USERS.memberViewer,
				USERS.memberCommenter,
			]) {
				const decided = await assertProjectPermission(
					PROJECT_A,
					userId,
					Permissions.DOCUMENT_UPDATE,
				).then(
					() => true,
					() => false,
				);
				expect((await getAnalysis(userId)).viewer.canRespond).toBe(
					decided,
				);
			}
		});
	});
});
