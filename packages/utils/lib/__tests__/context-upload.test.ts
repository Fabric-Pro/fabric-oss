import { describe, expect, it } from "vitest";
import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	CONTEXT_UPLOAD_FORMAT_LABELS,
	CONTEXT_UPLOAD_MIME_TYPES,
	contextUploadConfigFor,
	resolveContextUploadCategory,
	resolveContextUploadMime,
} from "../context-upload";
import { UPLOAD_SIZE_LIMITS } from "../upload-size-limits";

describe("resolveContextUploadMime", () => {
	it("normalizes .excalidraw with an empty browser mime", () => {
		expect(resolveContextUploadMime("", "board.excalidraw")).toBe(
			"application/vnd.excalidraw+json",
		);
	});
	it("normalizes .excalidraw reported as octet-stream", () => {
		expect(
			resolveContextUploadMime(
				"application/octet-stream",
				"board.excalidraw",
			),
		).toBe("application/vnd.excalidraw+json");
	});
	it("still rescues the legacy Excel mime for .csv and .xlsx", () => {
		expect(
			resolveContextUploadMime("application/vnd.ms-excel", "a.csv"),
		).toBe("text/csv");
		expect(
			resolveContextUploadMime("application/vnd.ms-excel", "a.xlsx"),
		).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
	});
	it("passes through an ordinary mime unchanged", () => {
		expect(resolveContextUploadMime("application/pdf", "a.pdf")).toBe(
			"application/pdf",
		);
	});
});

describe("untyped uploads resolve by extension", () => {
	// Fizzy #2139. The picker advertises sixteen extensions; before this, four
	// were rescued by hand and the other twelve were refused whenever the OS
	// gave the browser no MIME to report. Derive the cases from the accept
	// attribute so a format added later cannot skip this table.
	const advertisedExtensions = CONTEXT_UPLOAD_ACCEPT_ATTR.split(",").map(
		(ext) => ext.replace(/^\./, ""),
	);
	const untypedMimes = ["", "application/octet-stream"];

	it.each(
		advertisedExtensions.flatMap((ext) =>
			untypedMimes.map((mime) => [ext, mime] as const),
		),
	)("resolves .%s reported as %j", (ext, mime) => {
		const resolved = resolveContextUploadMime(mime, `design.${ext}`);
		expect(CONTEXT_UPLOAD_MIME_TYPES[resolved]).toBeDefined();
	});

	it("prefers a recognised declared mime over the extension", () => {
		expect(resolveContextUploadMime("application/pdf", "notes.md")).toBe(
			"application/pdf",
		);
	});

	it("keeps the forced canonical type ahead of a recognised declared mime", () => {
		// .html and .excalidraw are canonicalized by extension on purpose: the
		// declared type is routinely wrong for them, and believing it would send
		// HTML bytes to the PDF extractor.
		expect(resolveContextUploadMime("application/pdf", "page.html")).toBe(
			"text/html",
		);
		expect(resolveContextUploadMime("text/plain", "board.excalidraw")).toBe(
			"application/vnd.excalidraw+json",
		);
	});

	it("refuses a name with no extension", () => {
		// "html" and "excalidraw" are the cases the forced branch would accept if
		// it kept splitting on "." and taking the last part — that returns the
		// whole name when there is no dot.
		for (const name of ["PDF", "Makefile", "html", "excalidraw"]) {
			expect(
				CONTEXT_UPLOAD_MIME_TYPES[resolveContextUploadMime("", name)],
			).toBeUndefined();
		}
	});

	it("rescues the alias extensions", () => {
		expect(resolveContextUploadMime("", "photo.jpeg")).toBe("image/jpeg");
		expect(resolveContextUploadMime("", "page.htm")).toBe("text/html");
		expect(resolveContextUploadMime("", "page.xhtml")).toBe("text/html");
	});

	it("takes the last extension when a name carries several", () => {
		expect(resolveContextUploadMime("", "notes.md.txt")).toBe("text/plain");
	});

	it("matches the extension case-insensitively", () => {
		expect(resolveContextUploadMime("", "DESIGN.MD")).toBe("text/markdown");
	});

	it("refuses an unadvertised extension", () => {
		for (const name of ["archive.tar.gz", "archive.rar", "notes.md."]) {
			expect(
				CONTEXT_UPLOAD_MIME_TYPES[resolveContextUploadMime("", name)],
			).toBeUndefined();
		}
	});

	it("refuses extensions the shared reverse map carries but this surface does not", () => {
		// EXTENSION_MIME is a superset — it knows .zip and .mp4. Composing it with
		// this surface's allowlist is what keeps them out.
		for (const name of ["archive.zip", "clip.mp4", "deck.pptx"]) {
			expect(
				CONTEXT_UPLOAD_MIME_TYPES[resolveContextUploadMime("", name)],
			).toBeUndefined();
		}
	});

	it("refuses a MIME that is only an inherited object key", () => {
		// A plain-object index is truthy for `constructor`/`toString`, so a gate
		// written as `if (!MAP[mime])` would admit these — and then read
		// `undefined` for the size category, which every comparison passes.
		for (const mime of [
			"constructor",
			"toString",
			"__proto__",
			"valueOf",
		]) {
			expect(contextUploadConfigFor(mime)).toBeUndefined();
		}
	});

	it("refuses an extension that is only an inherited object key", () => {
		for (const name of ["x.constructor", "x.toString", "x.valueOf"]) {
			expect(
				contextUploadConfigFor(resolveContextUploadMime("", name)),
			).toBeUndefined();
		}
	});

	it("still refuses a genuine legacy .xls", () => {
		// The deleted ms-excel branch resolved .csv and .xlsx by extension. A
		// real .xls must stay refused — this is the case that catches a botched
		// deletion, since the two positive cases pass either way.
		expect(
			CONTEXT_UPLOAD_MIME_TYPES[
				resolveContextUploadMime("application/vnd.ms-excel", "book.xls")
			],
		).toBeUndefined();
	});
});

describe("CONTEXT_UPLOAD_MIME_TYPES", () => {
	it("types .excalidraw as a downloadable FILE with the excalidraw extension", () => {
		// toMatchObject rather than toEqual: entries now also carry the
		// alias-extension and force-by-extension fields the shared core added,
		// and this assertion is about the category and stored extension.
		expect(
			CONTEXT_UPLOAD_MIME_TYPES["application/vnd.excalidraw+json"],
		).toMatchObject({ type: "FILE", extension: "excalidraw" });
	});
	it("keeps the existing pdf/xlsx entries", () => {
		expect(CONTEXT_UPLOAD_MIME_TYPES["application/pdf"].type).toBe(
			"DOCUMENT",
		);
		expect(
			CONTEXT_UPLOAD_MIME_TYPES[
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
			].type,
		).toBe("SPREADSHEET");
	});
});

describe("html support", () => {
	it("types html as a downloadable FILE with the html extension", () => {
		// FILE is what yields the 20 MB global cap — the size Key Decision on
		// the card.
		expect(CONTEXT_UPLOAD_MIME_TYPES["text/html"]).toMatchObject({
			type: "FILE",
			extension: "html",
		});
	});

	it("resolves to the 20 MB global cap", () => {
		// The `type: "FILE"` assertion above is not load-bearing on its own —
		// DOCUMENT is also 20 MB today, so a later re-categorization would not
		// trip it. Assert the resolved limit itself.
		expect(
			UPLOAD_SIZE_LIMITS[CONTEXT_UPLOAD_MIME_TYPES["text/html"].type],
		).toBe(20 * 1024 * 1024);
	});

	it("canonicalizes all three html extensions to text/html", () => {
		expect(resolveContextUploadMime("text/html", "a.html")).toBe(
			"text/html",
		);
		expect(resolveContextUploadMime("text/html", "a.htm")).toBe(
			"text/html",
		);
		expect(
			resolveContextUploadMime("application/xhtml+xml", "a.xhtml"),
		).toBe("text/html");
	});

	it("canonicalizes html reported as empty or octet-stream", () => {
		expect(resolveContextUploadMime("", "a.html")).toBe("text/html");
		expect(
			resolveContextUploadMime("application/octet-stream", "a.htm"),
		).toBe("text/html");
	});

	it("is case-insensitive on the extension", () => {
		expect(resolveContextUploadMime("", "REPORT.HTML")).toBe("text/html");
	});
});

describe("derived context upload vocabulary", () => {
	// The accept attribute and the server's error copy must come from the same
	// place as the validation gate. Four hand-kept copies of this list existed
	// before #1684 and two of them had already drifted.
	it("advertises every allowlisted extension, including the html aliases", () => {
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".pdf");
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".excalidraw");
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".html");
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".htm");
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".xhtml");
	});

	it("keeps advertising .jpeg alongside .jpg", () => {
		// image/jpeg's canonical extension is "jpg", but the picker has always
		// advertised both. Deriving naively from `extension` would silently drop
		// .jpeg and break a working upload.
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".jpg");
		expect(CONTEXT_UPLOAD_ACCEPT_ATTR).toContain(".jpeg");
	});

	it("emits uppercase format labels for user-facing error copy", () => {
		expect(CONTEXT_UPLOAD_FORMAT_LABELS).toContain("PDF");
		expect(CONTEXT_UPLOAD_FORMAT_LABELS).toContain("HTML");
		expect(CONTEXT_UPLOAD_FORMAT_LABELS).toContain("EXCALIDRAW");
	});

	it("still advertises every extension the hardcoded string did", () => {
		// The string these replaced, preserved here as the regression bar. A
		// derivation that drops one of these silently breaks a working upload.
		for (const ext of [
			".pdf",
			".doc",
			".docx",
			".txt",
			".md",
			".jpg",
			".jpeg",
			".png",
			".webp",
			".svg",
			".xlsx",
			".csv",
			".excalidraw",
		]) {
			expect(CONTEXT_UPLOAD_ACCEPT_ATTR.split(",")).toContain(ext);
		}
	});
});

describe("resolveContextUploadCategory", () => {
	it("sizes an untyped file by its resolved type, not the placeholder", () => {
		// The placeholder the clients substitute for an empty `File.type` would
		// fall through to FILE (20 MB) and let an oversize image reach the
		// server. #2139.
		expect(
			resolveContextUploadCategory(
				"application/octet-stream",
				"photo.png",
			).category,
		).toBe("IMAGE");
		expect(resolveContextUploadCategory("", "design.md").category).toBe(
			"FILE",
		);
		expect(resolveContextUploadCategory("", "report.pdf").category).toBe(
			"DOCUMENT",
		);
		expect(resolveContextUploadCategory("", "data.csv").category).toBe(
			"SPREADSHEET",
		);
	});

	it("sizes svg against this surface's own map", () => {
		// The retired `resolveUploadCategory` classified every `image/*` as
		// IMAGE (10 MB); this surface's allowlist types svg as FILE (20 MB).
		// The server sizes from the allowlist, so the client must too.
		expect(resolveContextUploadCategory("", "diagram.svg")).toEqual({
			resolvedMimeType: "image/svg+xml",
			category: "FILE",
		});
	});

	it("falls back to FILE for a type it cannot resolve", () => {
		expect(resolveContextUploadCategory("", "archive.rar").category).toBe(
			"FILE",
		);
	});

	it("returns the resolved type alongside the category", () => {
		expect(resolveContextUploadCategory("", "design.md")).toEqual({
			resolvedMimeType: "text/markdown",
			category: "FILE",
		});
	});
});

describe("structured-text formats (Fizzy #2149)", () => {
	it("admits XML, JSON and YAML", () => {
		for (const mimeType of [
			"application/xml",
			"application/json",
			"application/yaml",
		]) {
			expect(contextUploadConfigFor(mimeType)).toBeDefined();
		}
	});

	it("canonicalizes alias spellings onto one MIME per format", () => {
		// One MIME per format is what keeps extraction working: the factory
		// matches the exact string, so admitting `text/xml` alongside
		// `application/xml` would route half the uploads to no extractor.
		expect(resolveContextUploadMime("text/xml", "data.xml")).toBe(
			"application/xml",
		);
		expect(resolveContextUploadMime("", "pipeline.yml")).toBe(
			"application/yaml",
		);
		expect(
			resolveContextUploadMime("application/x-yaml", "pipeline.yaml"),
		).toBe("application/yaml");
		expect(resolveContextUploadMime("text/plain", "config.json")).toBe(
			"application/json",
		);
	});

	it("advertises both YAML extensions", () => {
		const advertised = CONTEXT_UPLOAD_ACCEPT_ATTR.split(",");
		expect(advertised).toContain(".yaml");
		expect(advertised).toContain(".yml");
	});

	it("labels the new formats for the picker copy", () => {
		for (const label of ["XML", "JSON", "YAML"]) {
			expect(CONTEXT_UPLOAD_FORMAT_LABELS).toContain(label);
		}
	});

	it("types them as FILE, the 20 MB bucket the other text formats use", () => {
		for (const mimeType of [
			"application/xml",
			"application/json",
			"application/yaml",
		]) {
			expect(contextUploadConfigFor(mimeType)?.type).toBe("FILE");
		}
	});
});

describe("SVG is not captured by the XML admission", () => {
	// The regression this guards: `image/svg+xml` is SVG's declared type, but a
	// browser may also declare an .svg as application/xml. Once XML joined the
	// allowlist, the declared-type-wins branch would have resolved that file to
	// application/xml — dropping SVG's own entry, its FILE category and its
	// existing routing. Forcing .svg by extension is what keeps this true.
	it.each(["", "application/octet-stream", "application/xml", "text/xml"])(
		"resolves diagram.svg declared as %j to image/svg+xml",
		(declared) => {
			expect(resolveContextUploadMime(declared, "diagram.svg")).toBe(
				"image/svg+xml",
			);
		},
	);

	it("keeps SVG in the FILE category, not IMAGE", () => {
		// FILE is deliberate and pre-existing: SVG is read as text by
		// LocalTextExtractor, not sent to OCR/vision. Re-typing it IMAGE would
		// drop its ceiling from 20 MB to 10 MB and route it to extractors that
		// do not claim its MIME.
		expect(
			resolveContextUploadCategory("application/xml", "diagram.svg"),
		).toEqual({ resolvedMimeType: "image/svg+xml", category: "FILE" });
	});
});

describe("formats without an extractor stay refused", () => {
	it.each([
		["deck.pptx", ""],
		["book.xls", "application/vnd.ms-excel"],
		["page.weird", "application/xhtml+xml"],
		["archive.rar", "application/octet-stream"],
	])("refuses %s declared as %j", (filename, declared) => {
		expect(
			contextUploadConfigFor(
				resolveContextUploadMime(declared, filename),
			),
		).toBeUndefined();
	});
});
