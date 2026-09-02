/**
 * One document's refresh cycle.
 *
 * The engine underneath is the same one behind the editor's "Update using
 * context" button — and that button is a PROPOSAL: a human reads the diff before
 * anything is saved. Every safety property it has is "a person looks at the
 * diff". This activity deletes the person, so the suite is organized around what
 * replaced them:
 *
 *   - it PROPOSES by default, and only writes when `autoApply` was opted into;
 *   - a quiet fortnight leaves no version behind (the no-op gate);
 *   - the model's own ambiguity flag, and a rewrite that would delete most of the
 *     document, are REFUSED rather than applied;
 *   - a human who saved during generation wins (compare-and-set);
 *   - the kill switch is re-read immediately before the write;
 *   - a retrieval OUTAGE fails loudly instead of being recorded as "nothing
 *     changed" — which would advance the cadence clock and silence the document
 *     for a fortnight;
 *   - a committed version is attributed to the agent, not to a person.
 *
 * Both tenant contexts are exercised: a refresh resolves an AI provider and logs
 * usage against the actor, so getting the tenant wrong bills the wrong party.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: the activity imports the real ApplicationFailure for the
// non-retryable truncation throw, so only heartbeat is stubbed.
vi.mock("@temporalio/activity", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/activity")>();
	return { ...actual, heartbeat: vi.fn() };
});

const {
	getDocumentMock,
	updateDocumentMock,
	markAttemptMock,
	completeCycleMock,
	recordOutcomeMock,
	storeProposalMock,
	getSettingsMock,
	notifyMock,
	fetchSourcesMock,
	runContextUpdateMock,
	sideEffectsMock,
	flagMock,
} = vi.hoisted(() => ({
	getDocumentMock: vi.fn(),
	updateDocumentMock: vi.fn(),
	markAttemptMock: vi.fn(),
	completeCycleMock: vi.fn(),
	recordOutcomeMock: vi.fn(),
	storeProposalMock: vi.fn(),
	getSettingsMock: vi.fn(),
	notifyMock: vi.fn(),
	fetchSourcesMock: vi.fn(),
	runContextUpdateMock: vi.fn(),
	sideEffectsMock: vi.fn(),
	flagMock: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		getDocumentById: getDocumentMock,
		updateDocument: updateDocumentMock,
		markRefreshAttempt: markAttemptMock,
		completeRefreshCycle: completeCycleMock,
		recordRefreshOutcome: recordOutcomeMock,
		storeRefreshProposal: storeProposalMock,
		getAutoRefreshSettings: getSettingsMock,
		createDocumentRefreshNotifications: notifyMock,
		isFeatureEnabled: flagMock,
		// The sweep gate reads fail-closed through this one. Same resolver
		// here, so a suite that stubs the flag on still exercises the sweep;
		// the degraded-read case is covered separately.
		isKillSwitchArmed: flagMock,
	};
});

vi.mock("../../../lib/update-with-context-core", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../lib/update-with-context-core")
		>();
	return {
		// Real ContextUpdateTruncatedError so the activity's instanceof check
		// matches what the (mocked) runContextUpdate rejects with.
		ContextUpdateTruncatedError: actual.ContextUpdateTruncatedError,
		fetchProjectContextSources: fetchSourcesMock,
		runContextUpdate: runContextUpdateMock,
	};
});

// The re-embed dispatch reaches for a real Temporal client otherwise.
vi.mock("../lib/side-effects", () => ({
	applyDocumentRefreshSideEffects: sideEffectsMock,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DocumentVersionConflictError } from "@repo/database";
import { AI_REFRESH_AUTHOR_ID } from "@repo/utils/document-version-author";
import {
	type FeatureFlagKey,
	resolveFlag,
} from "@repo/utils/feature-flag-registry";
import { runDocumentRefreshActivity } from "../run-document-refresh";

const DUE = {
	documentId: "doc_1",
	projectId: "proj_1",
	documentTitle: "PRD",
	organizationId: null,
	userId: "user_1",
	triggeredByUserId: "user_1",
	workflowId: "document-refresh-doc_1-1342",
};

/** The same document in an organization tenant. */
const DUE_IN_ORG = {
	...DUE,
	organizationId: "org_1",
	// An org-context row has no personal userId — the actor is the enroller.
	userId: null,
};

const DOCUMENT = {
	id: "doc_1",
	title: "PRD",
	content: "# PRD\n\nOriginal body.",
	version: 3,
	createdAt: new Date("2026-06-01T00:00:00Z"),
	status: "COMPLETE",
};

/** A document long enough for the shrink guard's ratio to be meaningful. */
const LONG_CONTENT = `# PRD\n\n${"The rollout plan is documented in detail here. ".repeat(
	14,
)}`;

const UPDATE = {
	hasRelevantContext: true,
	updatedDocument: "# PRD\n\nSSO is out of scope.",
	needsHumanResolution: false,
	summary: "Removed SSO from scope per the July 9 standup.",
};

/** Retrieval succeeded and returned one source. */
const SOURCES = {
	contextItems: [{ sourceLabel: "Standup", content: "We cut SSO." }],
	transcriptCount: 1,
	teamsCount: 0,
	slackCount: 0,
	huddleNotesCount: 0,
	retrievalFailed: false,
};

/** Enrolled, and opted in to unattended writes. */
const autoApplyOn = () => {
	getSettingsMock.mockResolvedValue({
		documentId: "doc_1",
		enabled: true,
		autoApply: true,
	});
};

/**
 * The two lower-precedence inputs the registry resolves the flag from. An
 * `undefined` override means "no admin row"; an explicit `false` is an admin
 * turning it off, and beats a truthy env var.
 */
let flagOverride: boolean | undefined;
let flagEnvValue: string | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	flagOverride = undefined;
	// On by env var, no override row — the posture every non-kill-switch test
	// here assumes. `packages/temporal/vitest.config.ts` sets no flag env, so
	// it is supplied here rather than read from the process.
	flagEnvValue = "true";
	// The gate is the registry's `LIVING_DOCS_REFRESH`, read via
	// `isFeatureEnabled` from `@repo/database` (Fizzy #2210). Mocking the
	// retired `@repo/utils/feature-flag` helper here would intercept nothing
	// and leave the kill-switch tests below asserting nothing while passing.
	// The real `resolveFlag` runs, so precedence is the shipped one.
	flagMock.mockImplementation(
		async (key: FeatureFlagKey) =>
			resolveFlag(key, { global: flagOverride }, {
				// Both gates. The sweep requires the rollout as well as its own
				// kill switch, so an environment that only arms the brakes must
				// NOT be able to run it — that combination would rewrite enrolled
				// documents while their owners could not see the control.
				FABRIC_FEATURE_LIVING_DOCS_REFRESH: flagEnvValue,
				FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT: flagEnvValue,
			} as NodeJS.ProcessEnv).enabled,
	);
	getDocumentMock.mockResolvedValue(DOCUMENT);
	fetchSourcesMock.mockResolvedValue(SOURCES);
	markAttemptMock.mockResolvedValue(undefined);
	completeCycleMock.mockResolvedValue(undefined);
	recordOutcomeMock.mockResolvedValue(undefined);
	storeProposalMock.mockResolvedValue(undefined);
	notifyMock.mockResolvedValue(undefined);
	sideEffectsMock.mockResolvedValue(undefined);
	updateDocumentMock.mockResolvedValue({ ...DOCUMENT, version: 4 });
	// The DEFAULT posture: enrolled, but proposing rather than writing.
	getSettingsMock.mockResolvedValue({
		documentId: "doc_1",
		enabled: true,
		autoApply: false,
	});
	runContextUpdateMock.mockResolvedValue(UPDATE);
});

describe("proposal mode (the default)", () => {
	it("stores the candidate and does NOT touch the document", async () => {
		// The contract the interactive button has always had: the model's output is
		// a proposal until a human accepts it. Enrolling a document in auto-refresh
		// does not, on its own, hand the AI write access to it.
		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({
			status: "PROPOSED",
			summary: UPDATE.summary,
		});
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).toHaveBeenCalledWith("doc_1", {
			when: expect.any(Date),
			content: UPDATE.updatedDocument,
			summary: UPDATE.summary,
			// The version the candidate was generated FROM — what lets the accepting
			// human be told the document has moved on under it.
			baselineVersion: 3,
		});
	});

	it("tells the document's watchers it is a proposal, not an edit", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc_1",
				kind: "proposed",
				summary: UPDATE.summary,
			}),
		);
	});

	it("does not re-embed — nothing was written to embed", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(sideEffectsMock).not.toHaveBeenCalled();
	});

	it("commits instead when the owner opted in to auto-apply", async () => {
		autoApplyOn();

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({
			status: "COMMITTED",
			summary: UPDATE.summary,
		});
		expect(updateDocumentMock).toHaveBeenCalledTimes(1);
		expect(storeProposalMock).not.toHaveBeenCalled();
	});
});

describe("kill switch", () => {
	it("abandons without writing when the feature flag went off mid-generation", async () => {
		// The sweep decided to run this document up to an hour ago and the model call
		// takes minutes. Without a re-read, flipping the flag off would still let
		// every in-flight refresh land.
		autoApplyOn();
		flagEnvValue = "false";

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({ status: "SKIPPED_DISABLED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).not.toHaveBeenCalled();
		expect(completeCycleMock).not.toHaveBeenCalled();
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it("abandons an in-flight refresh when an ADMIN OVERRIDE lands between the sweep and the write", async () => {
		// The scenario the registry exists for, and the one the env var could
		// never serve: the flag was on when this document was picked up and the
		// admin turns it off — with no redeploy — while the model is still
		// generating. The env var stays "true" throughout, so this can only pass
		// if the pre-write re-read goes through the override row.
		//
		// The flip happens INSIDE the generation call, which is where the real
		// window is: the sweep is up to an hour behind and the model call takes
		// minutes.
		autoApplyOn();
		flagEnvValue = "true";
		runContextUpdateMock.mockImplementation(async () => {
			flagOverride = false;
			return UPDATE;
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({ status: "SKIPPED_DISABLED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).not.toHaveBeenCalled();
		expect(completeCycleMock).not.toHaveBeenCalled();
		expect(notifyMock).not.toHaveBeenCalled();
		// The generation actually ran — this is an abandon at the write, not a
		// document that was never picked up.
		expect(runContextUpdateMock).toHaveBeenCalledTimes(1);
	});

	it("re-reads the gate from the shared registry, by key", async () => {
		autoApplyOn();

		await runDocumentRefreshActivity(DUE);

		expect(flagMock).toHaveBeenCalledWith("LIVING_DOCS_REFRESH_SWEEP");
	});

	it("abandons without writing when the document was un-enrolled mid-generation", async () => {
		getSettingsMock.mockResolvedValue({
			documentId: "doc_1",
			enabled: false,
			autoApply: true,
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({ status: "SKIPPED_DISABLED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).not.toHaveBeenCalled();
	});

	it("abandons when the settings row disappeared entirely", async () => {
		getSettingsMock.mockResolvedValue(null);

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({ status: "SKIPPED_DISABLED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
	});

	it("re-reads the switches AFTER generating, not before", async () => {
		// A check that ran before the model call would leave the whole generation
		// window unguarded — which is the entire window that matters.
		autoApplyOn();

		await runDocumentRefreshActivity(DUE);

		expect(runContextUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
			getSettingsMock.mock.invocationCallOrder[0],
		);
	});
});

describe("refusals", () => {
	it("refuses the model's own ambiguity flag and writes nothing", async () => {
		// A successful prompt injection — a forged high-precedence "source"
		// contradicting the document — looks exactly like this. The interactive path
		// surfaces it to the person reading the diff; nobody is reading this one.
		autoApplyOn();
		runContextUpdateMock.mockResolvedValue({
			...UPDATE,
			needsHumanResolution: true,
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toMatchObject({ status: "REFUSED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).not.toHaveBeenCalled();
	});

	it("refuses a rewrite that would delete most of a substantial document", async () => {
		// Far more likely to be a truncated generation, a refusal, or a successful
		// injection than a real edit. A human would see it in the diff and reject it.
		autoApplyOn();
		getDocumentMock.mockResolvedValue({
			...DOCUMENT,
			content: LONG_CONTENT,
		});
		runContextUpdateMock.mockResolvedValue({
			...UPDATE,
			updatedDocument: "# PRD\n\nTBD.",
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toMatchObject({ status: "REFUSED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
	});

	it("ADVANCES the cadence clock on a refusal — the cycle did run", async () => {
		// A refusal is a COMPLETED cycle: the model looked and answered, and we threw
		// the answer away. Recording it as a failure would leave the document
		// permanently due and re-generate it, at the owner's expense, every six hours
		// until a human intervened.
		autoApplyOn();
		runContextUpdateMock.mockResolvedValue({
			...UPDATE,
			needsHumanResolution: true,
		});

		await runDocumentRefreshActivity(DUE);

		expect(completeCycleMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ status: "REFUSED" }),
		);
		expect(recordOutcomeMock).not.toHaveBeenCalled();
	});

	it("lets an ordinary large edit through — the guard is a floor, not a bound", async () => {
		// Documents genuinely do get descoped. The guard catches the catastrophic
		// case; it must not block normal editing.
		autoApplyOn();
		getDocumentMock.mockResolvedValue({
			...DOCUMENT,
			content: LONG_CONTENT,
		});
		runContextUpdateMock.mockResolvedValue({
			...UPDATE,
			// Shorter, but still well over half the original.
			updatedDocument: LONG_CONTENT.slice(0, LONG_CONTENT.length - 100),
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toMatchObject({ status: "COMMITTED" });
		expect(updateDocumentMock).toHaveBeenCalledTimes(1);
	});

	it("does not apply the shrink guard to a short document", async () => {
		// A 20-character stub legitimately becomes a 10-character stub; the ratio
		// means nothing at that size.
		autoApplyOn();
		runContextUpdateMock.mockResolvedValue({
			...UPDATE,
			updatedDocument: "# PRD",
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toMatchObject({ status: "COMMITTED" });
	});
});

describe("retrieval outage", () => {
	it("records FAILED and THROWS — an outage is never 'nothing changed'", async () => {
		// The most expensive bug this feature could have. Retrieval resolves EMPTY
		// when the embedding provider is down — it does not throw — so without the
		// explicit `retrievalFailed` flag an outage is indistinguishable from "this
		// project has no context", gets recorded as NO_CHANGES, ADVANCES the cadence
		// clock, and silences the document for a fortnight. Across every tenant, in
		// one sweep.
		autoApplyOn();
		fetchSourcesMock.mockResolvedValue({
			...SOURCES,
			contextItems: [],
			retrievalFailed: true,
		});

		await expect(runDocumentRefreshActivity(DUE)).rejects.toThrow();

		expect(recordOutcomeMock).toHaveBeenCalledWith(
			"doc_1",
			"FAILED",
			expect.any(String),
		);
		// The clock must NOT advance — the document stays due and the next sweep
		// retries it.
		expect(completeCycleMock).not.toHaveBeenCalled();
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).not.toHaveBeenCalled();
	});

	it("never records a retrieval outage as NO_CHANGES", async () => {
		autoApplyOn();
		fetchSourcesMock.mockResolvedValue({
			...SOURCES,
			contextItems: [],
			retrievalFailed: true,
		});

		await expect(runDocumentRefreshActivity(DUE)).rejects.toThrow();

		for (const call of completeCycleMock.mock.calls) {
			expect(call[1].status).not.toBe("NO_CHANGES");
		}
		expect(recordOutcomeMock).not.toHaveBeenCalledWith(
			"doc_1",
			"NO_CHANGES",
			expect.anything(),
		);
	});

	it("asks retrieval to fail loudly rather than degrade to empty", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(fetchSourcesMock).toHaveBeenCalledWith(
			expect.objectContaining({ failOnRetrievalError: true }),
		);
	});
});

describe("empty document", () => {
	it("refreshes nothing and calls no model — a refresh updates, it does not invent", async () => {
		// With nothing to update, the model would be handed an empty spec plus the
		// last 60 chat messages and told to return "the COMPLETE specification
		// document" — and it would invent one, out of standup chatter, with no prior
		// version to restore to.
		getDocumentMock.mockResolvedValue({ ...DOCUMENT, content: "" });

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toMatchObject({ status: "NO_CHANGES" });
		expect(runContextUpdateMock).not.toHaveBeenCalled();
		expect(fetchSourcesMock).not.toHaveBeenCalled();
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(storeProposalMock).not.toHaveBeenCalled();
	});

	it("treats a whitespace-only document as empty", async () => {
		getDocumentMock.mockResolvedValue({
			...DOCUMENT,
			content: "   \n\n\t  ",
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toMatchObject({ status: "NO_CHANGES" });
		expect(runContextUpdateMock).not.toHaveBeenCalled();
	});

	it("still completes the cycle so it does not retry every hour", async () => {
		getDocumentMock.mockResolvedValue({ ...DOCUMENT, content: "" });

		await runDocumentRefreshActivity(DUE);

		expect(completeCycleMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ status: "NO_CHANGES" }),
		);
	});

	it("skips a document that was deleted between dispatch and run", async () => {
		getDocumentMock.mockResolvedValue(null);

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({ status: "SKIPPED_DELETED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
	});
});

describe("no-op cycle", () => {
	it("commits nothing when the model finds no relevant context", async () => {
		autoApplyOn();
		runContextUpdateMock.mockResolvedValue({
			hasRelevantContext: false,
			updatedDocument: DOCUMENT.content,
			needsHumanResolution: false,
			summary: "No updates found.",
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({
			status: "NO_CHANGES",
			summary: "No updates found.",
		});
		// The whole point: version history must not accumulate a fortnightly entry
		// that says nothing changed.
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it("does not propose a no-op either", async () => {
		runContextUpdateMock.mockResolvedValue({
			hasRelevantContext: false,
			updatedDocument: DOCUMENT.content,
			needsHumanResolution: false,
			summary: "No updates found.",
		});

		await runDocumentRefreshActivity(DUE);

		expect(storeProposalMock).not.toHaveBeenCalled();
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it("still advances the cycle so it does not re-run every hour", async () => {
		runContextUpdateMock.mockResolvedValue({
			hasRelevantContext: false,
			updatedDocument: DOCUMENT.content,
			needsHumanResolution: false,
			summary: "No updates found.",
		});

		await runDocumentRefreshActivity(DUE);

		expect(completeCycleMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ status: "NO_CHANGES" }),
		);
	});
});

describe("committed cycle", () => {
	beforeEach(() => {
		autoApplyOn();
	});

	it("commits the new content with the model's summary as the change description", async () => {
		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({
			status: "COMMITTED",
			summary: UPDATE.summary,
		});
		expect(updateDocumentMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				content: UPDATE.updatedDocument,
				changeDescription: UPDATE.summary,
			}),
		);
	});

	it("attributes the version to the refresh agent, not to a person", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(updateDocumentMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ lastEditedBy: AI_REFRESH_AUTHOR_ID }),
		);
	});

	it("guards the write with the version it read before generating", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(updateDocumentMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ expectedVersion: 3 }),
		);
	});

	it("reads source-only context and passes the document as the baseline", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(fetchSourcesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				// Never a document a previous refresh generated — an unattended cycle
				// must not read its own output.
				excludeDocumentChunks: true,
				specMarkdown: DOCUMENT.content,
			}),
		);
	});

	it("re-embeds the document so the rest of the system stops serving the old one", async () => {
		// Without this, Qdrant keeps serving the PRE-refresh document forever, while
		// chat, Atlas, the task agent and the knowledge API all keep answering from a
		// document that no longer exists.
		await runDocumentRefreshActivity(DUE);

		expect(sideEffectsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc_1",
				projectId: "proj_1",
			}),
		);
	});

	it("notifies the document's subscribers that it was updated", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc_1",
				link: "projects/proj_1/documents/doc_1",
				kind: "committed",
			}),
		);
	});

	/**
	 * AE10 — an SRS-typed document enrolled in auto-refresh produces a committed
	 * version carrying a change summary.
	 */
	it("AE10: an enrolled SRS produces a committed version with a change summary", async () => {
		getDocumentMock.mockResolvedValue({
			...DOCUMENT,
			title: "Software Requirements Specification",
			type: "SRS",
			content: LONG_CONTENT,
		});
		runContextUpdateMock.mockResolvedValue({
			...UPDATE,
			updatedDocument: `${LONG_CONTENT}\n\nSSO is out of scope.`,
			summary:
				"Removed SSO from the scope section per the July 9 standup.",
		});

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({
			status: "COMMITTED",
			summary:
				"Removed SSO from the scope section per the July 9 standup.",
		});
		// The version row itself carries the summary — that is what the version
		// history renders beside the agent's name.
		expect(updateDocumentMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				changeDescription:
					"Removed SSO from the scope section per the July 9 standup.",
				lastEditedBy: AI_REFRESH_AUTHOR_ID,
				expectedVersion: 3,
			}),
		);
		expect(completeCycleMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				status: "COMMITTED",
				summary:
					"Removed SSO from the scope section per the July 9 standup.",
			}),
		);
	});
});

/**
 * AGENTS.md: every feature must work in BOTH tenant contexts, and this one
 * resolves an AI provider and logs usage against the actor — so a tenant mix-up
 * here bills the wrong party and can resolve the wrong model config.
 */
describe("tenant contexts", () => {
	beforeEach(() => {
		autoApplyOn();
	});

	it("commits a personal-context document under the enroller's own identity", async () => {
		await runDocumentRefreshActivity(DUE);

		expect(updateDocumentMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				userId: "user_1",
				organizationId: undefined,
			}),
		);
		expect(fetchSourcesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_1",
				organizationId: undefined,
			}),
		);
	});

	it("commits an organization document in the ORG tenant", async () => {
		const outcome = await runDocumentRefreshActivity(DUE_IN_ORG);

		expect(outcome).toMatchObject({ status: "COMMITTED" });
		expect(updateDocumentMock).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ organizationId: "org_1" }),
		);
	});

	it("resolves the model and logs usage against the enroller, in the org tenant", async () => {
		await runDocumentRefreshActivity(DUE_IN_ORG);

		expect(fetchSourcesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_1",
				organizationId: "org_1",
			}),
		);
		expect(runContextUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_1",
				organizationId: "org_1",
				projectId: "proj_1",
			}),
		);
	});

	it("carries the org tenant onto the notification and the re-embed", async () => {
		await runDocumentRefreshActivity(DUE_IN_ORG);

		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
		expect(sideEffectsMock).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_1" }),
		);
	});

	it("proposes in the org tenant too", async () => {
		getSettingsMock.mockResolvedValue({
			documentId: "doc_1",
			enabled: true,
			autoApply: false,
		});

		const outcome = await runDocumentRefreshActivity(DUE_IN_ORG);

		expect(outcome).toMatchObject({ status: "PROPOSED" });
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org_1",
				kind: "proposed",
			}),
		);
	});
});

describe("lost race", () => {
	it("abandons without overwriting when a human saved during generation", async () => {
		autoApplyOn();
		updateDocumentMock.mockRejectedValue(
			new DocumentVersionConflictError("doc_1", 3, 4),
		);

		const outcome = await runDocumentRefreshActivity(DUE);

		expect(outcome).toEqual({ status: "SKIPPED_COLLISION" });
		// Crucially: the cycle is NOT completed, so the document stays due and the
		// next sweep retries it rather than silently losing a fortnight.
		expect(completeCycleMock).not.toHaveBeenCalled();
		expect(recordOutcomeMock).toHaveBeenCalledWith(
			"doc_1",
			"SKIPPED_COLLISION",
			expect.any(String),
		);
		expect(notifyMock).not.toHaveBeenCalled();
		expect(sideEffectsMock).not.toHaveBeenCalled();
	});
});

describe("failure", () => {
	it("stamps the attempt before the model call so a failing document backs off", async () => {
		runContextUpdateMock.mockRejectedValue(new Error("provider exploded"));

		await expect(runDocumentRefreshActivity(DUE)).rejects.toThrow(
			"provider exploded",
		);

		expect(markAttemptMock).toHaveBeenCalledWith("doc_1", expect.any(Date));
		expect(recordOutcomeMock).toHaveBeenCalledWith(
			"doc_1",
			"FAILED",
			"provider exploded",
		);
		// A failed cycle must never advance lastRefreshedAt.
		expect(completeCycleMock).not.toHaveBeenCalled();
	});

	it("fails non-retryably when the model output was truncated, recording the outcome", async () => {
		const { ContextUpdateTruncatedError } = await vi.importActual<
			typeof import("../../../lib/update-with-context-core")
		>("../../../lib/update-with-context-core");
		runContextUpdateMock.mockRejectedValue(
			new ContextUpdateTruncatedError(
				"The AI response was truncated at the model's output-token limit before the full updated document could be generated.",
			),
		);

		await expect(runDocumentRefreshActivity(DUE)).rejects.toMatchObject({
			nonRetryable: true,
			type: "CONTEXT_UPDATE_TRUNCATED",
		});

		expect(recordOutcomeMock).toHaveBeenCalledWith(
			"doc_1",
			"FAILED",
			expect.stringContaining("too large"),
		);
		// A truncated cycle must never advance lastRefreshedAt.
		expect(completeCycleMock).not.toHaveBeenCalled();
	});

	it("throws when the AI provider is missing, so Temporal retries it", async () => {
		// Returning here would mark the activity a success and a transient provider
		// blip would never be retried.
		runContextUpdateMock.mockResolvedValue(null);

		await expect(runDocumentRefreshActivity(DUE)).rejects.toThrow();

		expect(recordOutcomeMock).toHaveBeenCalledWith(
			"doc_1",
			"FAILED",
			expect.any(String),
		);
		expect(updateDocumentMock).not.toHaveBeenCalled();
		expect(completeCycleMock).not.toHaveBeenCalled();
	});
});
