import { afterEach, describe, expect, it, vi } from "vitest";

// `embed-release-notes.ts` imports "server-only", which resolves to its throwing
// index.js under vitest's default condition (no `react-server` condition is set),
// crashing the import. Stub it to a no-op module.
vi.mock("server-only", () => ({}));

const resolveProjectByEmbedToken = vi.fn();
const listPublicNewsletterArchive = vi.fn();
// Mock the two queries, but keep `newsletterContentSchema` REAL so the helper's
// content validation is exercised against the canonical schema (the same one that
// persists content) — no structural-guard drift. Importing it from the
// lightweight schema module avoids pulling the Prisma client into the test.
vi.mock("@repo/database", async () => {
	const schema = await vi.importActual<
		typeof import("@repo/database/src/newsletter-schema")
	>("@repo/database/src/newsletter-schema");
	return {
		newsletterContentSchema: schema.newsletterContentSchema,
		resolveProjectByEmbedToken: (...a: unknown[]) =>
			resolveProjectByEmbedToken(...a),
		listPublicNewsletterArchive: (...a: unknown[]) =>
			listPublicNewsletterArchive(...a),
	};
});
// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs (a plain
// top-level const is initialized AFTER the hoisted factory → ReferenceError).
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: loggerError },
}));

// A fully-valid NewsletterContent (passes newsletterContentSchema).
const VALID_CONTENT = {
	schemaVersion: 1 as const,
	headline: "Shipped this week",
	intro: "Highlights from the latest release.",
	highlights: [
		{ title: "New dashboard", description: "Faster and clearer." },
	],
	hasMajorFeatures: true,
};

// A resolved project (the renamed shape resolveProjectByEmbedToken returns).
function project(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "proj-1",
		organizationId: "org-1",
		userId: null,
		publicWidgetEnabled: true,
		publicEmbedTokenVersion: 1,
		createdByUserId: "user-1",
		theme: "dark",
		accent: "#9F2A3A",
		config: { showHeadlineOnly: true },
		...overrides,
	};
}

import { getEmbedReleaseNotes } from "./embed-release-notes";

afterEach(() => {
	vi.clearAllMocks();
});

describe("getEmbedReleaseNotes", () => {
	it("returns null for an unknown token and never queries the archive", async () => {
		resolveProjectByEmbedToken.mockResolvedValue(null);
		expect(await getEmbedReleaseNotes("nope")).toBeNull();
		expect(resolveProjectByEmbedToken).toHaveBeenCalledWith("nope");
		expect(listPublicNewsletterArchive).not.toHaveBeenCalled();
	});

	it("returns disabled (empty sends + passthrough presentation) when the widget is off, without querying the archive", async () => {
		resolveProjectByEmbedToken.mockResolvedValue(
			project({ publicWidgetEnabled: false }),
		);
		expect(await getEmbedReleaseNotes("tok")).toEqual({
			enabled: false,
			sends: [],
			theme: "dark",
			accent: "#9F2A3A",
			config: { showHeadlineOnly: true },
		});
		expect(listPublicNewsletterArchive).not.toHaveBeenCalled();
	});

	it("returns up to 5 validated sends, drops malformed rows, and passes presentation through", async () => {
		resolveProjectByEmbedToken.mockResolvedValue(project());
		const valid = {
			id: "s1",
			status: "SENT",
			createdAt: new Date("2026-01-01"),
			content: VALID_CONTENT,
		};
		const malformed = {
			id: "s2",
			status: "PARTIAL",
			createdAt: new Date("2026-01-02"),
			content: { headline: 1, highlights: [null] },
		};
		listPublicNewsletterArchive.mockResolvedValue([valid, malformed]);

		expect(await getEmbedReleaseNotes("tok")).toEqual({
			enabled: true,
			sends: [
				{
					id: "s1",
					status: "SENT",
					createdAt: valid.createdAt,
					content: VALID_CONTENT,
				},
			],
			theme: "dark",
			accent: "#9F2A3A",
			config: { showHeadlineOnly: true },
		});
		// Latest 5 only, from offset 0 — the security bound is the resolved projectId.
		expect(listPublicNewsletterArchive).toHaveBeenCalledWith("proj-1", {
			limit: 5,
			offset: 0,
		});
	});

	it("returns enabled with empty sends when EVERY row is malformed (valid state, not an error)", async () => {
		resolveProjectByEmbedToken.mockResolvedValue(project());
		listPublicNewsletterArchive.mockResolvedValue([
			{
				id: "s1",
				status: "SENT",
				createdAt: new Date("2026-01-01"),
				content: { headline: 1, highlights: [null] },
			},
			{
				id: "s2",
				status: "PARTIAL",
				createdAt: new Date("2026-01-02"),
				content: null,
			},
		]);
		expect(await getEmbedReleaseNotes("tok")).toEqual({
			enabled: true,
			sends: [],
			theme: "dark",
			accent: "#9F2A3A",
			config: { showHeadlineOnly: true },
		});
	});

	it("degrades to enabled + empty sends (and logs) when the archive query rejects", async () => {
		resolveProjectByEmbedToken.mockResolvedValue(project());
		listPublicNewsletterArchive.mockRejectedValue(new Error("db down"));
		expect(await getEmbedReleaseNotes("tok")).toEqual({
			enabled: true,
			sends: [],
			theme: "dark",
			accent: "#9F2A3A",
			config: { showHeadlineOnly: true },
		});
		expect(loggerError).toHaveBeenCalled();
	});
});
