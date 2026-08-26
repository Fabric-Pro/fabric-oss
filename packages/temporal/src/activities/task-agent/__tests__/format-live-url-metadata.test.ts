/**
 * Live-URL prompt formatting for Context Source Type Labeling (Fizzy
 * #1888). Mirrors the @repo/rag contract: unannotated sources format
 * byte-identically to pre-feature output; a labelled source gets a
 * `[Type]` prefix on the heading plus a guidance line under it.
 */
import { describe, expect, it } from "vitest";
import {
	formatLiveUrlSourcesForPrompt,
	type LiveUrlContent,
} from "../rag-context";

function makeItem(overrides: Partial<LiveUrlContent> = {}): LiveUrlContent {
	return {
		sourceUrl: "https://docs.example.com/guide",
		sourceTitle: "Guide",
		content: "# Guide\n\nBody.",
		mode: "live",
		...overrides,
	};
}

describe("formatLiveUrlSourcesForPrompt — no metadata", () => {
	it("keeps the legacy heading shape with no guidance line", () => {
		const out = formatLiveUrlSourcesForPrompt([makeItem()]);
		expect(out).toContain(
			"### Live web source: Guide (https://docs.example.com/guide)\n# Guide",
		);
		expect(out).not.toContain("Source guidance");
		expect(out).toContain("## Live URL content");
	});
});

describe("formatLiveUrlSourcesForPrompt — with metadata", () => {
	it("prefixes the heading with the type and adds the guidance line", () => {
		const out = formatLiveUrlSourcesForPrompt([
			makeItem({
				sourceType: "SDK Docs",
				aiInstructions: "Authoritative API reference.",
			}),
		]);
		expect(out).toContain(
			"### Live web source [SDK Docs]: Guide (https://docs.example.com/guide)",
		);
		expect(out).toContain(
			"> Source guidance: Authoritative API reference.",
		);
	});

	it("keeps the fallback annotation alongside the label", () => {
		const out = formatLiveUrlSourcesForPrompt([
			makeItem({
				mode: "fallback",
				sourceType: "Knowledge Base",
			}),
		]);
		expect(out).toContain(
			"### Live web source [Knowledge Base]: Guide (https://docs.example.com/guide) (re-fetched live; original crawl had failed)",
		);
	});
});
