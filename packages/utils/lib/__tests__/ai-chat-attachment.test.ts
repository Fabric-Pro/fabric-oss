import { describe, expect, it } from "vitest";
import {
	AI_CHAT_ALLOWED_EXTENSIONS,
	AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
	AI_CHAT_CLIENT_MIME_TYPES,
	AI_CHAT_DOCUMENT_FORMAT_LABELS,
	AI_CHAT_IMAGE_MIME_TYPES,
	AI_CHAT_MAX_INFLATION_RATIO,
	AI_CHAT_SERVER_ALLOWED_EXTENSIONS,
	AI_CHAT_SERVER_ONLY_MIME_TYPES,
	AI_CHAT_TEXT_MIME_TYPES,
	AI_CHAT_WORKBOOK_SIGNATURE_BYTES,
	applyAiChatTextBudget,
	buildAiChatAcceptAttribute,
	classifyAiChatWorkbook,
	DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	DEFAULT_AI_CHAT_MAX_INFLATED_BYTES,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
	isAiChatWorkbookFilename,
	isClientRenderableAiChatImage,
	isServerOnlyAiChatMime,
} from "../ai-chat-attachment";
import { EXTENSION_MIME, MIME_EXTENSION } from "../attachment";

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** OOXML is a zip: "PK\x03\x04". */
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
/** OLE compound file header — legacy Office, and encrypted OOXML. */
const OLE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);

describe("AI_CHAT_BINARY_DOCUMENT_MIME_TYPES", () => {
	it("accepts xlsx and refuses legacy .xls", () => {
		expect(AI_CHAT_BINARY_DOCUMENT_MIME_TYPES).toContain(XLSX_MIME);
		expect(AI_CHAT_BINARY_DOCUMENT_MIME_TYPES).not.toContain(
			"application/vnd.ms-excel",
		);
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).not.toContain(
			"application/vnd.ms-excel",
		);
	});

	it("keeps text types out of the binary list so they stay client-read", () => {
		// The split drives isBinaryDocument(): a text type here would stop the
		// hook reading it client-side and send it to the server instead.
		expect(AI_CHAT_TEXT_MIME_TYPES).toContain("text/plain");
		expect(AI_CHAT_BINARY_DOCUMENT_MIME_TYPES).not.toContain("text/plain");
		expect(AI_CHAT_BINARY_DOCUMENT_MIME_TYPES).toContain("application/pdf");
	});
});

describe("DEFAULT_AI_CHAT_MIME_ALLOWLIST", () => {
	it("unions every partition, including the server-only types", () => {
		for (const mime of [
			...AI_CHAT_TEXT_MIME_TYPES,
			...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
			...AI_CHAT_IMAGE_MIME_TYPES,
			...AI_CHAT_SERVER_ONLY_MIME_TYPES,
		]) {
			expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).toContain(mime);
		}
	});

	it("admits TIFF, which the server OCRs and the client cannot originate", () => {
		// The server's list carried image/tiff before this module existed;
		// dropping it here would silently reject uploads Nexus makes today.
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).toContain("image/tiff");
	});
});

describe("client set vs server allowlist", () => {
	it("keeps TIFF out of what a client may originate", () => {
		// The hook routes image types through a canvas compressor, and browsers
		// do not decode TIFF. This exclusion is a capability boundary, not drift.
		expect(AI_CHAT_IMAGE_MIME_TYPES).not.toContain("image/tiff");
		expect(AI_CHAT_CLIENT_MIME_TYPES).not.toContain("image/tiff");
	});

	it("keeps the client set a strict subset of what the server admits", () => {
		for (const mime of AI_CHAT_CLIENT_MIME_TYPES) {
			expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).toContain(mime);
		}
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST.length).toBeGreaterThan(
			AI_CHAT_CLIENT_MIME_TYPES.length,
		);
	});

	it("does not let a client originate a server-only type by extension", () => {
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("scan.tif")).toBe(false);
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("scan.tiff")).toBe(false);
	});
});

describe("AI_CHAT_ALLOWED_EXTENSIONS", () => {
	it("matches every accepted extension, xlsx included", () => {
		for (const name of [
			"budget.xlsx",
			"spec.pdf",
			"spec.docx",
			"notes.txt",
			"notes.md",
			"page.html",
			"data.json",
			"shot.jpg",
			"shot.jpeg",
			"shot.png",
			"shot.gif",
			"shot.webp",
		]) {
			expect(AI_CHAT_ALLOWED_EXTENSIONS.test(name)).toBe(true);
		}
	});

	it("rejects unsupported extensions", () => {
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("budget.xls")).toBe(false);
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("archive.zip")).toBe(false);
	});
});

describe("DEFAULT_AI_CHAT_MAX_FILE_BYTES", () => {
	it("caps uploads at 25MB, matching the story-attachment system", () => {
		expect(DEFAULT_AI_CHAT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
	});

	it("keeps the inflation ceiling scaled to the cap", () => {
		// The pair used to be two absolutes, so raising one silently squeezed the
		// headroom a legitimate workbook had to decompress into — until a real
		// spreadsheet was refused by a guard written for zip bombs. Tying them
		// means the next cap change cannot reintroduce that.
		expect(DEFAULT_AI_CHAT_MAX_INFLATED_BYTES).toBe(
			DEFAULT_AI_CHAT_MAX_FILE_BYTES * AI_CHAT_MAX_INFLATION_RATIO,
		);
		expect(AI_CHAT_MAX_INFLATION_RATIO).toBeGreaterThanOrEqual(10);
	});
});

describe("CSV as a chat attachment", () => {
	it("lands in the text partition, not the binary-document one", () => {
		// This placement is the whole safety argument: text formats are read in
		// the browser and bounded by `applyAiChatTextBudget`, while the binary
		// path reaches the deliberately-unbounded ingestion extractor.
		expect(AI_CHAT_TEXT_MIME_TYPES).toContain("text/csv");
		expect(AI_CHAT_BINARY_DOCUMENT_MIME_TYPES).not.toContain("text/csv");
	});

	it("is admitted by the server allowlist and the client set alike", () => {
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).toContain("text/csv");
		expect(AI_CHAT_CLIENT_MIME_TYPES).toContain("text/csv");
	});

	it("is advertised by the picker and passes the filename guard", () => {
		expect(buildAiChatAcceptAttribute().split(",")).toContain(".csv");
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("export.csv")).toBe(true);
	});

	it("appears in the format labels a screen reader announces", () => {
		expect(AI_CHAT_DOCUMENT_FORMAT_LABELS).toContain("CSV");
	});

	it("does not disturb the legacy .xls refusal", () => {
		// AE5. CSV and .xls are both spreadsheet-adjacent; adding one must not
		// quietly admit the other.
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("budget.xls")).toBe(false);
		expect(DEFAULT_AI_CHAT_MIME_ALLOWLIST).not.toContain(
			"application/vnd.ms-excel",
		);
		expect(classifyAiChatWorkbook(OLE_BYTES, "budget.xls")).toBe(
			"legacy-unsupported",
		);
	});
});

describe("buildAiChatAcceptAttribute", () => {
	it("advertises xlsx by extension and by MIME", () => {
		const accept = buildAiChatAcceptAttribute().split(",");
		expect(accept).toContain(".xlsx");
		expect(accept).toContain(XLSX_MIME);
	});

	it("narrows images to the caller's allowlist", () => {
		// The Feature Assistant's shape: jpeg/png only.
		const accept = buildAiChatAcceptAttribute([
			"image/jpeg",
			"image/png",
		]).split(",");
		expect(accept).toContain(".jpg");
		expect(accept).toContain(".jpeg");
		expect(accept).toContain(".png");
		expect(accept).toContain("image/jpeg");
		expect(accept).toContain("image/png");
		expect(accept).not.toContain(".gif");
		expect(accept).not.toContain(".webp");
		expect(accept).not.toContain("image/gif");
		expect(accept).not.toContain("image/webp");
		// Documents are unaffected by image narrowing.
		expect(accept).toContain(".pdf");
		expect(accept).toContain(".xlsx");
	});

	it("falls back to the default image set when the allowlist is empty or absent", () => {
		const fallback = buildAiChatAcceptAttribute();
		expect(buildAiChatAcceptAttribute([])).toBe(fallback);
		expect(buildAiChatAcceptAttribute(undefined)).toBe(fallback);
		for (const mime of AI_CHAT_IMAGE_MIME_TYPES) {
			expect(fallback.split(",")).toContain(mime);
		}
		expect(fallback.split(",")).toContain(".gif");
		expect(fallback.split(",")).toContain(".webp");
	});
});

describe("classifyAiChatWorkbook", () => {
	it("accepts a zip-signed .xlsx", () => {
		expect(classifyAiChatWorkbook(ZIP_BYTES, "budget.xlsx")).toBe(
			"accepted",
		);
	});

	it("classifies an OLE-signed .xls as legacy-unsupported", () => {
		// R3: a genuine BIFF workbook. Its copy names .xlsx as supported.
		expect(classifyAiChatWorkbook(OLE_BYTES, "budget.xls")).toBe(
			"legacy-unsupported",
		);
	});

	it("classifies an OLE-signed .xlsx as likely password-protected", () => {
		// R11: encrypted OOXML is an OLE container wrapping the real archive.
		// "likely" because OLE is shared with .doc/.ppt/.msg — see the module.
		expect(classifyAiChatWorkbook(OLE_BYTES, "budget.xlsx")).toBe(
			"likely-password-protected",
		);
	});

	it("classifies random bytes named .xlsx as unreadable", () => {
		// R12: neither container signature — nothing can parse this.
		expect(
			classifyAiChatWorkbook(
				new Uint8Array([0x13, 0x37, 0x42, 0x99]),
				"budget.xlsx",
			),
		).toBe("unreadable");
	});

	it("classifies input shorter than the signature as unreadable, not a throw", () => {
		// A truncated read must not be mistaken for a match on a shorter prefix.
		expect(classifyAiChatWorkbook(new Uint8Array([]), "budget.xlsx")).toBe(
			"unreadable",
		);
		expect(
			classifyAiChatWorkbook(new Uint8Array([0xd0]), "budget.xlsx"),
		).toBe("unreadable");
		expect(
			classifyAiChatWorkbook(new Uint8Array([0xd0]), "budget.xls"),
		).toBe("unreadable");
	});

	it("does not gate non-workbook formats whatever their bytes", () => {
		// The classifier speaks only about .xls/.xlsx. A PDF is neither zip nor
		// OLE; were it in scope, every PDF attachment would read as unreadable.
		for (const name of [
			"spec.pdf",
			"spec.docx",
			"notes.txt",
			"shot.png",
			"noextension",
		]) {
			expect(
				classifyAiChatWorkbook(
					new Uint8Array([0x25, 0x50, 0x44, 0x46]),
					name,
				),
			).toBe("accepted");
			expect(classifyAiChatWorkbook(OLE_BYTES, name)).toBe("accepted");
			expect(classifyAiChatWorkbook(new Uint8Array([]), name)).toBe(
				"accepted",
			);
		}
	});

	it("reads the extension case-insensitively", () => {
		expect(classifyAiChatWorkbook(OLE_BYTES, "BUDGET.XLS")).toBe(
			"legacy-unsupported",
		);
		expect(classifyAiChatWorkbook(ZIP_BYTES, "BUDGET.XLSX")).toBe(
			"accepted",
		);
	});

	it("reads a Buffer as-is, so server callers need no conversion", () => {
		// Buffer extends Uint8Array; process-document/upload pass a subarray.
		expect(
			classifyAiChatWorkbook(
				Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]).subarray(
					0,
					AI_CHAT_WORKBOOK_SIGNATURE_BYTES,
				),
				"budget.xlsx",
			),
		).toBe("likely-password-protected");
	});
});

describe("isAiChatWorkbookFilename", () => {
	it("covers exactly the extensions the classifier branches on", () => {
		expect(isAiChatWorkbookFilename("budget.xlsx")).toBe(true);
		expect(isAiChatWorkbookFilename("budget.xls")).toBe(true);
		expect(isAiChatWorkbookFilename("budget.XLSX")).toBe(true);
		expect(isAiChatWorkbookFilename("spec.pdf")).toBe(false);
		expect(isAiChatWorkbookFilename("shot.png")).toBe(false);
		expect(isAiChatWorkbookFilename("noextension")).toBe(false);
	});

	it("agrees with the classifier on what it will not gate", () => {
		// The hook skips the byte read for anything this predicate refuses, so a
		// disagreement here would starve a real workbook of its signature.
		for (const name of [
			"spec.pdf",
			"notes.txt",
			"shot.png",
			"archive.zip",
		]) {
			expect(isAiChatWorkbookFilename(name)).toBe(false);
			expect(classifyAiChatWorkbook(new Uint8Array([]), name)).toBe(
				"accepted",
			);
		}
	});
});

describe("AI_CHAT_WORKBOOK_SIGNATURE_BYTES", () => {
	it("is long enough for the widest signature the classifier matches", () => {
		// 4 bytes: the OLE header. Shrink this and OLE stops being detectable,
		// silently turning every R11/R3 rejection into "unreadable".
		expect(AI_CHAT_WORKBOOK_SIGNATURE_BYTES).toBe(4);
		expect(
			classifyAiChatWorkbook(
				OLE_BYTES.subarray(0, AI_CHAT_WORKBOOK_SIGNATURE_BYTES),
				"budget.xlsx",
			),
		).toBe("likely-password-protected");
	});
});

describe("AI_CHAT_DOCUMENT_FORMAT_LABELS", () => {
	it("names every document format the picker accepts", () => {
		expect(AI_CHAT_DOCUMENT_FORMAT_LABELS).toEqual([
			"PDF",
			"DOCX",
			"XLSX",
			"TXT",
			"MD",
			"HTML",
			"JSON",
			"CSV",
		]);
	});

	it("stays in step with the vocabulary rather than being hand-kept", () => {
		// The label is an aria-label: a stale one tells a screen-reader user a
		// supported format is unsupported. It drifted before — advertising
		// "PDF, DOCX, TXT, MD" while HTML and JSON were already accepted — so
		// this asserts the derivation, not a copy of the string.
		const expected = [
			...AI_CHAT_BINARY_DOCUMENT_MIME_TYPES,
			...AI_CHAT_TEXT_MIME_TYPES,
		].length;
		expect(AI_CHAT_DOCUMENT_FORMAT_LABELS).toHaveLength(expected);
	});

	it("leaves images out — they narrow per surface", () => {
		for (const label of ["PNG", "JPG", "JPEG", "GIF", "WEBP", "TIFF"]) {
			expect(AI_CHAT_DOCUMENT_FORMAT_LABELS).not.toContain(label);
		}
	});
});

describe("extension <-> MIME lookup", () => {
	it("round-trips xlsx in both directions", () => {
		expect(EXTENSION_MIME.xlsx).toBe(XLSX_MIME);
		expect(MIME_EXTENSION[XLSX_MIME]).toBe("xlsx");
	});
});

describe("extension guards — client vs server", () => {
	it("keeps the client guard free of the server-only formats", () => {
		// A canvas-compressing client cannot originate a TIFF, so admitting the
		// extension here would hand one to a canvas that cannot decode it.
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("scan.tiff")).toBe(false);
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("scan.tif")).toBe(false);
	});

	it("admits the server-only formats through the server guard", () => {
		// Surfaces that run no canvas step need this wider guard: paste and drop
		// deliver files with an empty `type`, so the extension is the only signal
		// left and the narrow list would refuse a file the server accepts.
		expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test("scan.tiff")).toBe(true);
		expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test("scan.tif")).toBe(true);
	});

	it("agrees with the client guard on everything else", () => {
		for (const name of ["a.pdf", "a.docx", "a.xlsx", "a.md", "a.png"]) {
			expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test(name)).toBe(true);
			expect(AI_CHAT_ALLOWED_EXTENSIONS.test(name)).toBe(true);
		}
	});

	it("refuses an unsupported extension through both", () => {
		expect(AI_CHAT_ALLOWED_EXTENSIONS.test("payload.exe")).toBe(false);
		expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test("payload.exe")).toBe(
			false,
		);
	});

	it("is stateless — repeated calls do not alternate", () => {
		// A `g`-flagged RegExp carries `lastIndex` between `.test()` calls, which
		// makes a shared module-level guard return false every other time.
		for (let i = 0; i < 4; i++) {
			expect(AI_CHAT_SERVER_ALLOWED_EXTENSIONS.test("notes.md")).toBe(
				true,
			);
		}
	});
});

describe("client-renderable vs server-only images", () => {
	it("admits the formats a browser can decode", () => {
		for (const mime of AI_CHAT_IMAGE_MIME_TYPES) {
			expect(isClientRenderableAiChatImage(mime)).toBe(true);
			expect(isServerOnlyAiChatMime(mime)).toBe(false);
		}
	});

	it("refuses TIFF the client cannot decode", () => {
		// The trap this predicate exists to close: the upload path gates canvas
		// compression and the `data:` URL read on "is this an image", which is
		// only safe while the caller's list stops short of TIFF. A surface that
		// accepts TIFF and reuses an image-prefix test hands a canvas an image it
		// cannot decode, then ships a `data:image/tiff` vision part the model
		// rejects — the visible failure lands at the API, far from the cause.
		expect(isClientRenderableAiChatImage("image/tiff")).toBe(false);
		expect(isServerOnlyAiChatMime("image/tiff")).toBe(true);
	});

	it("is not a prefix test", () => {
		// `mime.startsWith("image/")` is the shape that breaks; this must not be
		// equivalent to it.
		expect(isClientRenderableAiChatImage("image/tiff")).toBe(false);
		expect(isClientRenderableAiChatImage("image/avif")).toBe(false);
		expect(isClientRenderableAiChatImage("image/heic")).toBe(false);
	});

	it("says nothing about non-images", () => {
		expect(isClientRenderableAiChatImage("application/pdf")).toBe(false);
		expect(isServerOnlyAiChatMime("application/pdf")).toBe(false);
	});
});

describe("applyAiChatTextBudget", () => {
	const BUDGET = DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS;

	it("passes text under the budget through byte-for-byte", () => {
		const text = "# Title\n\nbody with <angle> brackets & an ] bracket";
		const result = applyAiChatTextBudget(text);

		expect(result.text).toBe(text);
		expect(result.outcome).toEqual({ status: "extracted", sheets: [] });
	});

	it("cuts at the budget and appends a marker naming the counts", () => {
		const result = applyAiChatTextBudget("x".repeat(BUDGET + 250));

		expect(result.outcome).toEqual({
			status: "truncated",
			sheets: [],
			reason: "budget",
			omittedCharCount: 250,
		});
		expect(result.text).toBe(
			`${"x".repeat(BUDGET)}\n\n[Document truncated — 250 of 100,250 characters omitted]`,
		);
	});

	it("honours a caller-supplied budget, because ingestion supplies none", () => {
		// R4 depends on this being an argument rather than a baked-in default:
		// the ingestion extractors call no budgeting at all, and a default that
		// lived inside the reader would cut knowledge-base documents mid-ingest.
		const result = applyAiChatTextBudget("abcdefghij", 4);

		expect(result.text.startsWith("abcd")).toBe(true);
		expect(result.outcome).toMatchObject({
			status: "truncated",
			omittedCharCount: 6,
		});
	});

	it("does not ship half a surrogate pair when the cut lands mid-character", () => {
		// Slicing counts UTF-16 code units, so a budget that ends between the two
		// halves of an emoji would otherwise emit a lone surrogate — not a
		// character, and rejected outright by some tokenizers.
		const result = applyAiChatTextBudget(`ab${"😀".repeat(4)}`, 3);

		expect(result.text.startsWith("ab")).toBe(true);
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.text)).toBe(
			false,
		);
	});

	it("reports blank text as empty rather than as a bound being hit", () => {
		const result = applyAiChatTextBudget("   \n\t  ");

		expect(result.outcome).toEqual({ status: "empty", sheets: [] });
		expect(result.text).toBe("   \n\t  ");
	});

	it("treats a file exactly at the budget as complete", () => {
		const result = applyAiChatTextBudget("y".repeat(BUDGET));

		expect(result.outcome).toEqual({ status: "extracted", sheets: [] });
		expect(result.text).toHaveLength(BUDGET);
	});
});
