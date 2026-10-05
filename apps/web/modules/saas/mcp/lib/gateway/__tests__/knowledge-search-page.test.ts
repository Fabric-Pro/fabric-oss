import type { KnowledgeSearchHit } from "@repo/database/prisma/queries/projects/knowledge-search";
import { describe, expect, it } from "vitest";
import {
	knowledgeSearchFingerprint,
	parseKnowledgeSearchCursor,
	serializeKnowledgeSearchPage,
} from "../knowledge-search";

const fingerprint = knowledgeSearchFingerprint(
	"example-project",
	"example-org",
	"needle",
);
const hit = (id: string): KnowledgeSearchHit => ({
	rank: 1,
	sourceKind: "context_bundle",
	sourceId: id,
	parentContextId: "example-context",
	title: "\u0001".repeat(160),
	excerpt: "\u0002".repeat(480),
	excerptField: "body",
	titleTruncated: true,
	excerptTruncated: true,
	identifier: null,
	sourceType: "INTEGRATION",
	sourceUrl: "https://example.com",
	sourceUrlOmitted: false,
});
describe("complete knowledge search pages", () => {
	it("fits one maximally escaped result in the minimum supported budget", () => {
		const text = serializeKnowledgeSearchPage(
			[hit("example-bundle"), hit("example-next")],
			{
				projectId: "example-project",
				limit: 50,
				maxBytes: 8192,
				fingerprint,
			},
		);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
		const page = JSON.parse(text);
		expect(page.results.length).toBeGreaterThan(0);
		expect(page.results[0]).toMatchObject({
			id: "example-bundle",
			titleTruncated: true,
			excerptTruncated: true,
		});
	});
	it("keeps skipped records eligible when the budget, rather than the row limit, stops a page", () => {
		const text = serializeKnowledgeSearchPage(
			Array.from({ length: 50 }, (_, i) => hit(`bundle-${i}`)),
			{
				projectId: "example-project",
				limit: 50,
				maxBytes: 8192,
				fingerprint,
			},
		);
		const page = JSON.parse(text);
		expect(page.results).toHaveLength(1);
		expect(page.omissionReason).toBe("response_budget");
		expect(
			parseKnowledgeSearchCursor(page.nextCursor, fingerprint),
		).toEqual({
			rank: 1,
			sourceKind: "context_bundle",
			sourceId: "bundle-0",
		});
	});
	it("reports a row limit even when all returned text fits", () => {
		const page = JSON.parse(
			serializeKnowledgeSearchPage([hit("one"), hit("two")], {
				projectId: "example-project",
				limit: 1,
				maxBytes: 12000,
				fingerprint,
			}),
		);
		expect(page).toMatchObject({
			returnedCount: 1,
			hasMore: true,
			omissionReason: "result_limit",
		});
	});
	it("rejects cursor reuse across hosting organizations", () => {
		const page = JSON.parse(
			serializeKnowledgeSearchPage([hit("one"), hit("two")], {
				projectId: "example-project",
				limit: 1,
				maxBytes: 12000,
				fingerprint,
			}),
		);
		expect(() =>
			parseKnowledgeSearchCursor(
				page.nextCursor,
				knowledgeSearchFingerprint(
					"example-project",
					"other-org",
					"needle",
				),
			),
		).toThrow();
	});
	it.each([null, [], "", Buffer.from("{}").toString("base64url")])(
		"rejects malformed cursors %j",
		(value) => {
			expect(() =>
				parseKnowledgeSearchCursor(value, fingerprint),
			).toThrow();
		},
	);
});
