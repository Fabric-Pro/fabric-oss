/**
 * Living Documents refresh proposals — `applyDocumentAutoRefreshProposalProcedure`
 * and `discardDocumentAutoRefreshProposalProcedure`.
 *
 * A refresh PROPOSES by default and only writes when the owner opted into
 * `autoApply`. These two procedures are the human half of that: accept, or
 * reject. The behaviours pinned here are the ones whose absence would make the
 * review step a lie —
 *
 *   - ACCEPT ATTRIBUTES THE VERSION TO THE HUMAN. The agent drafted it; a person
 *     read it and committed it. `lastEditedBy` is the accepting caller.
 *   - A STALE PROPOSAL IS NEVER APPLIED. The draft is generated against version
 *     N and can sit unread for days. If the document has moved since, applying
 *     it would silently revert whoever edited in between — so the write is
 *     guarded by `expectedVersion` and a lost race reports `stale` instead of
 *     overwriting (or 500ing).
 *   - ACCEPT RE-EMBEDS. Skipping the side effects would leave Qdrant answering
 *     searches from the pre-refresh body.
 *
 * The three gates (feature flag, tenant-first NOT_FOUND, DOCUMENT_UPDATE) are
 * asserted exactly as in the sibling `set-auto-refresh.test.ts` — including the
 * flag's resolution through the shared registry (override row >
 * `FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT` > registry default), driven here by the
 * real `resolveFlag` behind the `isFeatureEnabled` mock.
 */

import {
	type FeatureFlagKey,
	resolveFlag,
} from "@repo/utils/feature-flag-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, DocumentVersionConflictError } = vi.hoisted(() => {
	// A real class — the handler branches on `instanceof`, so a plain object
	// stub would sail straight past the stale guard and out as a 500.
	class DocumentVersionConflictError extends Error {
		constructor(
			readonly documentId: string,
			readonly expectedVersion: number,
			readonly actualVersion: number,
		) {
			super(
				`Document ${documentId} moved from version ${expectedVersion} to ${actualVersion}.`,
			);
			this.name = "DocumentVersionConflictError";
		}
	}
	return {
		DocumentVersionConflictError,
		mocks: {
			hasProjectAccess: vi.fn(),
			getDocumentById: vi.fn(),
			getAutoRefreshSettings: vi.fn(),
			clearRefreshProposal: vi.fn(),
			updateDocument: vi.fn(),
			applyDocumentUpdateSideEffects: vi.fn(),
			isFeatureEnabled: vi.fn(),
		},
	};
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	getAutoRefreshSettings: mocks.getAutoRefreshSettings,
	clearRefreshProposal: mocks.clearRefreshProposal,
	updateDocument: mocks.updateDocument,
	isFeatureEnabled: mocks.isFeatureEnabled,
	DocumentVersionConflictError,
}));

vi.mock("../../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: mocks.applyDocumentUpdateSideEffects,
}));

vi.mock("../../../../../orpc/procedures", () => {
	let lastPermission: string | undefined;
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			const p = (mw as { __permission?: string })?.__permission;
			if (p) {
				lastPermission = p;
			}
			return chain;
		},
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			__permission: lastPermission,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (permission: string) => {
			const mw = () => chain;
			(mw as unknown as { __permission: string }).__permission =
				permission;
			return mw;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { applyDocumentAutoRefreshProposalProcedure } from "../apply-auto-refresh-proposal";
import { discardDocumentAutoRefreshProposalProcedure } from "../discard-auto-refresh-proposal";

type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string; name?: string | null };
		session: { activeOrganizationId?: string | null };
	};
}) => Promise<Record<string, unknown>>;

const wired = (p: unknown) =>
	p as unknown as { _handler: Handler; __permission: string };

const applyHandler = wired(applyDocumentAutoRefreshProposalProcedure)._handler;
const discardHandler = wired(
	discardDocumentAutoRefreshProposalProcedure,
)._handler;

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";
const ORG_ID = "org-a";
const AGENT_ID = "agent-refresh";
const PROPOSED_AT = new Date("2026-07-01T00:00:00.000Z");

function ctx(userId = "user-1") {
	return {
		user: { id: userId, name: "Ada" },
		session: { activeOrganizationId: ORG_ID },
	};
}

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: DOCUMENT_ID,
		projectId: PROJECT_ID,
		title: "PRD",
		type: "PRD",
		status: "COMPLETE",
		version: 4,
		userId: "owner-1",
		organizationId: ORG_ID,
		...overrides,
	};
}

/** A settings row WITH a proposal waiting on it. */
function makeSettings(overrides: Record<string, unknown> = {}) {
	return {
		id: "settings-1",
		documentId: DOCUMENT_ID,
		projectId: PROJECT_ID,
		enabled: true,
		cadence: "BIWEEKLY",
		autoApply: false,
		createdByUserId: AGENT_ID,
		pendingContent: "# Refreshed PRD\n\nNew content.",
		pendingSummary: "Updated the success metrics section.",
		pendingProposedAt: PROPOSED_AT,
		pendingBaselineVersion: 3,
		lastRefreshedAt: PROPOSED_AT,
		lastRefreshStatus: "PROPOSED",
		lastRefreshSummary: "Updated the success metrics section.",
		userId: "owner-1",
		organizationId: ORG_ID,
		...overrides,
	};
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_ID,
		id: DOCUMENT_ID,
		organizationId: ORG_ID,
		...overrides,
	};
}

/** The admin override row, as `getFlagOverrides` would report it. */
let flagOverride: boolean | undefined;

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	flagOverride = undefined;
	mocks.isFeatureEnabled.mockImplementation(
		async (key: FeatureFlagKey) =>
			resolveFlag(key, flagOverride, process.env).enabled,
	);
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getDocumentById.mockResolvedValue(makeDocument());
	mocks.getAutoRefreshSettings.mockResolvedValue(makeSettings());
	mocks.clearRefreshProposal.mockResolvedValue(undefined);
	mocks.updateDocument.mockResolvedValue(makeDocument({ version: 4 }));
	mocks.applyDocumentUpdateSideEffects.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("applyDocumentAutoRefreshProposalProcedure — accepting", () => {
	it("writes the pending content to the document", async () => {
		const result = await applyHandler({ input: input(), context: ctx() });

		expect(mocks.updateDocument).toHaveBeenCalledWith(
			DOCUMENT_ID,
			expect.objectContaining({
				content: "# Refreshed PRD\n\nNew content.",
				changeDescription: "Updated the success metrics section.",
			}),
		);
		expect(result).toEqual({ applied: true, version: 4 });
	});

	it("attributes the new version to the ACCEPTING USER, not to the agent that drafted it", async () => {
		// The settings row's actor is the agent; the caller is a human. A person
		// read the proposal and chose to commit it, so the ledger names the person.
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ createdByUserId: AGENT_ID }),
		);

		await applyHandler({ input: input(), context: ctx("user-7") });

		const [, payload] = mocks.updateDocument.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(payload.lastEditedBy).toBe("user-7");
		expect(payload.lastEditedBy).not.toBe(AGENT_ID);
		expect(payload.userId).toBe("user-7");
	});

	it("guards the write with the version the proposal was drafted from", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ pendingBaselineVersion: 3 }),
		);

		await applyHandler({ input: input(), context: ctx() });

		expect(mocks.updateDocument).toHaveBeenCalledWith(
			DOCUMENT_ID,
			expect.objectContaining({ expectedVersion: 3 }),
		);
	});

	it("clears the proposal and re-embeds the document", async () => {
		await applyHandler({ input: input(), context: ctx() });

		expect(mocks.clearRefreshProposal).toHaveBeenCalledWith(DOCUMENT_ID);
		// Without this the search index keeps serving the PRE-refresh body.
		expect(mocks.applyDocumentUpdateSideEffects).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				document: expect.objectContaining({ id: DOCUMENT_ID }),
				user: expect.objectContaining({ id: "user-1" }),
			}),
		);
	});
});

describe("applyDocumentAutoRefreshProposalProcedure — the stale proposal", () => {
	it("does NOT overwrite the document when it moved after the proposal was drafted", async () => {
		// The proposal was drafted from v3; someone has since saved v5. The
		// optimistic-concurrency guard in `updateDocument` rejects the write.
		mocks.updateDocument.mockRejectedValue(
			new DocumentVersionConflictError(DOCUMENT_ID, 3, 5),
		);

		const result = await applyHandler({ input: input(), context: ctx() });

		// Reported cleanly — not thrown as a 500.
		expect(result).toEqual({ applied: false, reason: "stale" });
		// The dead proposal is cleared so it cannot be accepted later...
		expect(mocks.clearRefreshProposal).toHaveBeenCalledWith(DOCUMENT_ID);
		// ...and NOTHING was written: no re-embed, no realtime "updated" event for
		// a change that never happened.
		expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
	});

	it("refuses to apply a proposal with no baseline version rather than writing it unguarded", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ pendingBaselineVersion: null }),
		);

		const result = await applyHandler({ input: input(), context: ctx() });

		expect(result).toEqual({ applied: false, reason: "stale" });
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.clearRefreshProposal).toHaveBeenCalledWith(DOCUMENT_ID);
		expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
	});

	it("still throws on a non-conflict failure — a database error is not a stale proposal", async () => {
		mocks.updateDocument.mockRejectedValue(new Error("connection reset"));

		await expect(
			applyHandler({ input: input(), context: ctx() }),
		).rejects.toThrow("connection reset");
		// The proposal survives a transient failure — the user can retry.
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});
});

describe("applyDocumentAutoRefreshProposalProcedure — nothing to apply", () => {
	it("returns NOT_FOUND when the settings row has no pending content", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(
			makeSettings({ pendingContent: null }),
		);

		await expect(
			applyHandler({ input: input(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND when the document has no settings row at all", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(null);

		await expect(
			applyHandler({ input: input(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});
});

describe("discardDocumentAutoRefreshProposalProcedure", () => {
	it("clears the proposal and never touches the document", async () => {
		const result = await discardHandler({
			input: input(),
			context: ctx(),
		});

		expect(result).toEqual({ discarded: true });
		expect(mocks.clearRefreshProposal).toHaveBeenCalledWith(DOCUMENT_ID);
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
	});

	it("is a quiet no-op when there is no settings row — a double-click is not an error", async () => {
		mocks.getAutoRefreshSettings.mockResolvedValue(null);

		const result = await discardHandler({
			input: input(),
			context: ctx(),
		});

		expect(result).toEqual({ discarded: false });
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});
});

describe("auto-refresh proposals — authorization", () => {
	it("wires both procedures to the DOCUMENT_UPDATE permission", () => {
		expect(
			wired(applyDocumentAutoRefreshProposalProcedure).__permission,
		).toBe("DOCUMENT_UPDATE");
		expect(
			wired(discardDocumentAutoRefreshProposalProcedure).__permission,
		).toBe("DOCUMENT_UPDATE");
	});

	it("returns NOT_FOUND — never FORBIDDEN — for a caller in the wrong tenant", async () => {
		// The document lives in org-a; the caller resolves to org-b. Project access
		// is deliberately mocked TRUE so this can only pass if the tenant gate ran
		// BEFORE the access check. FORBIDDEN would confirm the document exists.
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ organizationId: "org-a" }),
		);
		mocks.hasProjectAccess.mockResolvedValue(true);

		for (const handler of [applyHandler, discardHandler]) {
			const error = await handler({
				input: input({ organizationId: "org-b" }),
				context: ctx(),
			}).catch((e: { code: string }) => e);

			expect(error).toMatchObject({ code: "NOT_FOUND" });
			expect(error).not.toMatchObject({ code: "FORBIDDEN" });
		}

		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND for a personal-context caller reaching an org document", async () => {
		for (const handler of [applyHandler, discardHandler]) {
			await expect(
				handler({
					input: input({ organizationId: null }),
					context: ctx(),
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND when the document is not in the given project", async () => {
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ projectId: "other-project" }),
		);

		await expect(
			applyHandler({ input: input(), context: ctx() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("rejects a caller without project access with FORBIDDEN", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		for (const handler of [applyHandler, discardHandler]) {
			await expect(
				handler({ input: input(), context: ctx() }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});
});

describe("auto-refresh proposals — feature flag", () => {
	it("throws NOT_FOUND from both procedures when the env var is off, without touching the DB", async () => {
		vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT", "false");

		for (const handler of [applyHandler, discardHandler]) {
			await expect(
				handler({ input: input(), context: ctx() }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}

		expect(mocks.getDocumentById).not.toHaveBeenCalled();
		expect(mocks.getAutoRefreshSettings).not.toHaveBeenCalled();
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});

	it("resolves the gate through the shared registry, by key", async () => {
		await applyHandler({ input: input(), context: ctx() });

		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"LIVING_DOCS_REFRESH",
		);
	});

	it("lets an admin override of false close both routes even with the env var set", async () => {
		vi.stubEnv("FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT", "true");
		flagOverride = false;

		for (const handler of [applyHandler, discardHandler]) {
			await expect(
				handler({ input: input(), context: ctx() }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}

		// A stranded proposal is the intended trade — the row is untouched, so
		// turning the flag back on restores it exactly (registry note, #2210).
		expect(mocks.updateDocument).not.toHaveBeenCalled();
		expect(mocks.clearRefreshProposal).not.toHaveBeenCalled();
	});
});
