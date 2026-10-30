/**
 * The AI accept on a client-document Proposal's Main (Fizzy #2946):
 * `projects.documents.update` with an `aiReview` descriptor.
 *
 *  - CHAT: sections outside the patched ones and every existing diagram are
 *    kept, and no internal answer is echoed; without patched keys only the
 *    diagrams and the echo are checked;
 *  - FINDING: an internal write (DOCUMENT_UPDATE, edit access, membership);
 *    the revision token must be this server's for this user, document, run,
 *    finding and base, and the saved section the one it vouches for (its
 *    prose and its link and image destinations); the
 *    finding is recorded as Resolved, with its audit row, in the save's
 *    transaction, and a failure there rolls the body back;
 *  - refusals are PRECONDITION_FAILED with a code, and write nothing;
 *  - a saved accept the client did not describe gets a generic version
 *    description, which names no finding;
 *  - whether the descriptor applies, and every check, is judged by the
 *    project's owning organization, never the caller's;
 *  - a descriptor on any other document is ignored.
 *
 * The checks themselves (`checkPreservation`, `checkResponseEcho`, the
 * section map and the token) run for real; only storage is faked.
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { DOCUMENT_SAVE_BASE_REQUIRED } from "@repo/utils/document-save-base";
import { SCOPED_REVISION_REFUSAL } from "@repo/utils/proposal-artifact/scoped-revision-codes";
import {
	buildSectionMap,
	type SectionMap,
} from "@repo/utils/proposal-artifact/section-hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RevisionTokenPayload,
	revisionSectionFingerprint,
	signRevisionToken,
} from "../../lib/proposal-revision-token";

const mocks = vi.hoisted(() => {
	class FindingResponseChangedError extends Error {}
	class ProposalArtifactTenantError extends Error {}
	return {
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		hasProjectAccess: vi.fn(),
		updateDocument: vi.fn(),
		applySideEffects: vi.fn(),
		findUnique: vi.fn(),
		isProposalClientDocument: vi.fn(),
		isRoomConvergenceOn: vi.fn(),
		listVisualSpecs: vi.fn(),
		writeResolved: vi.fn(),
		recordAuditTx: vi.fn(),
		buildSettledDecisionsBlock: vi.fn(),
		listResponses: vi.fn(),
		assertProjectPermission: vi.fn(),
		loadProposalArtifactDocument: vi.fn(),
		loadProposalFinding: vi.fn(),
		loggerInfo: vi.fn(),
		FindingResponseChangedError,
		ProposalArtifactTenantError,
	};
});

vi.mock("@repo/database", () => ({
	DocumentVersionConflictError: class extends Error {},
	DocumentGenerationInProgressError: class extends Error {},
	IntegrationContractStatusManagedError: class extends Error {},
	FindingResponseChangedError: mocks.FindingResponseChangedError,
	ProposalArtifactTenantError: mocks.ProposalArtifactTenantError,
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	updateDocument: (...args: unknown[]) => mocks.updateDocument(...args),
	isProposalClientDocument: (...args: unknown[]) =>
		mocks.isProposalClientDocument(...args),
	listProposalVisualSpecSummaries: (...args: unknown[]) =>
		mocks.listVisualSpecs(...args),
	writeResolvedFindingResponse: (...args: unknown[]) =>
		mocks.writeResolved(...args),
	listResponsesForDocument: (...args: unknown[]) =>
		mocks.listResponses(...args),
	recordAuditTx: (...args: unknown[]) => mocks.recordAuditTx(...args),
	sanitizeContent: (content: string) => content.split("\u0000").join(""),
	completeDraftDocument: vi.fn(),
	buildDocumentLink: () => "projects/proj_1/documents/doc_1",
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) => mocks.findUnique(...args),
		},
	},
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentStatusSchema: { optional: () => ({}) },
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: (...args: unknown[]) => mocks.loggerInfo(...args),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock(
	"@repo/temporal/proposal-artifact-settled-decisions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@repo/temporal/proposal-artifact-settled-decisions")
		>()),
		buildSettledDecisionsBlock: (...args: unknown[]) =>
			mocks.buildSettledDecisionsBlock(...args),
	}),
);

vi.mock("../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: (...args: unknown[]) =>
		mocks.applySideEffects(...args),
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		documentMention: vi.fn().mockResolvedValue(undefined),
		subscriptionUpdate: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("../../../../lib/audit", () => ({
	auditRequestFields: () => ({
		impersonatedById: null,
		ipAddress: null,
		userAgent: null,
		requestId: "req-1",
		sessionId: "session-1",
		correlationId: null,
	}),
	resolveActor: (context: { user: { id: string } }) => ({
		type: "user",
		userId: context.user.id,
		emailSnapshot: null,
		nameSnapshot: null,
		impersonatedById: null,
	}),
}));

vi.mock("../../../weave/lib/run-in-background", () => ({
	runInBackground: vi.fn(),
}));

vi.mock("../../lib/cancel-stalled-generation-run", () => ({
	cancelStalledGenerationRun: vi.fn(),
}));

vi.mock("../../lib/room-convergence-enabled", () => ({
	isRoomConvergenceOn: (...args: unknown[]) =>
		mocks.isRoomConvergenceOn(...args),
}));

vi.mock("../../lib/proposal-artifact-access", () => ({
	loadProposalArtifactDocument: (...args: unknown[]) =>
		mocks.loadProposalArtifactDocument(...args),
	loadProposalFinding: (...args: unknown[]) =>
		mocks.loadProposalFinding(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.handlers.updateDocument = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requireProjectPermission: () => (c: unknown) => c,
		assertProjectPermission: (...args: unknown[]) =>
			mocks.assertProjectPermission(...args),
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { ORPCError } from "@orpc/client";
// Side-effect: register the handler.
import "../update-document";

const SECRET = "test-secret-at-least-thirty-two-characters-long";

const STORED = [
	"# Example proposal",
	"",
	"Prepared for Example Org.",
	"",
	"## Scope",
	"",
	"What the engagement covers.",
	"",
	"## Timeline",
	"",
	"```mermaid",
	"flowchart LR",
	"  Discovery --> Delivery",
	"```",
	"",
	"The plan runs in two phases.",
	"",
	"## Pricing",
	"",
	"The fee is agreed later.",
	"",
].join("\n");

/** `STORED` with one section's own prose line replaced. */
function withProse(from: string, to: string, body = STORED): string {
	if (!body.includes(from)) {
		throw new Error(`fixture has no "${from}"`);
	}
	return body.replace(from, to);
}

function keyOf(map: SectionMap, heading: string): string {
	const section = map.sections.find((s) => s.headingText === heading);
	if (!section) {
		throw new Error(`no section "${heading}"`);
	}
	return section.key;
}

function proseHashOf(body: string, heading: string): string {
	const map = buildSectionMap(body);
	const section = map.sections.find((s) => s.headingText === heading);
	if (!section) {
		throw new Error(`no section "${heading}"`);
	}
	return section.proseHash;
}

const STORED_MAP = buildSectionMap(STORED);
const SCOPE_KEY = keyOf(STORED_MAP, "Scope");
const PRICING_KEY = keyOf(STORED_MAP, "Pricing");

const LONG_ANSWER =
	"the client asked us to keep the discovery workshop short and fully remote this quarter";

const ctx = {
	user: { id: "user_member", email: "dev@example.com", name: "Dev" },
	session: { id: "session-1", activeOrganizationId: "org_1" },
};

const BASE = {
	expectedVersion: 3,
	expectedContentHash: contentIdentity(STORED),
};

/** What `updateDocument` committed, or null when nothing was. */
let committed: { content: string } | null;

function call(input: Record<string, unknown>, context = ctx) {
	return mocks.handlers.updateDocument({
		input: {
			projectId: "proj_1",
			id: "doc_1",
			organizationId: "org_1",
			...input,
		},
		context,
	}) as Promise<{ document: { content: string } }>;
}

async function refusal(
	promise: Promise<unknown>,
): Promise<ORPCError<string, { code?: string }>> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError) {
			return error as ORPCError<string, { code?: string }>;
		}
		throw error;
	}
	throw new Error("expected the save to be refused");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
	committed = null;
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.applySideEffects.mockResolvedValue(undefined);
	mocks.isProposalClientDocument.mockResolvedValue(true);
	mocks.isRoomConvergenceOn.mockResolvedValue(false);
	mocks.listVisualSpecs.mockResolvedValue([]);
	mocks.buildSettledDecisionsBlock.mockResolvedValue(null);
	mocks.listResponses.mockResolvedValue([]);
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "proj_1",
		organizationId: "org_1",
	});
	mocks.loadProposalArtifactDocument.mockResolvedValue({
		document: { id: "doc_1", type: "PROPOSAL", content: STORED },
		organizationId: "org_1",
	});
	mocks.loadProposalFinding.mockResolvedValue({
		run: { id: "run_1", proseHash: "p1:doc", sourceRunId: null },
		finding: {
			id: "finding_1",
			title: "Pricing is vague",
			recommendation: "State the fee and what it covers.",
			stableKey: "commercial|pricing|fee",
			sectionKey: PRICING_KEY,
			sectionHash: proseHashOf(STORED, "Pricing"),
		},
	});
	mocks.writeResolved.mockImplementation(async () => ({
		stableKey: "commercial|pricing|fee",
		version: 1,
	}));
	mocks.recordAuditTx.mockResolvedValue(undefined);
	mocks.findUnique.mockResolvedValue({
		projectId: "proj_1",
		content: STORED,
		title: "Example proposal",
		status: "COMPLETE",
		type: "PROPOSAL",
		version: 3,
		generationStartedAt: null,
		updatedAt: new Date("2026-10-27T09:00:00Z"),
		workflowId: null,
		project: { organizationId: "org_1" },
	});
	// The guarded write: the callback runs on the saved row inside the
	// transaction, and the body commits only when it returns.
	mocks.updateDocument.mockImplementation(
		async (
			_id: string,
			data: {
				content?: string;
				inTransaction?: (tx: unknown, saved: unknown) => Promise<void>;
			},
		) => {
			const saved = {
				id: "doc_1",
				title: "Example proposal",
				status: "COMPLETE",
				type: "PROPOSAL",
				content: data.content ?? STORED,
				version: 4,
			};
			if (data.inTransaction) {
				await data.inTransaction({ tx: true }, saved);
			}
			committed = { content: saved.content };
			return saved;
		},
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("CHAT accept", () => {
	it("refuses a change to a section outside the patched ones, and writes nothing", async () => {
		const next = withProse(
			"The fee is agreed later.",
			"The fee is fixed and paid monthly.",
			withProse(
				"What the engagement covers.",
				"What the engagement covers, in detail.",
			),
		);

		const error = await refusal(
			call({
				content: next,
				...BASE,
				aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
			}),
		);

		expect(error.code).toBe("PRECONDITION_FAILED");
		expect(error.data).toMatchObject({
			code: SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET,
			violations: [expect.objectContaining({ sectionKey: PRICING_KEY })],
		});
		expect(JSON.stringify(error.data)).not.toContain("monthly");
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		// No diagram changed, so the stored specs that classify one are not read.
		expect(mocks.listVisualSpecs).not.toHaveBeenCalled();
	});

	it("saves a change within the patched sections, with no transaction work", async () => {
		const next = withProse(
			"What the engagement covers.",
			"What the engagement covers, in detail.",
		);

		await call({
			content: next,
			...BASE,
			aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
		});

		expect(mocks.updateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				content: next,
				expectedVersion: 3,
				expectedContentHash: BASE.expectedContentHash,
			}),
		);
		expect(mocks.updateDocument.mock.calls[0][1]).not.toHaveProperty(
			"inTransaction",
		);
		expect(committed?.content).toBe(next);
	});

	it("describes the version as an assistant edit unless the client described it", async () => {
		const next = withProse(
			"What the engagement covers.",
			"What the engagement covers, in detail.",
		);
		const accept = {
			content: next,
			...BASE,
			aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
		};

		await call(accept);
		await call({ ...accept, changeDescription: "   " });
		await call({ ...accept, changeDescription: "Tightened the scope" });

		expect(
			mocks.updateDocument.mock.calls.map(
				([, data]) =>
					(data as { changeDescription?: string }).changeDescription,
			),
		).toEqual(["Assistant edit", "Assistant edit", "Tightened the scope"]);
	});

	it("refuses a change to a diagram in a kept section", async () => {
		const next = withProse(
			"  Discovery --> Delivery",
			"  Discovery --> Build --> Delivery",
		);

		const error = await refusal(
			call({
				content: next,
				...BASE,
				aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
			}),
		);

		expect(error.data?.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
		expect(error.data?.violations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
					classification: expect.objectContaining({
						state: expect.any(String),
					}),
				}),
			]),
		);
		expect(mocks.listVisualSpecs).toHaveBeenCalledTimes(1);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("without patched keys, saves a prose change anywhere and logs that sections were not checked", async () => {
		const next = withProse(
			"The fee is agreed later.",
			"The fee is fixed and paid monthly.",
		);

		await call({ content: next, ...BASE, aiReview: { kind: "CHAT" } });

		expect(committed?.content).toBe(next);
		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({ documentId: "doc_1", kind: "CHAT" }),
			expect.stringContaining("without patched section keys"),
		);
	});

	it("without patched keys, still refuses a changed diagram", async () => {
		const next = withProse(
			"  Discovery --> Delivery",
			"  Discovery --> Build --> Delivery",
		);

		const error = await refusal(
			call({ content: next, ...BASE, aiReview: { kind: "CHAT" } }),
		);

		expect(error.data?.code).toBe(SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM);
	});

	it("refuses a Main that echoes a long internal answer, naming no text", async () => {
		mocks.buildSettledDecisionsBlock.mockResolvedValue({
			block: "",
			analysisBlock: "",
			itemCount: 1,
			carried: {
				responseTexts: [LONG_ANSWER],
				findingTitles: ["Workshop format is unclear"],
				responseKeys: ["delivery|scope|workshop"],
				titleKeys: ["delivery|scope|workshop"],
			},
		});
		const next = withProse(
			"What the engagement covers.",
			`What the engagement covers: ${LONG_ANSWER}.`,
		);

		const error = await refusal(
			call({
				content: next,
				...BASE,
				aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
			}),
		);

		expect(error.data).toEqual({
			code: SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED,
		});
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith({
			projectId: "proj_1",
			documentId: "doc_1",
			starterUserId: "user_member",
			organizationId: "org_1",
		});
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("saves wording of an answer that previous Main already held, and a short factual answer", async () => {
		const stored = withProse(
			"What the engagement covers.",
			`What the engagement covers: ${LONG_ANSWER}.`,
		);
		mocks.findUnique.mockResolvedValue({
			...(await mocks.findUnique()),
			content: stored,
		});
		mocks.buildSettledDecisionsBlock.mockResolvedValue({
			block: "",
			analysisBlock: "",
			itemCount: 2,
			carried: {
				responseTexts: [LONG_ANSWER, "Twelve weeks."],
				findingTitles: [],
			},
		});
		const next = withProse(
			"The fee is agreed later.",
			"The fee is agreed later. Twelve weeks.",
			stored,
		);

		await call({
			content: next,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(stored),
			aiReview: { kind: "CHAT" },
		});

		expect(committed?.content).toBe(next);
	});

	it("for a guest, with no block, still runs the structure check", async () => {
		mocks.buildSettledDecisionsBlock.mockResolvedValue(null);
		const next = withProse("The fee is agreed later.", "The fee is fixed.");

		const error = await refusal(
			call({
				content: next,
				...BASE,
				aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
			}),
		);

		expect(error.data?.code).toBe(SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET);
	});
});

describe("FINDING accept", () => {
	const CANDIDATE = withProse(
		"The fee is agreed later.",
		"The fee is fixed at the amount in the commercial annex.",
	);

	function token(overrides: Partial<RevisionTokenPayload> = {}): string {
		return signRevisionToken({
			userId: "user_member",
			documentId: "doc_1",
			runId: "run_1",
			findingId: "finding_1",
			baseVersion: 3,
			response: null,
			sectionKey: PRICING_KEY,
			sectionFingerprint: fingerprintOf(CANDIDATE),
			...overrides,
		});
	}

	function fingerprintOf(body: string): string {
		const fingerprint = revisionSectionFingerprint(body, PRICING_KEY);
		if (!fingerprint) {
			throw new Error("no Pricing section");
		}
		return fingerprint;
	}

	function finding(revisionToken = token()) {
		return {
			kind: "FINDING" as const,
			runId: "run_1",
			findingId: "finding_1",
			revisionToken,
		};
	}

	it("saves and records Resolved with the saved section's hash and the run, auditing no text", async () => {
		await call({ content: CANDIDATE, ...BASE, aiReview: finding() });

		expect(committed?.content).toBe(CANDIDATE);
		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"proj_1",
			"user_member",
			"DOCUMENT_UPDATE",
		);
		expect(mocks.loadProposalArtifactDocument).toHaveBeenCalledWith(
			expect.objectContaining({ write: true, userId: "user_member" }),
		);
		expect(mocks.loadProposalFinding).toHaveBeenCalledWith({
			organizationId: "org_1",
			documentId: "doc_1",
			runId: "run_1",
			findingId: "finding_1",
		});
		expect(mocks.writeResolved).toHaveBeenCalledWith(
			{ tx: true },
			{
				organizationId: "org_1",
				projectId: "proj_1",
				documentId: "doc_1",
				stableKey: "commercial|pricing|fee",
				findingTitle: "Pricing is vague",
				answeredRunId: "run_1",
				sectionKey: PRICING_KEY,
				sectionHash: proseHashOf(CANDIDATE, "Pricing"),
				authorId: "user_member",
				expected: null,
			},
		);
		expect(mocks.recordAuditTx).toHaveBeenCalledWith(
			{ tx: true },
			expect.objectContaining({
				action: "project.document_analysis.resolved",
				organizationId: "org_1",
				projectId: "proj_1",
				resource: { type: "project_document", id: "doc_1", name: null },
				metadata: {
					stableKey: "commercial|pricing|fee",
					runId: "run_1",
					version: 1,
				},
			}),
		);
		const audited = JSON.stringify(mocks.recordAuditTx.mock.calls[0][1]);
		expect(audited).not.toContain("Pricing is vague");
		expect(audited).not.toContain("commercial annex");
	});

	it("describes the version generically, naming neither the finding nor its recommendation", async () => {
		await call({ content: CANDIDATE, ...BASE, aiReview: finding() });

		// Version history is shown to project guests.
		const { changeDescription } = mocks.updateDocument.mock.calls[0][1] as {
			changeDescription?: string;
		};
		expect(changeDescription).toBe("Applied a review recommendation");
		expect(changeDescription).not.toContain("Pricing");
		expect(changeDescription).not.toContain("fee");
	});

	it("passes the answer the revision started from as the compare-and-swap", async () => {
		await call({
			content: CANDIDATE,
			...BASE,
			aiReview: finding(
				token({ response: { id: "response_1", version: 2 } }),
			),
		});

		expect(mocks.writeResolved.mock.calls[0][1]).toMatchObject({
			expected: { id: "response_1", version: 2 },
		});
	});

	it("rolls the body back when the Resolved write fails", async () => {
		const failure = new Error("write failed");
		mocks.writeResolved.mockRejectedValue(failure);

		await expect(
			call({ content: CANDIDATE, ...BASE, aiReview: finding() }),
		).rejects.toBe(failure);

		expect(committed).toBeNull();
		expect(mocks.recordAuditTx).not.toHaveBeenCalled();
		expect(mocks.applySideEffects).not.toHaveBeenCalled();
	});

	it("answers FINDING_RESPONSE_CHANGED when the answer changed since the revision started", async () => {
		mocks.writeResolved.mockRejectedValue(
			new mocks.FindingResponseChangedError("changed"),
		);

		const error = await refusal(
			call({ content: CANDIDATE, ...BASE, aiReview: finding() }),
		);

		expect(error.code).toBe("PRECONDITION_FAILED");
		expect(error.data?.code).toBe(
			SCOPED_REVISION_REFUSAL.FINDING_RESPONSE_CHANGED,
		);
		expect(committed).toBeNull();
	});

	it("answers FINDING_SECTION_CHANGED when the finding's section changed since the analysis", async () => {
		mocks.loadProposalFinding.mockResolvedValue({
			...(await mocks.loadProposalFinding()),
			finding: {
				...(await mocks.loadProposalFinding()).finding,
				sectionHash: "p1:an-older-pricing",
			},
		});

		const error = await refusal(
			call({ content: CANDIDATE, ...BASE, aiReview: finding() }),
		);

		expect(error.data?.code).toBe(
			SCOPED_REVISION_REFUSAL.FINDING_SECTION_CHANGED,
		);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it.each([
		["a forged token", () => `${token().split(".")[0]}.forged`],
		["another user's token", () => token({ userId: "user_other" })],
		["another document's token", () => token({ documentId: "doc_2" })],
		["another run's token", () => token({ runId: "run_2" })],
		["another finding's token", () => token({ findingId: "finding_2" })],
		["a token for another base", () => token({ baseVersion: 2 })],
		["a token for another section", () => token({ sectionKey: SCOPE_KEY })],
		[
			"a token for another candidate",
			() => token({ sectionFingerprint: "hand-edited" }),
		],
	])(
		"refuses %s with REVISION_TOKEN_INVALID and writes nothing",
		async (_label, make) => {
			const error = await refusal(
				call({
					content: CANDIDATE,
					...BASE,
					aiReview: finding(make()),
				}),
			);

			expect(error.data?.code).toBe(
				SCOPED_REVISION_REFUSAL.REVISION_TOKEN_INVALID,
			);
			expect(mocks.updateDocument).not.toHaveBeenCalled();
			expect(mocks.writeResolved).not.toHaveBeenCalled();
		},
	);

	it("refuses a hand edit of the candidate: the saved section is not the signed one", async () => {
		const edited = withProse(
			"The fee is agreed later.",
			"The fee is fixed at the amount in the annex, edited by hand.",
		);

		const error = await refusal(
			call({ content: edited, ...BASE, aiReview: finding() }),
		);

		expect(error.data?.code).toBe(
			SCOPED_REVISION_REFUSAL.REVISION_TOKEN_INVALID,
		);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	describe("a link or image destination in the target section", () => {
		const LINKED = withProse(
			"The fee is agreed later.",
			"The fee is agreed later. See [the rate card](https://example.com/tarifs-é) and ![the chart](https://example.com/chart.png).",
		);
		const LINKED_CANDIDATE = withProse(
			"The fee is agreed later.",
			"The fee is fixed.",
			LINKED,
		);

		beforeEach(async () => {
			mocks.findUnique.mockResolvedValue({
				...(await mocks.findUnique()),
				content: LINKED,
			});
			mocks.loadProposalFinding.mockResolvedValue({
				...(await mocks.loadProposalFinding()),
				finding: {
					...(await mocks.loadProposalFinding()).finding,
					sectionHash: proseHashOf(LINKED, "Pricing"),
				},
			});
		});

		function save(content: string) {
			return call({
				content,
				expectedVersion: 3,
				expectedContentHash: contentIdentity(LINKED),
				aiReview: finding(
					token({
						sectionFingerprint: fingerprintOf(LINKED_CANDIDATE),
					}),
				),
			});
		}

		it.each([
			[
				"a link",
				"https://example.com/tarifs-é",
				"https://example.org/elsewhere",
			],
			[
				"an image",
				"https://example.com/chart.png",
				"https://example.org/other.png",
			],
		])(
			"refuses a candidate whose only change is %s destination, and records nothing",
			async (_label, from, to) => {
				const redirected = LINKED_CANDIDATE.replace(from, to);
				// The prose hash alone cannot tell them apart.
				expect(proseHashOf(redirected, "Pricing")).toBe(
					proseHashOf(LINKED_CANDIDATE, "Pricing"),
				);

				const error = await refusal(save(redirected));

				expect(error.data?.code).toBe(
					SCOPED_REVISION_REFUSAL.REVISION_TOKEN_INVALID,
				);
				expect(mocks.updateDocument).not.toHaveBeenCalled();
				expect(mocks.writeResolved).not.toHaveBeenCalled();
			},
		);

		it("saves the candidate as the editor serialises it, its destination percent-encoded", async () => {
			const encoded = LINKED_CANDIDATE.replace(
				"https://example.com/tarifs-é",
				"https://example.com/tarifs-%C3%A9",
			);
			expect(encoded).not.toBe(LINKED_CANDIDATE);

			await save(encoded);

			expect(committed?.content).toBe(encoded);
			expect(mocks.writeResolved.mock.calls[0][1]).toMatchObject({
				sectionHash: proseHashOf(LINKED_CANDIDATE, "Pricing"),
			});
		});
	});

	it("refuses a candidate that quotes the finding's own answer, though no settled block carries it", async () => {
		const answer =
			"The client agreed that the fee is invoiced in two equal parts at the start and end of delivery";
		mocks.listResponses.mockResolvedValue([
			{
				id: "response_1",
				version: 2,
				stableKey: "commercial|pricing|fee",
				kind: "RESPONDED",
				text: answer,
			},
			{
				id: "response_other",
				version: 1,
				stableKey: "delivery|scope|workshop",
				kind: "RESPONDED",
				text: "Unrelated.",
			},
		]);
		const quoting = withProse("The fee is agreed later.", `${answer}.`);

		const error = await refusal(
			call({
				content: quoting,
				...BASE,
				aiReview: finding(
					token({
						response: { id: "response_1", version: 2 },
						sectionFingerprint: fingerprintOf(quoting),
					}),
				),
			}),
		);

		expect(error.data).toEqual({
			code: SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED,
		});
		expect(mocks.listResponses).toHaveBeenCalledWith({
			organizationId: "org_1",
			documentId: "doc_1",
		});
		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalled();
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("refuses a revision that also changed another section", async () => {
		const both = withProse(
			"What the engagement covers.",
			"What the engagement covers, widened.",
			CANDIDATE,
		);

		const error = await refusal(
			call({ content: both, ...BASE, aiReview: finding() }),
		);

		expect(error.data?.code).toBe(SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("refuses a candidate that quotes the finding's recommendation", async () => {
		const recommendation =
			"State the fixed fee, the payment schedule and exactly what the fee covers for the client";
		mocks.loadProposalFinding.mockResolvedValue({
			...(await mocks.loadProposalFinding()),
			finding: {
				...(await mocks.loadProposalFinding()).finding,
				recommendation,
			},
		});
		const quoting = withProse(
			"The fee is agreed later.",
			`${recommendation}.`,
		);

		const error = await refusal(
			call({
				content: quoting,
				...BASE,
				aiReview: finding(
					token({ sectionFingerprint: fingerprintOf(quoting) }),
				),
			}),
		);

		expect(error.data?.code).toBe(SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED);
	});

	it("is FORBIDDEN for a project guest with edit rights", async () => {
		mocks.loadProposalArtifactDocument.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Only members",
				data: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" },
			}),
		);

		const error = await refusal(
			call({ content: CANDIDATE, ...BASE, aiReview: finding() }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("is FORBIDDEN for a member without DOCUMENT_UPDATE", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: DOCUMENT_UPDATE",
			}),
		);

		const error = await refusal(
			call({ content: CANDIDATE, ...BASE, aiReview: finding() }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.loadProposalArtifactDocument).not.toHaveBeenCalled();
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});
});

describe("judged by the project's owning organization, not the caller's", () => {
	// A guest with edit rights: their session and the request name their own
	// organization, while the project belongs to org_1.
	const guestCtx = {
		...ctx,
		session: { id: "session-1", activeOrganizationId: "org_guest" },
	};

	function guestCall(input: Record<string, unknown>) {
		return call({ organizationId: "org_guest", ...input }, guestCtx);
	}

	const OUTSIDE_PATCHED = withProse(
		"The fee is agreed later.",
		"The fee is fixed and paid monthly.",
		withProse(
			"What the engagement covers.",
			"What the engagement covers, in detail.",
		),
	);

	it("checks a CHAT accept when the gate is on for the owning organization only", async () => {
		mocks.isProposalClientDocument.mockImplementation(
			async ({ organizationId }: { organizationId: string }) =>
				organizationId === "org_1",
		);

		const error = await refusal(
			guestCall({
				content: OUTSIDE_PATCHED,
				...BASE,
				aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
			}),
		);

		expect(error.data?.code).toBe(SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET);
		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: "org_1",
			documentType: "PROPOSAL",
		});
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_guest" }),
		);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("reads the owning organization's block and diagram specs", async () => {
		mocks.isProposalClientDocument.mockImplementation(
			async ({ organizationId }: { organizationId: string }) =>
				organizationId === "org_1",
		);

		await guestCall({
			content: withProse(
				"What the engagement covers.",
				"What the engagement covers, in detail.",
			),
			...BASE,
			aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
		});
		const diagram = await refusal(
			guestCall({
				content: withProse(
					"  Discovery --> Delivery",
					"  Discovery --> Build --> Delivery",
				),
				...BASE,
				aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
			}),
		);

		expect(mocks.buildSettledDecisionsBlock).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
		expect(diagram.data?.code).toBe(
			SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		expect(mocks.listVisualSpecs).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
	});

	it("ignores the descriptor when the gate is on for the caller's organization only", async () => {
		mocks.isProposalClientDocument.mockImplementation(
			async ({ organizationId }: { organizationId: string }) =>
				organizationId === "org_guest",
		);

		await guestCall({
			content: OUTSIDE_PATCHED,
			...BASE,
			aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
		});

		expect(committed?.content).toBe(OUTSIDE_PATCHED);
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_guest" }),
		);
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
	});
});

describe("where the descriptor applies", () => {
	it("is ignored on a document that is not a client-document Proposal", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(false);
		const next = withProse(
			"  Discovery --> Delivery",
			"  Discovery --> Build --> Delivery",
		);

		await call({
			content: next,
			...BASE,
			aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
		});

		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: "org_1",
			documentType: "PROPOSAL",
		});
		expect(committed?.content).toBe(next);
		expect(mocks.listVisualSpecs).not.toHaveBeenCalled();
		expect(mocks.buildSettledDecisionsBlock).not.toHaveBeenCalled();
		expect(mocks.updateDocument.mock.calls[0][1]).not.toHaveProperty(
			"inTransaction",
		);
		// An ignored descriptor is a plain save: no description is added.
		expect(
			(
				mocks.updateDocument.mock.calls[0][1] as {
					changeDescription?: string;
				}
			).changeDescription,
		).toBeUndefined();
	});

	it("is ignored for a FINDING on another document, with no internal check run", async () => {
		mocks.isProposalClientDocument.mockResolvedValue(false);

		await call({
			content: STORED,
			...BASE,
			aiReview: {
				kind: "FINDING",
				runId: "run_1",
				findingId: "finding_1",
				revisionToken: "not-a-token",
			},
		});

		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
		expect(mocks.writeResolved).not.toHaveBeenCalled();
		expect(committed?.content).toBe(STORED);
	});

	it("needs the base on a client-document Proposal", async () => {
		const error = await refusal(
			call({ content: STORED, aiReview: { kind: "CHAT" } }),
		);

		expect(error.code).toBe("PRECONDITION_FAILED");
		expect(error.data?.code).toBe(DOCUMENT_SAVE_BASE_REQUIRED);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("answers CONFLICT, not a scope refusal, when the stored body moved past the base", async () => {
		const error = await refusal(
			call({
				content: STORED,
				expectedVersion: 2,
				expectedContentHash: BASE.expectedContentHash,
				aiReview: { kind: "CHAT" },
			}),
		);

		expect(error.code).toBe("CONFLICT");
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("is refused with a status or a version rewind", async () => {
		const error = await refusal(
			call({
				content: STORED,
				...BASE,
				skipVersionBump: true,
				aiReview: { kind: "CHAT" },
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("saves the body as stored would keep it: a dropped visual slot comes back", async () => {
		const slotted = `${STORED}\n<visual-slot id="slot-a" kind="timeline"></visual-slot>\n`;
		mocks.findUnique.mockResolvedValue({
			...(await mocks.findUnique()),
			content: slotted,
		});
		const next = withProse(
			"What the engagement covers.",
			"What the engagement covers, in detail.",
		);

		await call({
			content: next,
			expectedVersion: 3,
			expectedContentHash: contentIdentity(slotted),
			aiReview: { kind: "CHAT", patchedSectionKeys: [SCOPE_KEY] },
		});

		expect(committed?.content).toContain('id="slot-a"');
		expect(committed?.content).toContain("in detail.");
	});
});
