/**
 * Local plain text extractor
 * Handles .txt, .md, .csv, and other text-based files
 */

import { logger } from "@repo/logs";
import type { ExtractionResult, IDocumentExtractor } from "../types";

/**
 * Non-content subtrees whose bodies must never reach a prompt. The trailing
 * `$` alternative makes an unclosed final tag strip to end-of-input rather than
 * not matching at all — a truncated `<script>` is exactly the malformed shape
 * that lands on this path.
 *
 * `[\s\S]` rather than `.` under the `s` flag: `@repo/api` type-checks this
 * file through a tsconfig whose target predates es2018, where `s` is a compile
 * error (TS1501).
 *
 * The `{0,4096}` bound on the open-tag attribute span is load-bearing, not
 * defensive tidiness. Unbounded (`[^>]*`), input carrying many `<script `
 * openings that never close with `>` makes the engine restart a full forward
 * scan at every occurrence: measured 4x per doubling — 3.4 s at 261 KB, 58 s at
 * 1 MB, and `UPLOAD_SIZE_LIMITS.DOCUMENT` allows 20 MB. This runs synchronously
 * on the event loop, and `local-text` honours no deadline, so a Temporal
 * activity timeout cannot pre-empt it — the worker stalls instead of the
 * activity failing. Bounding the span makes the work per start position
 * constant and the whole strip linear. A real open tag carries nowhere near
 * 4 KB of attributes, so output is unchanged. #1684.
 */
const SCRIPT_BODY = /<script\b[^>]{0,4096}>[\s\S]*?(?:<\/script\s*>|$)/gi;
const STYLE_BODY = /<style\b[^>]{0,4096}>[\s\S]*?(?:<\/style\s*>|$)/gi;

/**
 * The raw-text path is the factory's fallback when `LocalHtmlExtractor` throws
 * — and it does throw on input no size cap catches: `html-to-text` walks the
 * DOM recursively, so ~2,125 levels of nesting overflow the stack inside a file
 * of about 23 KB, far below `MAX_HTML_EXTRACTION_BYTES`. Without this strip the
 * degradation hands the model the full raw markup including script bodies,
 * contradicting the one property that justified a dedicated HTML extractor.
 *
 * Stripping here, rather than bounding the parser's depth, is deliberate.
 * `html-to-text`'s `limits.maxDepth` prevents the throw but ellipsizes the deep
 * subtree to `"..."`, which then satisfies the empty-text guard and is stored
 * as a COMPLETED-but-useless context row. Degrading to *stripped* text keeps
 * the failure honest: the reader still gets whatever prose survived. #1684.
 */
function stripNonContentBodies(text: string): string {
	return text.replace(SCRIPT_BODY, "").replace(STYLE_BODY, "");
}

export class LocalTextExtractor implements IDocumentExtractor {
	name = "local-text";
	supportedMimeTypes = [
		"text/plain",
		"text/markdown",
		"text/csv",
		"application/json",
		// .excalidraw diagram files (JSON). Keep in sync with EXCALIDRAW_MIME in
		// @repo/utils. Raw text passthrough is correct for the underlying JSON. #1942.
		"application/vnd.excalidraw+json",
		"application/xml",
		// YAML is UTF-8 text, so the raw passthrough below reads it correctly and
		// no YAML-aware extractor is warranted. Registered here rather than left
		// unclaimed because the context and workspace pickers admit
		// `application/yaml` — an admitted type that no extractor claims stores
		// and then fails, which is why `application/xhtml+xml` stays refused.
		// `text/yaml` and `application/x-yaml` are canonicalized onto this type by
		// extension before extraction, so they need no entry. Fizzy #2149.
		"application/yaml",
		"image/svg+xml",
		// Retained deliberately. LocalHtmlExtractor handles text/html first;
		// this entry is the fallback the factory reaches when HTML defeats that
		// parser, so a malformed file still stores text instead of failing the
		// upload. Removing it turns a graceful degradation into a FAILED row.
		// #1684.
		"text/html",
	];

	async extract(
		buffer: Buffer,
		filename: string,
		options?: Record<string, unknown>,
	): Promise<ExtractionResult> {
		const startTime = Date.now();
		logger.info(`[LocalTextExtractor] Extracting text from ${filename}`);

		try {
			const raw = buffer.toString("utf-8");
			// `ExtractionFactory.extract` stamps the MIME it resolved into the
			// options it hands every extractor, and stamps it last so a caller
			// cannot spoof it. The filename extension is not a substitute: the
			// factory routes on MIME, and this extractor is reached for HTML
			// whose extension it never sees.
			const text =
				options?.mimeType === "text/html"
					? stripNonContentBodies(raw)
					: raw;

			const extractionTime = Date.now() - startTime;
			logger.info(
				`[LocalTextExtractor] Extracted ${text.length} characters in ${extractionTime}ms`,
			);

			return {
				text,
				extractorUsed: this.name,
				extractionTime,
				cost: 0, // Free
				pageCount: undefined,
				hasTables: false,
				hasImages: false,
				metadata: {
					encoding: "utf-8",
				},
			};
		} catch (error) {
			logger.error(
				`[LocalTextExtractor] Failed to extract text: ${error}`,
			);
			throw new Error(
				`Text extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async isAvailable(): Promise<boolean> {
		return true; // Always available (local)
	}

	async estimateCost(_buffer: Buffer): Promise<number> {
		return 0; // Free
	}
}
