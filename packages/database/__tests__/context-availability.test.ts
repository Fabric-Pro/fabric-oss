/**
 * Tests for formatContextAvailabilityText
 *
 * Pure function tests — mocks DB client to avoid DATABASE_URL requirement.
 * Run with: pnpm --filter @repo/database test __tests__/context-availability.test.ts
 */

import { describe, expect, it, vi } from "vitest";

// Mock the Prisma client to avoid DATABASE_URL requirement
vi.mock("../prisma/client", () => ({
	db: {},
	Prisma: { sql: vi.fn() },
}));

import {
	deriveCodebaseState,
	formatContextAvailabilityText,
} from "../prisma/queries/projects/contexts";

describe("formatContextAvailabilityText", () => {
	it("should list all sources as available when everything is connected", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: true,
			transcriptCount: 3,
			fileCount: 5,
			integrationCount: 4,
			teamsCount: 2,
			slackCount: 1,
			websiteSources: 0,
		});

		expect(text).toContain("AVAILABLE:");
		expect(text).toContain("Codebase analysis (attached repository)");
		expect(text).toContain("Meeting transcripts (3 synced)");
		expect(text).toContain("Project files and documents (5)");
		expect(text).toContain("Teams chat conversations");
		expect(text).toContain("Slack channel conversations");
		expect(text).toContain("Other integrations (1 sources)");
		expect(text).not.toContain("NOT AVAILABLE:");
	});

	it("should list all sources as unavailable when nothing is connected", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 0,
			teamsCount: 0,
			slackCount: 0,
			websiteSources: 0,
		});

		expect(text).toContain("NOT AVAILABLE:");
		// Deliberate behavior change: the old "no repository attached or analysis
		// not completed" string was the reported bug (it implied no repo even when
		// one was connected but expired). The not-connected case now reads clean.
		expect(text).toContain("Codebase (no repository connected)");
		expect(text).not.toContain("no repository attached");
		expect(text).toContain("Meeting transcripts (none synced)");
		expect(text).toContain("Teams chat (not connected)");
		expect(text).toContain("Slack chat (not connected)");
	});

	it("should handle mixed availability", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: true,
			transcriptCount: 0,
			fileCount: 2,
			integrationCount: 1,
			teamsCount: 1,
			slackCount: 0,
			websiteSources: 0,
		});

		expect(text).toContain("AVAILABLE:");
		expect(text).toContain("Codebase analysis");
		expect(text).toContain("Teams chat conversations");
		expect(text).toContain("Project files and documents (2)");
		expect(text).toContain("NOT AVAILABLE:");
		expect(text).toContain("Meeting transcripts (none synced)");
		expect(text).toContain("Slack chat (not connected)");
	});

	it("should correctly calculate other integrations with multiple Teams/Slack chats", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 5,
			teamsCount: 3,
			slackCount: 1,
			websiteSources: 0,
		});

		// 5 total - 3 teams - 1 slack = 1 other
		expect(text).toContain("Other integrations (1 sources)");
	});

	it("should not show other integrations when all are Teams/Slack", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 3,
			teamsCount: 2,
			slackCount: 1,
			websiteSources: 0,
		});

		expect(text).not.toContain("Other integrations");
	});

	it("should not list files as unavailable (optional context)", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: true,
			transcriptCount: 1,
			fileCount: 0,
			integrationCount: 0,
			teamsCount: 0,
			slackCount: 0,
			websiteSources: 0,
		});

		expect(text).not.toContain("Project files");
	});

	it("should start with Context Sources header", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 0,
			teamsCount: 0,
			slackCount: 0,
			websiteSources: 0,
		});

		expect(text).toMatch(/^Context Sources:/);
	});

	it("should surface websiteSources count when LINK rows exist", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 0,
			teamsCount: 0,
			slackCount: 0,
			websiteSources: 3,
		});

		expect(text).toContain("AVAILABLE:");
		expect(text).toContain("Website sources (3)");
	});

	it("should NOT surface websiteSources line when count is zero (optional context)", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			transcriptCount: 0,
			fileCount: 0,
			integrationCount: 0,
			teamsCount: 0,
			slackCount: 0,
			websiteSources: 0,
		});

		expect(text).not.toContain("Website sources");
	});
});

describe("deriveCodebaseState", () => {
	const base = {
		integrationStatuses: ["ACTIVE"],
		codeSearchEnabled: true,
		codeIndexStatus: "READY" as string | null,
	};

	it("returns not-connected when no integration row exists", () => {
		expect(deriveCodebaseState({ ...base, integrationStatuses: [] })).toBe(
			"not-connected",
		);
	});

	it("returns code-search-disabled when the toggle is off", () => {
		expect(deriveCodebaseState({ ...base, codeSearchEnabled: false })).toBe(
			"code-search-disabled",
		);
	});

	it("returns credentials-expired for TOKEN_EXPIRED even when index is missing (AE1)", () => {
		expect(
			deriveCodebaseState({
				integrationStatuses: ["TOKEN_EXPIRED"],
				codeSearchEnabled: true,
				codeIndexStatus: null,
			}),
		).toBe("credentials-expired");
	});

	it("returns credentials-expired for a live-but-broken ERROR integration", () => {
		expect(
			deriveCodebaseState({ ...base, integrationStatuses: ["ERROR"] }),
		).toBe("credentials-expired");
	});

	it("returns repo-unreachable when every live row is REPO_UNAVAILABLE (credential fine, repo unreadable)", () => {
		// "credentials expired — re-authenticate" would be the wrong remedy here:
		// reconnecting cannot grant access to a repository the app is not
		// installed on.
		expect(
			deriveCodebaseState({
				...base,
				integrationStatuses: ["REPO_UNAVAILABLE"],
				codeIndexStatus: null,
			}),
		).toBe("repo-unreachable");
	});

	it("keeps credentials-expired when REPO_UNAVAILABLE mixes with real expiry", () => {
		expect(
			deriveCodebaseState({
				...base,
				integrationStatuses: ["REPO_UNAVAILABLE", "TOKEN_EXPIRED"],
				codeIndexStatus: null,
			}),
		).toBe("credentials-expired");
	});

	it("repo-unreachable does not pass the credential gate even with the index ready", () => {
		expect(
			deriveCodebaseState({
				...base,
				integrationStatuses: ["REPO_UNAVAILABLE"],
			}),
		).toBe("repo-unreachable");
	});

	it("treats a DISCONNECTED-only project as not-connected (detached row)", () => {
		expect(
			deriveCodebaseState({
				...base,
				integrationStatuses: ["DISCONNECTED"],
			}),
		).toBe("not-connected");
		// A live repo alongside a disconnected one still drives the state.
		expect(
			deriveCodebaseState({
				...base,
				integrationStatuses: ["DISCONNECTED", "TOKEN_EXPIRED"],
				codeIndexStatus: null,
			}),
		).toBe("credentials-expired");
	});

	it("returns not-indexed when active but the index is missing or building (AE2)", () => {
		for (const codeIndexStatus of [null, "PENDING", "INDEXING"]) {
			expect(deriveCodebaseState({ ...base, codeIndexStatus })).toBe(
				"not-indexed",
			);
		}
	});

	it("returns indexing-failed when the index failed", () => {
		expect(
			deriveCodebaseState({ ...base, codeIndexStatus: "FAILED" }),
		).toBe("indexing-failed");
	});

	it("returns available when active and the index is READY or STALE", () => {
		expect(deriveCodebaseState({ ...base, codeIndexStatus: "READY" })).toBe(
			"available",
		);
		expect(deriveCodebaseState({ ...base, codeIndexStatus: "STALE" })).toBe(
			"available",
		);
	});

	it("resolves to available when one repo is ACTIVE+ready even if another is expired (multi-repo)", () => {
		expect(
			deriveCodebaseState({
				integrationStatuses: ["TOKEN_EXPIRED", "ACTIVE"],
				codeSearchEnabled: true,
				codeIndexStatus: "READY",
			}),
		).toBe("available");
	});
});

describe("formatContextAvailabilityText — codebaseState messages", () => {
	const counts = {
		transcriptCount: 0,
		fileCount: 0,
		integrationCount: 0,
		teamsCount: 0,
		slackCount: 0,
		websiteSources: 0,
	};

	it("credentials-expired: says connected + expired + re-auth, never 'no repository attached' (AE1)", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			codebaseState: "credentials-expired",
			...counts,
		});
		expect(text).toContain("repository connected");
		expect(text).toContain("credentials expired");
		expect(text).toContain("re-authenticate");
		expect(text).not.toContain("no repository attached");
		expect(text).not.toContain("no repository connected");
	});

	it("repo-unreachable: names the grant remedy and never says re-authenticate", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			codebaseState: "repo-unreachable",
			...counts,
		});
		expect(text).toContain("cannot read it");
		expect(text).toContain("personal access token");
		expect(text).toContain("reconnecting will not help");
	});

	it("not-indexed: says connected + still indexing, not 'no repository' (AE2)", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			codebaseState: "not-indexed",
			...counts,
		});
		expect(text).toContain("repository connected");
		expect(text).toContain("indexing");
		expect(text).not.toContain("no repository");
	});

	it("code-search-disabled: says connected + how to enable (AE4)", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			codebaseState: "code-search-disabled",
			...counts,
		});
		expect(text).toContain("repository connected");
		expect(text).toContain("code search is turned off");
	});

	it("not-connected: is the only state that says no repository connected (AE3)", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: false,
			codebaseState: "not-connected",
			...counts,
		});
		expect(text).toContain("Codebase (no repository connected)");
	});

	it("available: renders the affirmative attached-repository line", () => {
		const text = formatContextAvailabilityText({
			hasCodebase: true,
			codebaseState: "available",
			...counts,
		});
		expect(text).toContain("Codebase analysis (attached repository)");
	});
});
