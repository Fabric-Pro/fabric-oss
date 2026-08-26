/**
 * Couples two literals that are deliberately NOT coupled at runtime.
 *
 * `classifyTranscriptForbidden` (@repo/integrations/microsoft) writes the
 * operator-facing `error` string for a Teams tenant that has Graph transcript
 * access switched off. `personal-transcript-fetch.ts` recognises that state by
 * prefix-matching the same words, rather than importing them, so it can stay
 * unit-testable without standing up the Graph stack.
 *
 * Nothing at runtime holds those two in step. Reword the classifier and the
 * prefix match quietly stops firing: personal meetings fall back to the generic
 * "ask your IT admin" copy — the exact misdirection #2553 was about — and every
 * other test stays green, because they all assert against hardcoded fixture
 * strings rather than the classifier itself.
 *
 * So this file imports BOTH sides and asserts the real classifier output
 * against the real prefix. It must contain no copy of either literal.
 */

import { describe, expect, it, vi } from "vitest";

// `microsoft/index.ts` pulls the full Graph stack in via static imports. The
// classifier under test is pure, so stub the three so importing it is cheap.
vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: { findFirst: vi.fn(), update: vi.fn() },
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { TRANSCRIPT_ACCESS_DISABLED_PREFIX } from "@repo/api/modules/projects/procedures/meeting-digest/personal-transcript-fetch";
import { classifyTranscriptForbidden } from "@repo/integrations/microsoft";

describe("transcript-access-disabled prefix ↔ Graph classifier", () => {
	// The guard. If this fails, the classifier's wording moved and
	// TRANSCRIPT_ACCESS_DISABLED_PREFIX has to move with it — do not "fix" it by
	// relaxing the assertion, or the tenant-setting reason stops being reachable.
	it("matches the error the classifier emits for the tenant setting", () => {
		const classification = classifyTranscriptForbidden({
			error: {
				code: "Forbidden",
				innerError: { code: "GraphAccessToTranscriptsDisabled" },
			},
		});

		expect(classification).not.toBeNull();
		expect(
			classification?.error.startsWith(TRANSCRIPT_ACCESS_DISABLED_PREFIX),
		).toBe(true);
	});

	// The other two classifications must NOT match, or they would be rerouted
	// away from the admin-consent copy that is correct for them.
	it("does not match the speaker-attribution classification", () => {
		const classification = classifyTranscriptForbidden({
			error: {
				code: "Forbidden",
				innerError: { code: "SpeakerAttributionNotAllowed" },
			},
		});

		expect(classification).not.toBeNull();
		expect(
			classification?.error.startsWith(TRANSCRIPT_ACCESS_DISABLED_PREFIX),
		).toBe(false);
	});

	it("does not match the missing-permission classification", () => {
		const classification = classifyTranscriptForbidden({
			error: { code: "Forbidden" },
		});

		expect(classification).not.toBeNull();
		expect(
			classification?.error.startsWith(TRANSCRIPT_ACCESS_DISABLED_PREFIX),
		).toBe(false);
	});
});
