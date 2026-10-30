/**
 * `projects.proposalArtifact.reviseSection` (Fizzy #2946): applying a
 * finding's recommendation returns a candidate for the finding's section and
 * a revision token, and never writes Main.
 *
 * The gate middleware, the permission decision, the access loaders and the
 * real revision library (placeholders, structure and echo checks, splice,
 * preservation) run over the world in `proposal-artifact-harness.ts`. The
 * model, the AI rate limit, the prompt binding, the settled-decisions builder
 * and the token signer are mocks the tests drive and inspect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const revise = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	enforceAiRateLimit: vi.fn(),
	findBoundProposalPrompt: vi.fn(),
	buildSettledDecisionsBlock: vi.fn(),
	signRevisionToken: vi.fn(),
	promptVersionFindUnique: vi.fn(),
	/** The stored row's columns the world's documents do not carry. */
	stored: { status: "DRAFT", version: 3 } as {
		status: string;
		version: number;
	},
}));

vi.mock("@repo/database", async () => {
	const base = await (
		await import("./proposal-artifact-harness")
	).databaseModule();
	const fakeDb = base.db as unknown as {
		projectDocument: {
			findFirst: (
				args: unknown,
			) => Promise<Record<string, unknown> | null>;
		};
	};
	return {
		...base,
		db: {
			...fakeDb,
			projectDocument: {
				findFirst: async (args: unknown) => {
					const row = await fakeDb.projectDocument.findFirst(args);
					return row ? { ...row, ...revise.stored } : null;
				},
			},
			promptVersion: { findUnique: revise.promptVersionFindUnique },
		},
	};
});
vi.mock("@repo/ai", async () => ({
	...(await vi.importActual<typeof import("@repo/ai")>("@repo/ai")),
	generateText: revise.generateText,
	getAIModelWithMetadata: revise.getAIModelWithMetadata,
}));
vi.mock("../../../../../orpc/procedures", async () => ({
	...(await (await import("./proposal-artifact-harness")).proceduresModule()),
	enforceAiRateLimit: revise.enforceAiRateLimit,
}));
vi.mock("@repo/temporal/proposal-artifact-prompts", async () => ({
	...(await vi.importActual<
		typeof import("@repo/temporal/proposal-artifact-prompts")
	>("@repo/temporal/proposal-artifact-prompts")),
	findBoundProposalPrompt: revise.findBoundProposalPrompt,
}));
vi.mock("@repo/temporal/proposal-artifact-settled-decisions", async () => ({
	...(await vi.importActual<
		typeof import("@repo/temporal/proposal-artifact-settled-decisions")
	>("@repo/temporal/proposal-artifact-settled-decisions")),
	buildSettledDecisionsBlock: revise.buildSettledDecisionsBlock,
}));
vi.mock("../../../lib/proposal-revision-token", async () => ({
	...(await vi.importActual<
		typeof import("../../../lib/proposal-revision-token")
	>("../../../lib/proposal-revision-token")),
	signRevisionToken: revise.signRevisionToken,
}));

import { ORPCError } from "@orpc/client";
import { AIProviderNotConfiguredError } from "@repo/ai";
import { spliceSectionBody } from "@repo/temporal/proposal-artifact-revise-section";
import { contentIdentity } from "@repo/utils/content-identity";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	findSection,
	PREAMBLE_SECTION_KEY,
} from "@repo/utils/proposal-artifact/section-hash";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { revisionSectionFingerprint } from "../../../lib/proposal-revision-token";
import { reviseProposalSectionProcedure } from "../revise-section";
import {
	call,
	DOC_A,
	DOC_B,
	declaredPermission,
	declaredRoute,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	type WorldFinding,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const DIAGRAM = [
	"```mermaid",
	"%% fabric-visual: k3v9q2m7x1a8c4d6",
	"flowchart TD",
	'  s0["Discovery"] --> s1["Build"]',
	"```",
].join("\n");
const SLOT =
	'<visual-slot data-slot-id="slot-1" data-kind="timeline"></visual-slot>';

const MAIN = [
	"# Example Proposal",
	"",
	"## 1. Executive Summary",
	"",
	"We propose a pilot for Example Org.",
	"",
	"## 2. Scope",
	"",
	"The pilot covers the data migration.",
	"",
	"## 3. Team",
	"",
	"A delivery lead and two engineers.",
	"",
	"## 4. Approach",
	"",
	"We start with discovery and then build.",
	"",
	DIAGRAM,
	"",
	SLOT,
	"",
	"The rollout follows in Q3 2026.",
	"",
	"## 5. Pricing",
	"",
	"A fixed fee of 40k.",
].join("\n");

const SECTION_MAP = buildSectionMap(MAIN);
const APPROACH = SECTION_MAP.sections.find(
	(section) => section.headingText === "4. Approach",
) as NonNullable<ReturnType<typeof findSection>>;

const RUN_ID = "run-1";
const FINDING_ID = "finding-approach";
const STABLE_KEY = "key-approach";
const RECOMMENDATION =
	"State how long discovery takes and what it delivers to the client.";
const TITLE = "Discovery is vague";

const TOKEN_1 = "<<<FABRIC_VISUAL_1>>>";
const TOKEN_2 = "<<<FABRIC_VISUAL_2>>>";
const MODEL_BODY = [
	"We start with a two-week discovery that ends in a written plan, and then build.",
	"",
	TOKEN_1,
	"",
	TOKEN_2,
	"",
	"The rollout follows in Q3 2026.",
].join("\n");
const RESTORED_BODY = [
	"We start with a two-week discovery that ends in a written plan, and then build.",
	"",
	DIAGRAM,
	"",
	SLOT,
	"",
	"The rollout follows in Q3 2026.",
].join("\n");

const SETTLED_BLOCK =
	"<<<FABRIC_SETTLED_DECISIONS>>>\n- settled\n<<<END_FABRIC_SETTLED_DECISIONS>>>";

/** A finding of the run, with the recommendation the world's type leaves out. */
function addFinding(
	overrides: Partial<WorldFinding> & Record<string, unknown>,
) {
	const finding = {
		id: FINDING_ID,
		title: TITLE,
		stableKey: STABLE_KEY,
		sectionKey: APPROACH.key,
		sectionHash: APPROACH.proseHash,
		recommendation: RECOMMENDATION,
		...overrides,
	} as WorldFinding;
	world.runs.set(RUN_ID, {
		id: RUN_ID,
		documentId: DOC_A,
		organizationId: ORG_A,
		proseHash: SECTION_MAP.documentProseHash,
		sourceRunId: null,
		findings: [finding],
	});
}

function modelWrites(...texts: string[]) {
	for (const text of texts) {
		revise.generateText.mockResolvedValueOnce({
			text,
			finishReason: "stop",
			usage: {},
		});
	}
}

function reviseSection(
	overrides: Record<string, unknown> = {},
	userId: string = USERS.editor,
) {
	return call(
		reviseProposalSectionProcedure,
		{
			projectId: PROJECT_A,
			documentId: DOC_A,
			runId: RUN_ID,
			findingId: FINDING_ID,
			baseVersion: 3,
			baseContentHash: contentIdentity(MAIN),
			...overrides,
		},
		userId,
	);
}

function addResponse(text: string | null) {
	world.responses.push({
		id: "response-approach",
		organizationId: ORG_A,
		projectId: PROJECT_A,
		documentId: DOC_A,
		stableKey: STABLE_KEY,
		kind: text ? "RESPONDED" : "CONFIRMED",
		text,
		findingTitle: TITLE,
		answeredRunId: RUN_ID,
		sectionKey: APPROACH.key,
		sectionHash: APPROACH.proseHash,
		authorId: USERS.owner,
		version: 4,
		createdAt: new Date("2026-10-20"),
		updatedAt: new Date("2026-10-21"),
	});
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	for (const mock of [
		revise.generateText,
		revise.getAIModelWithMetadata,
		revise.enforceAiRateLimit,
		revise.findBoundProposalPrompt,
		revise.buildSettledDecisionsBlock,
		revise.signRevisionToken,
		revise.promptVersionFindUnique,
	]) {
		mock.mockReset();
	}
	revise.stored.status = "DRAFT";
	revise.stored.version = 3;
	const document = world.documents.get(DOC_A);
	if (document) {
		document.content = MAIN;
	}
	addFinding({});
	revise.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { provider: "OPENAI" },
		trackUsage: vi.fn(),
	});
	revise.enforceAiRateLimit.mockResolvedValue(undefined);
	revise.findBoundProposalPrompt.mockResolvedValue({
		promptId: "prompt-revision",
		versionNumber: 2,
		promptVersionId: "prompt-version-revision",
	});
	revise.promptVersionFindUnique.mockResolvedValue({
		content: "Write for external readers. Keep headings.",
		prompt: { format: "PLAIN_TEXT", scope: "SYSTEM", organizationId: null },
	});
	revise.buildSettledDecisionsBlock.mockResolvedValue(null);
	revise.signRevisionToken.mockReturnValue("signed-revision-token");
});

describe("declared chain", () => {
	it("runs the rollout gate, then DOCUMENT_UPDATE, on the findings route", () => {
		const chain = (reviseProposalSectionProcedure as { __chain: unknown[] })
			.__chain;
		expect(chain).toHaveLength(2);
		expect(typeof chain[0]).toBe("function");
		expect(declaredPermission(reviseProposalSectionProcedure)).toBe(
			"document:update",
		);
		expect(declaredRoute(reviseProposalSectionProcedure)).toMatchObject({
			method: "POST",
			path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/findings/revise",
		});
	});
});

describe("candidate", () => {
	it("returns the revised section 4 and leaves every other section unchanged when spliced", async () => {
		modelWrites(MODEL_BODY);

		const result = (await reviseSection()) as Record<string, unknown>;

		expect(result).toEqual({
			status: "CANDIDATE",
			sectionKey: APPROACH.key,
			body: RESTORED_BODY,
			baseVersion: 3,
			baseContentHash: contentIdentity(MAIN),
			revisionToken: "signed-revision-token",
		});
		const spliced = spliceSectionBody(
			MAIN,
			APPROACH.key,
			result.body as string,
		) as string;
		const after = buildSectionMap(spliced);
		for (const section of SECTION_MAP.sections) {
			if (section.key === APPROACH.key) {
				continue;
			}
			expect(findSection(after, section.key)?.proseHash).toBe(
				section.proseHash,
			);
		}
		expect(spliced.replace(RESTORED_BODY, "")).toBe(
			MAIN.replace(
				MAIN.slice(
					MAIN.indexOf("We start with discovery"),
					MAIN.indexOf("in Q3 2026.") + "in Q3 2026.".length,
				),
				"",
			),
		);
		// Nothing is written.
		expect(world.documents.get(DOC_A)?.content).toBe(MAIN);
	});

	it("keeps the diagram and the visual slot out of the model's hands", async () => {
		modelWrites(MODEL_BODY);

		await reviseSection();

		const { prompt } = revise.generateText.mock.calls[0][0];
		const target = prompt.slice(
			prompt.indexOf("<target_section>"),
			prompt.indexOf("</target_section>"),
		);
		expect(target).toContain(TOKEN_1);
		expect(target).toContain(TOKEN_2);
		expect(target).not.toContain("flowchart");
		expect(target).not.toContain("visual-slot");
	});

	it("signs the token with the response's id and version and the candidate section's fingerprint", async () => {
		addResponse("Discovery is two weeks.");
		modelWrites(MODEL_BODY);

		await reviseSection();

		const spliced = spliceSectionBody(
			MAIN,
			APPROACH.key,
			RESTORED_BODY,
		) as string;
		const candidateFingerprint = revisionSectionFingerprint(
			spliced,
			APPROACH.key,
		);
		expect(candidateFingerprint).toBeDefined();
		expect(candidateFingerprint).not.toBe(
			revisionSectionFingerprint(MAIN, APPROACH.key),
		);
		expect(revise.signRevisionToken).toHaveBeenCalledWith({
			userId: USERS.editor,
			documentId: DOC_A,
			runId: RUN_ID,
			findingId: FINDING_ID,
			baseVersion: 3,
			response: { id: "response-approach", version: 4 },
			sectionKey: APPROACH.key,
			sectionFingerprint: candidateFingerprint,
		});
	});

	it("signs a null response when the finding has no answer", async () => {
		modelWrites(MODEL_BODY);

		await reviseSection();

		expect(revise.signRevisionToken.mock.calls[0][0].response).toBeNull();
	});

	it("sends the recommendation as internal guidance with the bound prompt and the member's settled block", async () => {
		revise.buildSettledDecisionsBlock.mockResolvedValue({
			block: SETTLED_BLOCK,
			analysisBlock: "",
			carried: { responseTexts: [], findingTitles: [] },
			itemCount: 1,
		});
		modelWrites(MODEL_BODY);

		await reviseSection();

		expect(revise.buildSettledDecisionsBlock).toHaveBeenCalledWith({
			projectId: PROJECT_A,
			documentId: DOC_A,
			starterUserId: USERS.editor,
			organizationId: ORG_A,
		});
		expect(revise.findBoundProposalPrompt).toHaveBeenCalledWith({
			userId: USERS.editor,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			action: "proposal_client_revision",
		});
		expect(revise.promptVersionFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "prompt-version-revision" },
			}),
		);
		const { instructions, prompt } = revise.generateText.mock.calls[0][0];
		expect(
			instructions.startsWith(
				"Write for external readers. Keep headings.",
			),
		).toBe(true);
		expect(instructions.endsWith(SETTLED_BLOCK)).toBe(true);
		expect(prompt).toContain(`<internal_guidance>\n${RECOMMENDATION}`);
		expect(instructions).not.toContain(RECOMMENDATION);
		expect(revise.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			expect.objectContaining({
				organizationId: ORG_A,
				userId: USERS.editor,
				projectId: PROJECT_A,
			}),
		);
	});

	it("falls back to the finding's title when it has no recommendation", async () => {
		addFinding({ recommendation: null });
		modelWrites(MODEL_BODY);

		await reviseSection();

		expect(revise.generateText.mock.calls[0][0].prompt).toContain(
			`<internal_guidance>\n${TITLE}`,
		);
	});
});

describe("refused candidates", () => {
	it("answers INVALID_CANDIDATE when the model drops a placeholder twice", async () => {
		const dropped = MODEL_BODY.replace(`${TOKEN_1}\n\n`, "");
		modelWrites(dropped, dropped);

		expect(await reviseSection()).toEqual({ status: "INVALID_CANDIDATE" });
		expect(revise.signRevisionToken).not.toHaveBeenCalled();
	});

	it("answers INVALID_CANDIDATE when the model adds a subsection twice", async () => {
		const added = `${MODEL_BODY}\n\n### 4.1 Discovery\n\nTwo weeks.`;
		modelWrites(added, added);

		expect(await reviseSection()).toEqual({ status: "INVALID_CANDIDATE" });
	});

	it("answers INVALID_CANDIDATE when the splice would swallow the next section", async () => {
		// An unclosed fence runs to the end of the document.
		const unclosed = `${MODEL_BODY}\n\n\`\`\`text\nopen fence`;
		modelWrites(unclosed, unclosed);

		expect(await reviseSection()).toEqual({ status: "INVALID_CANDIDATE" });
		expect(revise.signRevisionToken).not.toHaveBeenCalled();
	});

	it("answers RESPONSE_ECHOED when the model repeats the finding's answer", async () => {
		const answer =
			"The client confirmed that discovery lasts exactly two weeks and ends with a signed written plan.";
		addResponse(answer);
		const echoing = MODEL_BODY.replace(
			"We start with a two-week discovery that ends in a written plan, and then build.",
			`${answer} Then we build.`,
		);
		modelWrites(echoing, echoing);

		expect(await reviseSection()).toEqual({ status: "RESPONSE_ECHOED" });
		expect(revise.signRevisionToken).not.toHaveBeenCalled();
	});

	it("answers RESPONSE_ECHOED when the model repeats a settled answer the block carried", async () => {
		const settled =
			"Every phase of the engagement is billed monthly against the agreed fixed fee schedule only.";
		revise.buildSettledDecisionsBlock.mockResolvedValue({
			block: SETTLED_BLOCK,
			analysisBlock: "",
			carried: { responseTexts: [settled], findingTitles: ["Billing"] },
			itemCount: 1,
		});
		const echoing = `${MODEL_BODY}\n\n${settled}`;
		modelWrites(echoing, echoing);

		expect(await reviseSection()).toEqual({ status: "RESPONSE_ECHOED" });
	});

	it("answers RESPONSE_ECHOED for a 12-word run of the recommendation", async () => {
		const recommendation =
			"Explain that the discovery phase lasts two weeks and closes with a written delivery plan for approval";
		addFinding({ recommendation });
		const echoing = MODEL_BODY.replace(
			"We start with a two-week discovery that ends in a written plan, and then build.",
			"We explain that the discovery phase lasts two weeks and closes with a written delivery plan for approval.",
		);
		modelWrites(echoing, echoing);

		expect(await reviseSection()).toEqual({ status: "RESPONSE_ECHOED" });
	});
});

describe("refusals before the model", () => {
	it("answers STALE when the stored version moved", async () => {
		revise.stored.version = 4;

		expect(await reviseSection()).toEqual({ status: "STALE" });
		expect(revise.generateText).not.toHaveBeenCalled();
		expect(revise.enforceAiRateLimit).not.toHaveBeenCalled();
	});

	it("answers STALE when the stored body is not the base the editor named", async () => {
		expect(
			await reviseSection({
				baseContentHash: contentIdentity(`${MAIN}\n`),
			}),
		).toEqual({ status: "STALE" });
	});

	it("answers FINDING_SECTION_CHANGED when the section changed since the finding", async () => {
		addFinding({ sectionHash: "p1:0000000000000000" });

		expect(await reviseSection()).toEqual({
			status: "FINDING_SECTION_CHANGED",
		});
		expect(revise.generateText).not.toHaveBeenCalled();
	});

	it("answers SECTION_NOT_FOUND for a document-level finding and a vanished section", async () => {
		addFinding({ sectionKey: DOCUMENT_SECTION_KEY });
		expect(await reviseSection()).toEqual({ status: "SECTION_NOT_FOUND" });

		addFinding({ sectionKey: null });
		expect(await reviseSection()).toEqual({ status: "SECTION_NOT_FOUND" });

		addFinding({ sectionKey: "p1:gone#0" });
		expect(await reviseSection()).toEqual({ status: "SECTION_NOT_FOUND" });
		expect(revise.generateText).not.toHaveBeenCalled();
	});

	it("answers SECTION_NOT_FOUND for a preamble finding: it has no heading to keep", async () => {
		const withPreamble = MAIN.replace(
			"# Example Proposal\n",
			"# Example Proposal\n\nPrepared for Example Org.\n",
		);
		const document = world.documents.get(DOC_A);
		if (document) {
			document.content = withPreamble;
		}
		const preamble = findSection(
			buildSectionMap(withPreamble),
			PREAMBLE_SECTION_KEY,
		);
		expect(preamble).toBeDefined();
		addFinding({
			sectionKey: PREAMBLE_SECTION_KEY,
			sectionHash: preamble?.proseHash,
		});

		expect(
			await reviseSection({
				baseContentHash: contentIdentity(withPreamble),
			}),
		).toEqual({ status: "SECTION_NOT_FOUND" });
		expect(revise.generateText).not.toHaveBeenCalled();
	});

	it("refuses a finding written before stable keys", async () => {
		addFinding({ stableKey: null });

		const refused = await refusal(reviseSection());

		expect(refused.code).toBe("PRECONDITION_FAILED");
		expect(refused.data).toEqual({ code: "FINDING_NOT_KEYED" });
	});

	it("answers PROPOSAL_PROMPT_NOT_BOUND with what to bind, and never falls back", async () => {
		revise.findBoundProposalPrompt.mockResolvedValue(null);

		const result = (await reviseSection()) as {
			status: string;
			message: string;
		};

		expect(result.status).toBe("PROPOSAL_PROMPT_NOT_BOUND");
		expect(result.message).toContain("cannot be revised");
		expect(revise.generateText).not.toHaveBeenCalled();
	});

	it("answers AI_PROVIDER_NOT_CONFIGURED", async () => {
		revise.getAIModelWithMetadata.mockRejectedValueOnce(
			new AIProviderNotConfiguredError("not configured"),
		);

		expect(await reviseSection()).toEqual({
			status: "AI_PROVIDER_NOT_CONFIGURED",
		});
	});

	it("answers RATE_LIMITED when the AI rate limit refuses", async () => {
		revise.enforceAiRateLimit.mockRejectedValueOnce(
			new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down" }),
		);

		expect(await reviseSection()).toEqual({ status: "RATE_LIMITED" });
		expect(revise.enforceAiRateLimit.mock.calls[0][0]).toBe(USERS.editor);
		expect(revise.generateText).not.toHaveBeenCalled();
	});

	it("refuses with CONFLICT while a generation run holds the document", async () => {
		for (const status of ["QUEUED", "GENERATING"]) {
			revise.stored.status = status;

			const refused = await refusal(reviseSection());

			expect(refused.code).toBe("CONFLICT");
			expect(refused.data).toEqual({
				code: "DOCUMENT_GENERATION_IN_PROGRESS",
			});
		}
		expect(revise.generateText).not.toHaveBeenCalled();
	});
});

describe("access", () => {
	it("answers NOT_FOUND when the rollout gate is off", async () => {
		world.flags.set(ORG_A, false);

		expect((await refusal(reviseSection())).code).toBe("NOT_FOUND");
	});

	it("refuses a project guest with edit rights: findings are internal", async () => {
		const refused = await refusal(reviseSection({}, USERS.guestEditor));

		expect(refused.code).toBe("FORBIDDEN");
		expect(refused.data).toEqual({
			code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
		});
		expect(revise.generateText).not.toHaveBeenCalled();
	});

	it("refuses a member without edit rights", async () => {
		expect(
			(await refusal(reviseSection({}, USERS.memberViewer))).code,
		).toBe("FORBIDDEN");
	});

	it("answers NOT_FOUND for another organization's project", async () => {
		expect(
			(
				await refusal(
					reviseSection(
						{ projectId: PROJECT_B, documentId: DOC_B },
						USERS.editor,
					),
				)
			).code,
		).toBe("NOT_FOUND");
	});

	it("answers NOT_FOUND for a run of another document", async () => {
		world.runs.set("run-other", {
			id: "run-other",
			documentId: "doc-other",
			organizationId: ORG_A,
			proseHash: null,
			sourceRunId: null,
			findings: [],
		});

		expect(
			(await refusal(reviseSection({ runId: "run-other" }))).code,
		).toBe("NOT_FOUND");
	});
});
