import { describe, expect, it } from "vitest";
import {
	classifyMergeLinkScenario,
	derivePmLinkState,
	type PmLinkStory,
} from "../duplicate-link";

/** Minimal linked/unlinked story builders for the classification tests. */
const linked = (externalId: string): Pick<PmLinkStory, "externalId"> => ({
	externalId,
});
const unlinked: Pick<PmLinkStory, "externalId"> = { externalId: null };

describe("classifyMergeLinkScenario", () => {
	it("UC0 — neither linked", () => {
		expect(classifyMergeLinkScenario(unlinked, unlinked)).toBe("UC0");
	});

	it("UC1 — survivor unlinked, discarded linked", () => {
		expect(classifyMergeLinkScenario(unlinked, linked("123"))).toBe("UC1");
	});

	it("UC2 — survivor linked, discarded unlinked", () => {
		expect(classifyMergeLinkScenario(linked("123"), unlinked)).toBe("UC2");
	});

	it("UC3_SAME — both linked to the same externalId", () => {
		expect(classifyMergeLinkScenario(linked("999"), linked("999"))).toBe(
			"UC3_SAME",
		);
	});

	it("UC3_DIFF — both linked to different externalIds", () => {
		expect(classifyMergeLinkScenario(linked("111"), linked("222"))).toBe(
			"UC3_DIFF",
		);
	});

	it("treats undefined externalId the same as null", () => {
		// PmLinkStory.externalId is string | null, but guard defensively.
		expect(
			classifyMergeLinkScenario(
				{ externalId: undefined as unknown as null },
				{ externalId: undefined as unknown as null },
			),
		).toBe("UC0");
	});
});

describe("derivePmLinkState — linked / unlinked", () => {
	it("reports unlinked when externalId is null", () => {
		const state = derivePmLinkState({
			externalId: null,
			externalUrl: null,
		});
		expect(state.linked).toBe(false);
		expect(state.ticketRef).toBeNull();
		expect(state.toolName).toBeNull();
		expect(state.detectedType).toBeNull();
		expect(state.stale).toBe(false);
		expect(state.error).toBe(false);
	});

	it("reports linked with a ticket reference when externalId is set", () => {
		const state = derivePmLinkState({
			externalId: "1234",
			externalUrl: "https://gitlab.com/acme/app/-/issues/1234",
		});
		expect(state.linked).toBe(true);
		expect(state.externalId).toBe("1234");
	});
});

describe("derivePmLinkState — tool name resolution from the URL host", () => {
	const cases: Array<[string, string, string, string]> = [
		// [label, url, expected detectedType, expected toolName]
		[
			"GitLab",
			"https://gitlab.com/acme/app/-/issues/1234",
			"gitlab",
			"GitLab",
		],
		["GitHub", "https://github.com/acme/app/issues/42", "github", "GitHub"],
		["Jira", "https://acme.atlassian.net/browse/PROJ-12", "jira", "Jira"],
		[
			"Azure DevOps",
			"https://dev.azure.com/acme/proj/_workitems/edit/55",
			"azure-devops",
			"Azure DevOps",
		],
	];

	for (const [label, url, detectedType, toolName] of cases) {
		it(`resolves ${label}`, () => {
			const state = derivePmLinkState({
				externalId: "x",
				externalUrl: url,
			});
			expect(state.detectedType).toBe(detectedType);
			expect(state.toolName).toBe(toolName);
		});
	}

	it("returns null tool name for an unrecognized host", () => {
		const state = derivePmLinkState({
			externalId: "x",
			externalUrl: "https://example.com/foo/1",
		});
		expect(state.detectedType).toBeNull();
		expect(state.toolName).toBeNull();
	});

	it("returns null tool name when there is no URL", () => {
		const state = derivePmLinkState({ externalId: "x", externalUrl: null });
		expect(state.toolName).toBeNull();
	});
});

describe("derivePmLinkState — ticket reference formatting", () => {
	it("prefixes a purely-numeric id with #", () => {
		const state = derivePmLinkState({
			externalId: "1234",
			externalUrl: null,
		});
		expect(state.ticketRef).toBe("#1234");
	});

	it("shows an alphanumeric key verbatim", () => {
		const state = derivePmLinkState({
			externalId: "PROJ-12",
			externalUrl: null,
		});
		expect(state.ticketRef).toBe("PROJ-12");
	});
});

describe("derivePmLinkState — stale / error flags", () => {
	const NOW = Date.UTC(2026, 5, 2); // 2026-06-02
	const DAY = 24 * 60 * 60 * 1000;
	const iso = (offsetDays: number) =>
		new Date(NOW - offsetDays * DAY).toISOString();

	it("flags error when the last sync status is FAILED", () => {
		const state = derivePmLinkState(
			{
				externalId: "1",
				externalUrl: "https://gitlab.com/acme/app/-/issues/1",
				lastPmSyncStatus: "FAILED",
				lastSyncedAt: iso(1),
			},
			NOW,
		);
		expect(state.error).toBe(true);
	});

	it("does not flag error for a SUCCESS status", () => {
		const state = derivePmLinkState(
			{
				externalId: "1",
				externalUrl: "https://gitlab.com/acme/app/-/issues/1",
				lastPmSyncStatus: "SUCCESS",
				lastSyncedAt: iso(1),
			},
			NOW,
		);
		expect(state.error).toBe(false);
	});

	it("flags stale when the last successful sync is older than the threshold", () => {
		const state = derivePmLinkState(
			{
				externalId: "1",
				externalUrl: "https://gitlab.com/acme/app/-/issues/1",
				lastPmSyncStatus: "SUCCESS",
				lastSyncedAt: iso(30),
			},
			NOW,
		);
		expect(state.stale).toBe(true);
	});

	it("does not flag stale for a recent sync", () => {
		const state = derivePmLinkState(
			{
				externalId: "1",
				externalUrl: "https://gitlab.com/acme/app/-/issues/1",
				lastPmSyncStatus: "SUCCESS",
				lastSyncedAt: iso(1),
			},
			NOW,
		);
		expect(state.stale).toBe(false);
	});

	it("does not flag stale for a linked-but-never-synced story", () => {
		const state = derivePmLinkState(
			{
				externalId: "1",
				externalUrl: "https://gitlab.com/acme/app/-/issues/1",
				lastSyncedAt: null,
			},
			NOW,
		);
		expect(state.stale).toBe(false);
	});

	it("never flags stale for an unlinked story", () => {
		const state = derivePmLinkState(
			{ externalId: null, externalUrl: null, lastSyncedAt: iso(365) },
			NOW,
		);
		expect(state.stale).toBe(false);
	});
});
