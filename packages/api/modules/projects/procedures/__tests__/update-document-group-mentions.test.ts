/**
 * Group-mention fan-out for `dispatchDocumentMentions` (#1767 Stage 5).
 *
 * Unit-tests `dispatchDocumentMentions` directly (exported for this purpose)
 * with `fanOut.documentMention`, `expandGroupMentionsByTag`,
 * `narrowToCurrentProjectRoster`, and `filterAuthorizedMentionRecipients`
 * mocked. `document-mentions.ts` (mention/group HTML parsing + diffing) is
 * left real/unmocked since it is pure and its parsing IS what's under test.
 *
 * Cases:
 *  1. New `@Developers` group span → one group dispatch, groupLabel
 *     "Developers", recipients = expanded+narrowed DEVELOPER holders.
 *  2. Individual `@Alice` + `@Developers` where Alice is a Developer →
 *     individual dispatch covers Alice (no label); group dispatch excludes
 *     Alice (precedence: individual "mentioned you" wins).
 *  3. Re-saving a doc that already had `@Developers` → no group dispatch.
 *  4. `@Architects` appears BEFORE `@Developers` in document order, but a
 *     member holding both tags is notified under whichever label
 *     `FUNCTION_TAG_ORDER` puts first — proving dispatch order is
 *     deterministic (`FUNCTION_TAG_ORDER`), not document-span order.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	docMention,
	expandGroupMentionsByTagMock,
	narrowToCurrentProjectRosterMock,
	filterAuthorizedMentionRecipientsMock,
} = vi.hoisted(() => ({
	docMention: vi.fn(),
	expandGroupMentionsByTagMock: vi.fn(),
	narrowToCurrentProjectRosterMock: vi.fn(),
	filterAuthorizedMentionRecipientsMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	hasProjectAccess: vi.fn(),
	updateDocument: vi.fn(),
	// Real implementation, not a stub: it is a pure string builder.
	buildDocumentLink: (args: { projectId: string; documentId: string }) =>
		`projects/${args.projectId}/documents/${args.documentId}`,
	// `document-mentions.ts` (left real/unmocked below) imports `isFunctionTag`
	// from this same barrel — mirror the real closed-set check so its group
	// span parsing works against genuine FunctionTag values.
	isFunctionTag: (value: string) =>
		[
			"PRODUCT_OWNER",
			"PRODUCT_CONTRIBUTOR",
			"DEVELOPER",
			"ARCHITECT",
			"DESIGNER",
			"SDET_QA",
			"SME",
			"STAKEHOLDER",
		].includes(value),
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentStatusSchema: {
		optional: () => ({}),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		documentMention: docMention.mockResolvedValue(undefined),
	},
}));

// Real — pure HTML parsing/diffing, and it's what's under test here.
vi.mock("../../lib/user-mention", () => ({
	filterAuthorizedMentionRecipients: (...args: unknown[]) =>
		filterAuthorizedMentionRecipientsMock(...args),
}));

vi.mock("../../lib/group-mention", () => ({
	expandGroupMentionsByTag: (...args: unknown[]) =>
		expandGroupMentionsByTagMock(...args),
	narrowToCurrentProjectRoster: (...args: unknown[]) =>
		narrowToCurrentProjectRosterMock(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => () => undefined,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { dispatchDocumentMentions } from "../update-document";

const baseArgs = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentTitle: "PRD",
	organizationId: "org_1",
	actorUserId: "actor_1",
	actorName: "Alice",
};

function groupSpan(tag: string, anchorId: string, label: string): string {
	return `<span data-type="mention" data-mention-id="${anchorId}" data-group-tag="${tag}">@${label}</span>`;
}

function userSpan(userId: string, anchorId: string, label: string): string {
	return `<span data-type="mention" data-id="${userId}" data-mention-id="${anchorId}">@${label}</span>`;
}

beforeEach(() => {
	vi.clearAllMocks();
	docMention.mockResolvedValue(undefined);
	filterAuthorizedMentionRecipientsMock.mockResolvedValue([]);
	expandGroupMentionsByTagMock.mockResolvedValue(new Map());
	narrowToCurrentProjectRosterMock.mockImplementation(
		async (ids: string[]) => ids,
	);
});

describe("dispatchDocumentMentions — group mentions", () => {
	it("case 1: new @Developers group span dispatches once with groupLabel and expanded+narrowed recipients", async () => {
		expandGroupMentionsByTagMock.mockResolvedValue(
			new Map([["DEVELOPER", ["dev_1", "dev_2"]]]),
		);
		narrowToCurrentProjectRosterMock.mockResolvedValue(["dev_1", "dev_2"]);

		await dispatchDocumentMentions({
			...baseArgs,
			prevContent: "<p>Doc body</p>",
			nextContent: `<p>Doc body ${groupSpan("DEVELOPER", "g1", "Developers")}</p>`,
		});

		expect(docMention).toHaveBeenCalledTimes(1);
		const call = docMention.mock.calls[0][0];
		expect(call.groupLabel).toBe("Developers");
		expect(call.recipients).toEqual([
			{ userId: "dev_1", anchorId: "g1" },
			{ userId: "dev_2", anchorId: "g1" },
		]);
		// One batched resolve for the mentioned tag(s) — no per-tag re-read.
		expect(expandGroupMentionsByTagMock).toHaveBeenCalledTimes(1);
		expect(expandGroupMentionsByTagMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			groupTags: ["DEVELOPER"],
		});
		// The union of holders is narrowed exactly once.
		expect(narrowToCurrentProjectRosterMock).toHaveBeenCalledTimes(1);
	});

	it("case 2: individual @Alice + @Developers — individual dispatch covers Alice, group dispatch excludes her", async () => {
		filterAuthorizedMentionRecipientsMock.mockResolvedValue(["alice"]);
		expandGroupMentionsByTagMock.mockResolvedValue(
			new Map([["DEVELOPER", ["alice", "bob"]]]),
		);
		narrowToCurrentProjectRosterMock.mockResolvedValue(["alice", "bob"]);

		await dispatchDocumentMentions({
			...baseArgs,
			prevContent: "<p>Doc</p>",
			nextContent: `<p>Doc ${userSpan("alice", "m_alice", "Alice")} ${groupSpan("DEVELOPER", "g1", "Developers")}</p>`,
		});

		expect(docMention).toHaveBeenCalledTimes(2);

		const individualCall = docMention.mock.calls[0][0];
		expect(individualCall.groupLabel).toBeUndefined();
		expect(individualCall.recipients).toEqual([
			{ userId: "alice", anchorId: "m_alice" },
		]);

		const groupCall = docMention.mock.calls[1][0];
		expect(groupCall.groupLabel).toBe("Developers");
		expect(groupCall.recipients).toEqual([
			{ userId: "bob", anchorId: "g1" },
		]);
		expect(
			groupCall.recipients.some(
				(r: { userId: string }) => r.userId === "alice",
			),
		).toBe(false);
	});

	it("case 3: re-saving a doc that already had @Developers dispatches nothing", async () => {
		const content = `<p>${groupSpan("DEVELOPER", "g1", "Developers")}</p>`;

		await dispatchDocumentMentions({
			...baseArgs,
			prevContent: content,
			nextContent: content,
		});

		expect(docMention).not.toHaveBeenCalled();
		expect(expandGroupMentionsByTagMock).not.toHaveBeenCalled();
		expect(narrowToCurrentProjectRosterMock).not.toHaveBeenCalled();
	});

	it("case 4: @Architects before @Developers in document order — member holding both is notified under the FUNCTION_TAG_ORDER-precedent label", async () => {
		// Sanity: this test only proves something if DEVELOPER precedes
		// ARCHITECT in the real FUNCTION_TAG_ORDER (document order is reversed
		// below — Architects first, Developers second).
		const developerIdx = FUNCTION_TAG_ORDER.indexOf("DEVELOPER");
		const architectIdx = FUNCTION_TAG_ORDER.indexOf("ARCHITECT");
		expect(developerIdx).toBeGreaterThanOrEqual(0);
		expect(architectIdx).toBeGreaterThanOrEqual(0);
		const precedentTag =
			developerIdx < architectIdx ? "DEVELOPER" : "ARCHITECT";
		const precedentAnchor = precedentTag === "DEVELOPER" ? "d1" : "a1";

		// Every requested tag resolves to the same both-tag holder, from a
		// single batched roster read.
		expandGroupMentionsByTagMock.mockImplementation(
			async ({ groupTags }: { groupTags: string[] }) =>
				new Map(groupTags.map((t) => [t, ["m_both"]])),
		);
		narrowToCurrentProjectRosterMock.mockImplementation(
			async (ids: string[]) => ids,
		);

		await dispatchDocumentMentions({
			...baseArgs,
			prevContent: "<p>Doc</p>",
			nextContent: `<p>${groupSpan("ARCHITECT", "a1", "Architects")} ${groupSpan("DEVELOPER", "d1", "Developers")}</p>`,
		});

		// M holds both tags and every "roster" call returns them for either
		// tag, so once dispatched under the precedent group, the second
		// group's `fresh` recipient list is empty and its dispatch is skipped
		// entirely — proving the member is notified exactly once, under the
		// FUNCTION_TAG_ORDER-precedent label, regardless of span order.
		expect(docMention).toHaveBeenCalledTimes(1);
		const call = docMention.mock.calls[0][0];
		expect(call.groupLabel).toBe(FUNCTION_TAG_GROUP_LABELS[precedentTag]);
		expect(call.recipients).toEqual([
			{ userId: "m_both", anchorId: precedentAnchor },
		]);
	});

	it("case 5: excludes the acting author from the group dispatch even when they hold the tag", async () => {
		// The author saved the doc — a group they belong to must not notify
		// them about their own edit (`id !== actorUserId`).
		expandGroupMentionsByTagMock.mockResolvedValue(
			new Map([["DEVELOPER", ["actor_1", "dev_2"]]]),
		);
		narrowToCurrentProjectRosterMock.mockResolvedValue([
			"actor_1",
			"dev_2",
		]);

		await dispatchDocumentMentions({
			...baseArgs,
			prevContent: "<p>Doc</p>",
			nextContent: `<p>${groupSpan("DEVELOPER", "g1", "Developers")}</p>`,
		});

		expect(docMention).toHaveBeenCalledTimes(1);
		const call = docMention.mock.calls[0][0];
		expect(call.recipients).toEqual([{ userId: "dev_2", anchorId: "g1" }]);
		expect(
			call.recipients.some(
				(r: { userId: string }) => r.userId === "actor_1",
			),
		).toBe(false);
	});
});
