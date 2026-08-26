/**
 * Every format an upload surface admits must be claimed by a registered
 * extractor. A type admitted without one trades a clean, immediate refusal for
 * a file that uploads, stores, and then dies at extraction — which is why
 * `application/xhtml+xml` is deliberately kept out of the story-attachment
 * allowlist, and why this rule existed only as a review convention until now.
 *
 * This guard lives in `@repo/rag` rather than alongside the picker-drift guard
 * in `apps/web`, because the assertion is a set comparison between two
 * genuinely independent modules — the vocabularies in `@repo/utils` and the
 * extractor registry here. The drift guard's technique is source-text matching
 * on spelled-out constant names, which cannot express that. Importing both
 * sides is the right shape here precisely because neither side is derived from
 * the other, so the comparison proves something.
 *
 * Scoped to the two non-chat vocabularies on purpose. The story-attachment and
 * AI-chat surfaces admit types no extractor claims — `application/zip`, the
 * legacy Office types, four video types — and widening this guard to them would
 * turn it red on surfaces this change deliberately leaves alone. Fizzy #2149.
 *
 * `@repo/database` and `@repo/ai` are mocked for the same reason
 * `factory-html-ordering.test.ts` mocks them: factory.ts imports the former at
 * module scope for provider configuration, and reaches the latter through the
 * extractors barrel.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getEnabledOrganizationRagProviders: vi.fn().mockResolvedValue([]),
	getEnabledUserRagProviders: vi.fn().mockResolvedValue([]),
	incrementOrganizationRagProviderUsage: vi.fn().mockResolvedValue(undefined),
	incrementUserRagProviderUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

import {
	CONTEXT_UPLOAD_MIME_TYPES,
	WORKSPACE_DOCUMENT_MIME_ALLOWLIST,
} from "@repo/utils";
import { LocalDocxExtractor } from "../extractors/local-docx";
import { LocalHtmlExtractor } from "../extractors/local-html";
import { LocalPdfExtractor } from "../extractors/local-pdf";
import { LocalTextExtractor } from "../extractors/local-text";
import { LocalXlsxExtractor } from "../extractors/local-xlsx";
import { ExtractionFactory } from "../factory";

/** The local extractors, named here rather than reached through the factory's private selection. */
const EXTRACTORS = [
	new LocalPdfExtractor(),
	new LocalDocxExtractor(),
	new LocalHtmlExtractor(),
	new LocalTextExtractor(),
	new LocalXlsxExtractor(),
];

/**
 * Types that a registered extractor claims but cannot actually read. The
 * membership check below can never catch these — a red guard could always be
 * turned green by appending a MIME string to an extractor with no code for the
 * format — so they are named here rather than left implicit.
 *
 * `application/msword` is claimed by LocalDocxExtractor, but mammoth reads
 * OOXML, not the legacy binary `.doc` container. Kept because removing it would
 * drop a format both surfaces accept today.
 */
const CLAIMED_BUT_NOT_EXTRACTABLE = ["application/msword"];

describe("upload vocabularies are covered by registered extractors", () => {
	const supported = new Set(new ExtractionFactory().getSupportedMimeTypes());

	it.each(Object.keys(CONTEXT_UPLOAD_MIME_TYPES))(
		"project context admits %s and an extractor claims it",
		(mimeType) => {
			expect(supported.has(mimeType)).toBe(true);
		},
	);

	it.each([...WORKSPACE_DOCUMENT_MIME_ALLOWLIST])(
		"workspace documents admits %s and an extractor claims it",
		(mimeType) => {
			expect(supported.has(mimeType)).toBe(true);
		},
	);

	it("claims the structured-text formats this ticket admitted", () => {
		// The specific regression: YAML had no extractor at all, and admitting it
		// without registering one is the exact anti-pattern above.
		for (const mimeType of [
			"application/xml",
			"application/json",
			"application/yaml",
		]) {
			expect(supported.has(mimeType)).toBe(true);
		}
	});

	it("keeps the claimed-but-unextractable list to the documented entry", () => {
		// A silent addition here means someone admitted a format the pipeline
		// cannot actually read and papered over it.
		expect(CLAIMED_BUT_NOT_EXTRACTABLE).toEqual(["application/msword"]);
		for (const mimeType of CLAIMED_BUT_NOT_EXTRACTABLE) {
			expect(supported.has(mimeType)).toBe(true);
		}
	});

	it("does not assert against the story-attachment vocabulary", () => {
		// Documents the scope boundary as an executable fact: that surface admits
		// types no extractor claims, and it is out of scope for this change.
		expect(supported.has("application/zip")).toBe(false);
	});
});

describe("the newly admitted formats route where the vocabulary assumes", () => {
	// Coverage above proves a MIME is *claimed*. It does not prove which
	// extractor claims it, and the forced-extension layer in @repo/utils routes
	// on that assumption — so assert the routing itself.
	const extractorsFor = (mimeType: string) =>
		EXTRACTORS.filter((extractor) =>
			extractor.supportedMimeTypes.includes(mimeType),
		).map((extractor) => extractor.name);

	it.each(["application/xml", "application/yaml", "application/json"])(
		"%s is read as raw text",
		(mimeType) => {
			expect(extractorsFor(mimeType)).toContain("local-text");
		},
	);

	it("keeps image/svg+xml on the text path, never OCR or vision", () => {
		// The category and the routing have to agree: SVG is typed FILE and read
		// as text. If it ever reached the image extractors they would not claim
		// its MIME at all, and the upload would fail with "no extractor found"
		// after storing — while its size ceiling silently halved.
		const claimants = extractorsFor("image/svg+xml");

		expect(claimants).toContain("local-text");
		expect(claimants).not.toContain("ocr");
		expect(claimants).not.toContain("ai-vision");
	});
});

describe("YAML extraction, not just YAML registration", () => {
	it("returns the document's text verbatim", async () => {
		// application/yaml is the one MIME this change newly registered. The
		// coverage guard asserts it is claimed; this asserts it actually reads.
		const yaml = "pipeline:\n  - step: build\n    run: pnpm build\n";
		const result = await new LocalTextExtractor().extract(
			Buffer.from(yaml, "utf-8"),
			"pipeline.yaml",
			{ mimeType: "application/yaml" },
		);

		expect(result.text).toBe(yaml);
	});

	it("leaves XML markup intact rather than stripping it", async () => {
		// The product decision behind admitting XML: element names and attribute
		// values carry the meaning, so the HTML strip must not apply here.
		const xml = '<item id="R-001"><title>Ship it</title></item>';
		const result = await new LocalTextExtractor().extract(
			Buffer.from(xml, "utf-8"),
			"req.xml",
			{ mimeType: "application/xml" },
		);

		expect(result.text).toContain("<item");
		expect(result.text).toContain('id="R-001"');
	});
});
