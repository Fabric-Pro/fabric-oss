/**
 * Integration tests for Google Drive provider metadata compatibility.
 *
 * Verifies that the new "google-drive" provider string is correctly
 * distinguished from the old "GOOGLE_DOCS" provider and other types.
 */

import { describe, expect, it } from "vitest";

/**
 * Simulates the context filter used in GoogleDriveIntegrationSettings.
 * This is the same logic from the component's queryFn.
 */
function filterGoogleDriveContexts(
	contexts: Array<{
		type: string;
		metadata: Record<string, unknown> | null;
	}>,
) {
	return contexts.filter((ctx) => {
		if (ctx.type !== "INTEGRATION") {
			return false;
		}
		const metadata = ctx.metadata as Record<string, unknown>;
		return metadata?.provider === "google-drive";
	});
}

describe("Google Drive provider compatibility filter", () => {
	it('includes contexts with provider === "google-drive"', () => {
		const contexts = [
			{
				type: "INTEGRATION",
				metadata: { provider: "google-drive", fileId: "f1" },
			},
		];

		expect(filterGoogleDriveContexts(contexts)).toHaveLength(1);
	});

	it('excludes contexts with provider === "GOOGLE_DOCS" (old format)', () => {
		const contexts = [
			{
				type: "INTEGRATION",
				metadata: { provider: "GOOGLE_DOCS", fileId: "f1" },
			},
		];

		expect(filterGoogleDriveContexts(contexts)).toHaveLength(0);
	});

	it("excludes contexts with no provider", () => {
		const contexts = [
			{
				type: "INTEGRATION",
				metadata: { fileId: "f1" },
			},
		];

		expect(filterGoogleDriveContexts(contexts)).toHaveLength(0);
	});

	it("excludes contexts with null metadata", () => {
		const contexts = [
			{
				type: "INTEGRATION",
				metadata: null,
			},
		];

		expect(filterGoogleDriveContexts(contexts)).toHaveLength(0);
	});

	it('excludes contexts with type !== "INTEGRATION"', () => {
		const contexts = [
			{
				type: "DOCUMENT",
				metadata: { provider: "google-drive", fileId: "f1" },
			},
		];

		expect(filterGoogleDriveContexts(contexts)).toHaveLength(0);
	});

	it("filters mixed contexts correctly", () => {
		const contexts = [
			{
				type: "INTEGRATION",
				metadata: { provider: "google-drive", fileId: "f1" },
			},
			{
				type: "INTEGRATION",
				metadata: { provider: "GOOGLE_DOCS", fileId: "f2" },
			},
			{
				type: "INTEGRATION",
				metadata: { provider: "notion", pageId: "p1" },
			},
			{
				type: "DOCUMENT",
				metadata: { provider: "google-drive", fileId: "f3" },
			},
			{
				type: "INTEGRATION",
				metadata: { provider: "google-drive", fileId: "f4" },
			},
		];

		const filtered = filterGoogleDriveContexts(contexts);

		expect(filtered).toHaveLength(2);
		expect((filtered[0].metadata as Record<string, unknown>).fileId).toBe(
			"f1",
		);
		expect((filtered[1].metadata as Record<string, unknown>).fileId).toBe(
			"f4",
		);
	});
});
