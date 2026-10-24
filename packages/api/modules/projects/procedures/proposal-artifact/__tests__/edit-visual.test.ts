/**
 * `projects.proposalArtifact.editVisual` (Fizzy #2946): Edit with
 * instructions returns a fact-checked candidate for one diagram of a
 * Proposal in artifact mode and stores its spec, and never writes Main; the
 * editor applies the candidate to that one fence.
 *
 * The gate middleware, the permission decision, the loader and the real
 * extraction (prompt, schema, fact check) run over the world in
 * `proposal-artifact-harness.ts`. The model, the AI rate limit and the spec
 * store are mocks the tests drive and inspect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const edit = vi.hoisted(() => ({
	appendProposalVisualSpec: vi.fn(),
	getLatestProposalVisualSpec: vi.fn(),
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	enforceAiRateLimit: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await (await import("./proposal-artifact-harness")).databaseModule()),
	appendProposalVisualSpec: edit.appendProposalVisualSpec,
	getLatestProposalVisualSpec: edit.getLatestProposalVisualSpec,
}));
vi.mock("@repo/ai", async () => ({
	...(await vi.importActual<typeof import("@repo/ai")>("@repo/ai")),
	generateObject: edit.generateObject,
	getAIModelWithMetadata: edit.getAIModelWithMetadata,
}));
vi.mock("../../../../../orpc/procedures", async () => ({
	...(await (await import("./proposal-artifact-harness")).proceduresModule()),
	enforceAiRateLimit: edit.enforceAiRateLimit,
}));

import { ORPCError } from "@orpc/client";
import { GLOSSY_EDIT_INSTRUCTION_MAX_CHARS } from "@repo/agent-prompts/glossy";
import { AIProviderNotConfiguredError } from "@repo/ai";
import {
	classifyVisualFences,
	diagramSectionFingerprint,
	VISUAL_EDIT_INSTRUCTION_MAX_CHARS,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { editProposalVisualProcedure } from "../edit-visual";
import {
	call,
	DOC_A,
	DOC_A2,
	declaredPermission,
	inputRefusal,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const MARKED_ID = "k3v9q2m7x1a8c4d6";
/** An organization member whose organization role is viewer. */
const ORG_VIEWER = "user-org-viewer";

const MARKED_BODY = [
	`%% fabric-visual: ${MARKED_ID}`,
	"flowchart TD",
	'  s0["Discovery"]',
	'  s1["Build"]',
	"  s0 --> s1",
	"  class s0,s1 surface",
].join("\n");

const HAND_BODY = ["flowchart LR", "  a[Kickoff] --> b[Handover]"].join("\n");

const GANTT_BODY = [
	"gantt",
	"  title Plan",
	"  section Build",
	"  Work :a1, 2026-01-01, 30d",
].join("\n");

function mainWith(markedBody: string = MARKED_BODY): string {
	return [
		"# Example Proposal",
		"",
		"## Approach",
		"",
		"First comes discovery, then the build, then the rollout in Q3 2026.",
		"",
		"```mermaid",
		markedBody,
		"```",
		"",
		"## Handover",
		"",
		"First comes the kickoff, then the handover.",
		"",
		"```mermaid",
		HAND_BODY,
		"```",
		"",
		"## Plan",
		"",
		"```mermaid",
		GANTT_BODY,
		"```",
	].join("\n");
}

const FLOW_SPEC = {
	kind: "flow",
	title: null,
	steps: [
		{ label: "Discovery", description: null, lane: null },
		{ label: "Build", description: null, lane: null },
		{ label: "Rollout", description: null, lane: null },
	],
};

const HANDOVER_SPEC = {
	kind: "flow",
	title: null,
	steps: [
		{ label: "Kickoff", description: null, lane: null },
		{ label: "Handover", description: null, lane: null },
	],
};

function modelReturns(spec: unknown) {
	edit.generateObject.mockResolvedValueOnce({ object: { spec }, usage: {} });
}

function editVisual(
	userId: string = USERS.editor,
	overrides: Record<string, unknown> = {},
) {
	return call(
		editProposalVisualProcedure,
		{
			projectId: PROJECT_A,
			documentId: DOC_A,
			visualId: MARKED_ID,
			fenceOrdinal: 0,
			fenceSourceHash: visualSourceHash(MARKED_BODY),
			instruction: "Add the rollout step",
			...overrides,
		},
		userId,
	) as Promise<Record<string, unknown>>;
}

function lastModelCall(): { instructions: string; prompt: string } {
	const calls = edit.generateObject.mock.calls;
	return calls[calls.length - 1][0];
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	for (const mock of Object.values(edit)) {
		mock.mockReset();
	}
	world.orgMembers.set(`${ORG_A}:${ORG_VIEWER}`, "viewer");
	world.projectMembers.set(`${PROJECT_A}:${ORG_VIEWER}`, "VIEWER");
	const document = world.documents.get(DOC_A);
	if (document) {
		document.content = mainWith();
	}
	edit.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { provider: "OPENAI" },
		trackUsage: vi.fn(),
	});
	edit.enforceAiRateLimit.mockResolvedValue(undefined);
	edit.appendProposalVisualSpec.mockResolvedValue({ created: true });
	edit.getLatestProposalVisualSpec.mockResolvedValue({
		visualId: MARKED_ID,
		sourceHash: visualSourceHash(MARKED_BODY),
		specHash: "v1:0000000000000000",
		kind: "flow",
		origin: "STEP",
		spec: {},
		createdAt: new Date("2026-10-01"),
	});
});

describe("declared chain", () => {
	it("runs the rollout gate, then DOCUMENT_UPDATE", () => {
		const chain = (editProposalVisualProcedure as { __chain: unknown[] })
			.__chain;
		expect(chain).toHaveLength(2);
		expect(typeof chain[0]).toBe("function");
		expect(declaredPermission(editProposalVisualProcedure)).toBe(
			"document:update",
		);
	});

	it.each([
		["an empty instruction", { instruction: "   " }],
		[
			"an instruction of control characters only",
			{ instruction: "\u0007\u0001\u007f" },
		],
		[
			"an instruction over 500 characters",
			{ instruction: "x".repeat(501) },
		],
		["a negative ordinal", { fenceOrdinal: -1 }],
	])("refuses %s", async (_label, overrides) => {
		const result = await inputRefusal(editVisual(USERS.editor, overrides));
		expect(result.code).toBe("BAD_REQUEST");
		expect(edit.generateObject).not.toHaveBeenCalled();
	});
});

describe("editVisual", () => {
	it("returns a candidate that changes only that fence, and writes nothing to Main", async () => {
		const before = world.documents.get(DOC_A)?.content ?? "";
		modelReturns(FLOW_SPEC);

		const result = await editVisual();

		expect(result).toMatchObject({
			status: "CANDIDATE",
			visualId: MARKED_ID,
			kind: "flow",
			sectionFingerprint: diagramSectionFingerprint(before, 0),
		});
		const fence = String(result.fence);
		expect(fence.split("\n")[0]).toBe(`%% fabric-visual: ${MARKED_ID}`);
		expect(fence).toContain("flowchart");
		expect(fence).toContain("Rollout");
		expect(fence).not.toContain("```");
		// Main is the editor's to write: the document is as it was.
		expect(world.documents.get(DOC_A)?.content).toBe(before);

		// The spec row the candidate classifies against, written first.
		expect(edit.appendProposalVisualSpec).toHaveBeenCalledOnce();
		const row = edit.appendProposalVisualSpec.mock.calls[0][0];
		expect(row).toMatchObject({
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
			visualId: MARKED_ID,
			sourceHash: visualSourceHash(fence),
			kind: "flow",
			origin: "INSTRUCTION",
			createdById: USERS.editor,
		});

		// Applied as the editor applies it: only that fence's text changes,
		// the hand-written diagram included, and it then reads as generated.
		const applied = before.replace(MARKED_BODY, fence);
		const [head, tail] = before.split(MARKED_BODY);
		expect(applied.startsWith(head)).toBe(true);
		expect(applied.endsWith(tail)).toBe(true);
		const classified = classifyVisualFences(applied, [
			{
				visualId: row.visualId,
				sourceHash: row.sourceHash,
				kind: row.kind,
				origin: row.origin,
			},
		]);
		expect(classified[0]).toMatchObject({
			state: "generated",
			origin: "INSTRUCTION",
		});
		expect(classified[1].state).toBe("none");
	});

	it("gives a project guest with edit rights a candidate, on the owning organization's model", async () => {
		modelReturns(FLOW_SPEC);

		const result = await editVisual(USERS.guestEditor);

		expect(result.status).toBe("CANDIDATE");
		const [, modelContext] = edit.getAIModelWithMetadata.mock.calls[0];
		// The guest's session names their own workspace; the model is the
		// project's organization's.
		expect(modelContext).toMatchObject({
			userId: USERS.guestEditor,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			featureKey: "proposal-visuals",
		});
	});

	it.each([
		["an organization owner", USERS.owner],
		["a project guest with edit rights", USERS.guestEditor],
	])(
		"sends %s's request with no style direction, Brand kit guidance or settled decisions",
		async (_label, userId) => {
			modelReturns(FLOW_SPEC);

			await editVisual(userId);

			const { instructions, prompt } = lastModelCall();
			expect(prompt).not.toContain('source="style_direction"');
			expect(prompt).not.toContain('source="slot_hint"');
			expect(`${instructions}\n${prompt}`).not.toMatch(
				/guidance from the brand kit|settled decision/i,
			);
			expect(prompt).toContain('source="instruction"');
			expect(prompt).toContain('source="current_diagram"');
			// The section's text reaches the model without its diagram fences.
			expect(prompt).toContain("then the rollout in Q3 2026");
			expect(prompt).not.toContain("```");
			expect(prompt).not.toContain("Kickoff");
		},
	);

	it.each([
		["a project guest with a VIEWER role", USERS.guestViewer],
		["an organization member with a VIEWER role", USERS.memberViewer],
		["an organization viewer", ORG_VIEWER],
		["a commenter", USERS.memberCommenter],
	])("refuses %s as FORBIDDEN", async (_label, userId) => {
		const result = await refusal(editVisual(userId));
		expect(result.code).toBe("FORBIDDEN");
		expect(edit.generateObject).not.toHaveBeenCalled();
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
	});

	it("refuses a caller outside the project, another project's document and a document outside the gate as NOT_FOUND", async () => {
		expect((await refusal(editVisual(USERS.outsider))).code).toBe(
			"NOT_FOUND",
		);
		expect(
			(await refusal(editVisual(USERS.editor, { documentId: DOC_A2 })))
				.code,
		).toBe("NOT_FOUND");
		expect(
			(
				await refusal(
					editVisual(USERS.outsider, {
						projectId: PROJECT_B,
						documentId: DOC_A,
					}),
				)
			).code,
		).toBe("NOT_FOUND");
		world.flags.set(ORG_A, false);
		expect((await refusal(editVisual(USERS.editor))).code).toBe(
			"NOT_FOUND",
		);
		expect(edit.generateObject).not.toHaveBeenCalled();
	});

	it("answers STALE when the fence's source changed since the editor read it", async () => {
		const result = await editVisual(USERS.editor, {
			fenceSourceHash: visualSourceHash(`${MARKED_BODY}\n  s1 --> s0`),
		});

		expect(result).toEqual({ status: "STALE" });
		expect(edit.generateObject).not.toHaveBeenCalled();
		expect(edit.enforceAiRateLimit).not.toHaveBeenCalled();
	});

	it("answers STALE for an ordinal past the last diagram", async () => {
		const result = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 7,
		});
		expect(result).toEqual({ status: "STALE" });
	});

	it("refuses a candidate with a date the section does not state but the old diagram does", async () => {
		const document = world.documents.get(DOC_A);
		const datedBody = [
			`%% fabric-visual: ${MARKED_ID}`,
			"flowchart TD",
			'  s0["Q1 2027: Discovery"]',
			'  s1["Build"]',
			"  s0 --> s1",
		].join("\n");
		if (document) {
			document.content = mainWith(datedBody);
		}
		const before = document?.content;
		modelReturns({
			kind: "flow",
			title: null,
			steps: [
				{ label: "Q1 2027 Discovery", description: null, lane: null },
				{ label: "Build", description: null, lane: null },
			],
		});

		const result = await editVisual(USERS.editor, {
			fenceSourceHash: visualSourceHash(datedBody),
		});

		expect(result.status).toBe("FACT_CHECK_REFUSED");
		expect(result.violations).toEqual(
			expect.arrayContaining(["presence:date"]),
		);
		// Codes only: the refusal carries no text of the section or request.
		expect(JSON.stringify(result)).not.toContain("2027");
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
		expect(world.documents.get(DOC_A)?.content).toBe(before);
	});

	it.each([
		[
			"a blockquote",
			(body: string) =>
				[
					"## Approach",
					"",
					"First comes discovery, then the build.",
					"",
					...["```mermaid", ...body.split("\n"), "```"].map(
						(line) => `> ${line}`,
					),
				].join("\n"),
		],
		[
			"a list item indented four spaces or more",
			(body: string) =>
				[
					"## Approach",
					"",
					"First comes discovery, then the build.",
					"",
					"- Phases",
					"    - Details",
					"",
					...["```mermaid", ...body.split("\n"), "```"].map(
						(line) => `        ${line}`,
					),
				].join("\n"),
		],
	])(
		"refuses a date only the old diagram shows when it sits in %s",
		async (_label, contentWith) => {
			const datedBody = [
				`%% fabric-visual: ${MARKED_ID}`,
				"flowchart TD",
				'  s0["Q1 2027: Discovery"]',
				'  s1["Build"]',
				"  s0 --> s1",
			].join("\n");
			const document = world.documents.get(DOC_A);
			if (document) {
				document.content = contentWith(datedBody);
			}
			modelReturns({
				kind: "flow",
				title: null,
				steps: [
					{
						label: "Q1 2027 Discovery",
						description: null,
						lane: null,
					},
					{ label: "Build", description: null, lane: null },
				],
			});

			const result = await editVisual(USERS.editor, {
				fenceSourceHash: visualSourceHash(datedBody),
			});

			expect(result.status).toBe("FACT_CHECK_REFUSED");
			expect(result.violations).toEqual(
				expect.arrayContaining(["presence:date"]),
			);
			expect(lastModelCall().prompt).not.toContain("```");
			expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
		},
	);

	it("fails an extraction that comes back unusable without storing a spec", async () => {
		// The stored kind is flow; a timeline is dropped as the wrong kind.
		modelReturns({
			kind: "timeline",
			title: null,
			items: [
				{ date: "Q3 2026", label: "Rollout", description: null },
				{ date: "Q3 2026", label: "Build", description: null },
			],
		});

		const result = await refusal(editVisual());

		expect(result.code).toBe("INTERNAL_SERVER_ERROR");
		expect(result.message).toBe(
			"The diagram could not be redrawn. Try again.",
		);
		expect(edit.generateObject).toHaveBeenCalledOnce();
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
	});

	it("stores nothing for a request abandoned while the model ran", async () => {
		const controller = new AbortController();
		edit.generateObject.mockImplementationOnce(async () => {
			controller.abort();
			return { object: { spec: FLOW_SPEC }, usage: {} };
		});

		const pending = call(
			editProposalVisualProcedure,
			{
				projectId: PROJECT_A,
				documentId: DOC_A,
				visualId: MARKED_ID,
				fenceOrdinal: 0,
				fenceSourceHash: visualSourceHash(MARKED_BODY),
				instruction: "Add the rollout step",
			},
			USERS.editor,
			{ signal: controller.signal },
		);

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(edit.generateObject).toHaveBeenCalledOnce();
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
	});

	it("answers UNSUPPORTED_DIAGRAM for a gantt chart", async () => {
		const result = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 2,
			fenceSourceHash: visualSourceHash(GANTT_BODY),
		});
		expect(result).toEqual({ status: "UNSUPPORTED_DIAGRAM" });
		expect(edit.generateObject).not.toHaveBeenCalled();
	});

	it("redraws a flowchart whose header follows a %% comment, and refuses a graph-x header", async () => {
		const commented = [
			"%% drawn by hand",
			"flowchart LR",
			"  a[Kickoff] --> b[Handover]",
		].join("\n");
		const notFlowchart = ["graph-x", "  a --> b"].join("\n");
		const document = world.documents.get(DOC_A);
		if (document) {
			document.content = [
				"## Handover",
				"",
				"First comes the kickoff, then the handover.",
				"",
				"```mermaid",
				commented,
				"```",
				"",
				"```mermaid",
				notFlowchart,
				"```",
			].join("\n");
		}
		modelReturns(HANDOVER_SPEC);

		const supported = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 0,
			fenceSourceHash: visualSourceHash(commented),
		});
		expect(supported.status).toBe("CANDIDATE");

		const unsupported = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 1,
			fenceSourceHash: visualSourceHash(notFlowchart),
		});
		expect(unsupported).toEqual({ status: "UNSUPPORTED_DIAGRAM" });
	});

	it("bounds the request as the editor's form does", () => {
		expect(GLOSSY_EDIT_INSTRUCTION_MAX_CHARS).toBe(
			VISUAL_EDIT_INSTRUCTION_MAX_CHARS,
		);
	});

	it("answers UNSUPPORTED_DIAGRAM for a fence larger than any generated diagram", async () => {
		const huge = [
			"flowchart TD",
			...Array.from({ length: 300 }, (_, i) => `  n${i}["Step ${i}"]`),
		].join("\n");
		const document = world.documents.get(DOC_A);
		if (document) {
			document.content = mainWith(huge);
		}

		const result = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceSourceHash: visualSourceHash(huge),
		});
		expect(result).toEqual({ status: "UNSUPPORTED_DIAGRAM" });
	});

	it("gives an unmarked fence a fresh id, and the row an INSTRUCTION origin", async () => {
		modelReturns(HANDOVER_SPEC);

		const result = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 1,
			fenceSourceHash: visualSourceHash(HAND_BODY),
		});

		expect(result.status).toBe("CANDIDATE");
		expect(result.visualId).toMatch(/^[a-z0-9]{16}$/);
		expect(result.visualId).not.toBe(MARKED_ID);
		expect(String(result.fence).split("\n")[0]).toBe(
			`%% fabric-visual: ${result.visualId}`,
		);
		// No row to take a kind from: the extraction chose among diagrams.
		expect(edit.getLatestProposalVisualSpec).not.toHaveBeenCalled();
		expect(lastModelCall().prompt).toContain("Requested kind: auto");
		expect(edit.appendProposalVisualSpec.mock.calls[0][0]).toMatchObject({
			visualId: result.visualId,
			origin: "INSTRUCTION",
			sourceHash: visualSourceHash(String(result.fence)),
		});
	});

	it("gives a second copy of a marked fence a fresh id", async () => {
		const document = world.documents.get(DOC_A);
		if (document) {
			document.content = mainWith().replace(HAND_BODY, MARKED_BODY);
		}
		modelReturns(HANDOVER_SPEC);

		const result = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 1,
		});

		expect(result.status).toBe("CANDIDATE");
		expect(result.visualId).not.toBe(MARKED_ID);
	});

	it("edits the fence at the ordinal sent, not the first one carrying its id", async () => {
		// Two sections with the same marked diagram; only the first states
		// the date.
		const document = world.documents.get(DOC_A);
		if (document) {
			document.content = mainWith().replace(HAND_BODY, MARKED_BODY);
		}
		modelReturns({
			kind: "flow",
			title: null,
			steps: [
				{ label: "Kickoff", description: null, lane: null },
				{ label: "Rollout in Q3 2026", description: null, lane: null },
			],
		});

		// A second copy is detached: the editor names no id for it.
		const refused = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 1,
		});

		expect(refused.status).toBe("FACT_CHECK_REFUSED");
		expect(refused.violations).toEqual(
			expect.arrayContaining(["presence:date"]),
		);
		expect(lastModelCall().prompt).toContain("First comes the kickoff");
		expect(lastModelCall().prompt).not.toContain("Q3 2026");
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();

		modelReturns(HANDOVER_SPEC);
		const result = await editVisual(USERS.editor, {
			visualId: undefined,
			fenceOrdinal: 1,
		});

		expect(result.status).toBe("CANDIDATE");
		expect(result.visualId).toMatch(/^[a-z0-9]{16}$/);
		expect(result.visualId).not.toBe(MARKED_ID);
		expect(result.sectionFingerprint).toBe(
			diagramSectionFingerprint(document?.content ?? "", 1),
		);
		expect(edit.getLatestProposalVisualSpec).not.toHaveBeenCalled();
		expect(edit.appendProposalVisualSpec.mock.calls[0][0]).toMatchObject({
			visualId: result.visualId,
		});
	});

	it("answers STALE and stores nothing when the section's prose changed while the model ran", async () => {
		const document = world.documents.get(DOC_A);
		edit.generateObject.mockImplementationOnce(async () => {
			if (document) {
				document.content = document.content.replace(
					"then the rollout in Q3 2026",
					"then the rollout in Q4 2026",
				);
			}
			return { object: { spec: FLOW_SPEC }, usage: {} };
		});

		const result = await editVisual();

		expect(result).toEqual({ status: "STALE" });
		expect(edit.generateObject).toHaveBeenCalledOnce();
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
	});

	it("answers STALE and stores nothing when the fence changed while the model ran", async () => {
		const document = world.documents.get(DOC_A);
		edit.generateObject.mockImplementationOnce(async () => {
			if (document) {
				document.content = document.content.replace(
					"  s0 --> s1",
					"  s1 --> s0",
				);
			}
			return { object: { spec: FLOW_SPEC }, usage: {} };
		});

		const result = await editVisual();

		expect(result).toEqual({ status: "STALE" });
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
	});

	it("still answers with a candidate when only another section changed meanwhile", async () => {
		const document = world.documents.get(DOC_A);
		edit.generateObject.mockImplementationOnce(async () => {
			if (document) {
				document.content = document.content.replace(
					"then the handover.",
					"then the handover and support.",
				);
			}
			return { object: { spec: FLOW_SPEC }, usage: {} };
		});

		const result = await editVisual();

		expect(result.status).toBe("CANDIDATE");
		expect(edit.appendProposalVisualSpec).toHaveBeenCalledOnce();
	});

	describe("two marked diagrams with the same source in one section", () => {
		const OTHER_ID = "p5w8r2t6y4u1i9o3";
		const otherBody = MARKED_BODY.replace(MARKED_ID, OTHER_ID);

		function twinsMain(first: string, second: string): string {
			return [
				"## Approach",
				"",
				"First comes discovery, then the build, then the rollout in Q3 2026.",
				"",
				"```mermaid",
				first,
				"```",
				"",
				"```mermaid",
				second,
				"```",
			].join("\n");
		}

		beforeEach(() => {
			const document = world.documents.get(DOC_A);
			if (document) {
				document.content = twinsMain(MARKED_BODY, otherBody);
			}
		});

		it("shares one source hash and one section fingerprint", () => {
			const swapped = twinsMain(otherBody, MARKED_BODY);
			const original = twinsMain(MARKED_BODY, otherBody);
			expect(visualSourceHash(otherBody)).toBe(
				visualSourceHash(MARKED_BODY),
			);
			expect(diagramSectionFingerprint(swapped, 0)).toBe(
				diagramSectionFingerprint(original, 0),
			);
		});

		it("answers STALE without calling the model when the ordinal now holds the other diagram", async () => {
			const document = world.documents.get(DOC_A);
			if (document) {
				document.content = twinsMain(otherBody, MARKED_BODY);
			}

			const result = await editVisual();

			expect(result).toEqual({ status: "STALE" });
			expect(edit.enforceAiRateLimit).not.toHaveBeenCalled();
			expect(edit.generateObject).not.toHaveBeenCalled();
			expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
		});

		it("answers STALE and stores nothing when the two swap while the model ran", async () => {
			const document = world.documents.get(DOC_A);
			edit.generateObject.mockImplementationOnce(async () => {
				if (document) {
					document.content = twinsMain(otherBody, MARKED_BODY);
				}
				return { object: { spec: FLOW_SPEC }, usage: {} };
			});

			const result = await editVisual();

			expect(result).toEqual({ status: "STALE" });
			expect(edit.generateObject).toHaveBeenCalledOnce();
			expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
		});

		it("returns a candidate under the id sent while each stays in place", async () => {
			modelReturns(FLOW_SPEC);
			const first = await editVisual();
			expect(first).toMatchObject({
				status: "CANDIDATE",
				visualId: MARKED_ID,
			});

			modelReturns(FLOW_SPEC);
			const second = await editVisual(USERS.editor, {
				visualId: OTHER_ID,
				fenceOrdinal: 1,
			});
			expect(second).toMatchObject({
				status: "CANDIDATE",
				visualId: OTHER_ID,
			});
			expect(
				edit.appendProposalVisualSpec.mock.calls.map(
					([row]) => row.visualId,
				),
			).toEqual([MARKED_ID, OTHER_ID]);
		});
	});

	it("keeps the stored kind for a marked visual", async () => {
		modelReturns(FLOW_SPEC);

		await editVisual();

		expect(edit.getLatestProposalVisualSpec).toHaveBeenCalledWith({
			projectId: PROJECT_A,
			documentId: DOC_A,
			visualId: MARKED_ID,
		});
		expect(lastModelCall().prompt).toContain("Requested kind: flow.");
	});

	it("answers AI_PROVIDER_NOT_CONFIGURED and stores nothing", async () => {
		edit.getAIModelWithMetadata.mockRejectedValueOnce(
			new AIProviderNotConfiguredError("not configured"),
		);

		const result = await editVisual();

		expect(result).toEqual({ status: "AI_PROVIDER_NOT_CONFIGURED" });
		expect(edit.appendProposalVisualSpec).not.toHaveBeenCalled();
	});

	it("answers RATE_LIMITED when the AI rate limit refuses", async () => {
		edit.enforceAiRateLimit.mockRejectedValueOnce(
			new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down" }),
		);

		const result = await editVisual();

		expect(result).toEqual({ status: "RATE_LIMITED" });
		expect(edit.enforceAiRateLimit.mock.calls[0][0]).toBe(USERS.editor);
		expect(edit.generateObject).not.toHaveBeenCalled();
	});
});
