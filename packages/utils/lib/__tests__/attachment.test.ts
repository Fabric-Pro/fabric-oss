import { describe, expect, it } from "vitest";
import {
	ATTACHMENT_ACCEPT_ATTR,
	buildContentDisposition,
	DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
	EXCALIDRAW_MIME,
	EXTENSION_MIME,
	extensionForMime,
	isAllowedMime,
	isValidExcalidrawContent,
	MIME_EXTENSION,
	resolveAttachmentMime,
	sanitizeAttachmentFilename,
	TEXT_ATTACHMENT_ACCEPT_ATTR,
	TEXT_ATTACHMENT_MIME_ALLOWLIST,
} from "../attachment";

describe("extensionForMime", () => {
	it("maps known mimes to extensions", () => {
		expect(extensionForMime("application/pdf")).toBe("pdf");
		expect(extensionForMime("image/png")).toBe("png");
	});
	it("returns null for unknown mime", () => {
		expect(extensionForMime("application/x-msdownload")).toBeNull();
	});
});

describe("isAllowedMime", () => {
	it("accepts allowlisted mime", () => {
		expect(
			isAllowedMime("application/pdf", DEFAULT_ATTACHMENT_MIME_ALLOWLIST),
		).toBe(true);
	});
	it("rejects non-allowlisted mime", () => {
		expect(
			isAllowedMime(
				"application/x-msdownload",
				DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe(false);
	});
	it("fails closed on an empty allowlist", () => {
		expect(isAllowedMime("application/pdf", [])).toBe(false);
	});
});

describe("sanitizeAttachmentFilename", () => {
	it("strips path separators and keeps the basename", () => {
		expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitizeAttachmentFilename("a\\b\\c.pdf")).toBe("c.pdf");
	});
	it("strips CR/LF/NUL/control chars and double-quotes", () => {
		expect(sanitizeAttachmentFilename('a"b\r\nc\x00.pdf')).toBe("abc.pdf");
	});
	it("caps length at 255", () => {
		const long = `${"x".repeat(300)}.pdf`;
		expect(sanitizeAttachmentFilename(long).length).toBeLessThanOrEqual(
			255,
		);
	});
	it("falls back to 'file' when empty after sanitizing", () => {
		expect(sanitizeAttachmentFilename("///")).toBe("file");
		expect(sanitizeAttachmentFilename("")).toBe("file");
	});
});

describe("buildContentDisposition", () => {
	it("emits an ascii filename and an rfc5987 filename* for non-ascii", () => {
		const header = buildContentDisposition("résumé.pdf");
		expect(header).toContain('attachment; filename="');
		expect(header).toContain("filename*=UTF-8''");
		expect(header).toContain("r%C3%A9sum%C3%A9.pdf");
	});
	it("a CRLF/quote-laced name cannot break out of the header", () => {
		const header = buildContentDisposition('x"\r\nSet-Cookie: y.pdf');
		expect(header).not.toContain("\r");
		expect(header).not.toContain("\n");
		// the quoted segment contains no raw double-quote other than the delimiters
		const quoted = header.slice(
			header.indexOf('filename="') + 10,
			header.indexOf('";'),
		);
		expect(quoted).not.toContain('"');
	});
});

describe("expanded allowlist (card #1778)", () => {
	it("includes markdown and the four video types", () => {
		for (const m of [
			"text/markdown",
			"video/mp4",
			"video/quicktime",
			"video/x-msvideo",
			"video/webm",
		]) {
			expect(DEFAULT_ATTACHMENT_MIME_ALLOWLIST).toContain(m);
		}
	});
});

describe("resolveAttachmentMime", () => {
	const allow = DEFAULT_ATTACHMENT_MIME_ALLOWLIST;
	it("passes through an allowlisted browser mime", () => {
		expect(resolveAttachmentMime("a.png", "image/png", allow)).toBe(
			"image/png",
		);
	});
	it("strips charset params before matching", () => {
		expect(
			resolveAttachmentMime(
				"a.md",
				"text/markdown; charset=utf-8",
				allow,
			),
		).toBe("text/markdown");
	});
	it("resolves .md by extension when the browser mime is empty", () => {
		expect(resolveAttachmentMime("notes.md", "", allow)).toBe(
			"text/markdown",
		);
	});
	it("resolves .md by extension when the browser mime is octet-stream", () => {
		expect(
			resolveAttachmentMime(
				"notes.md",
				"application/octet-stream",
				allow,
			),
		).toBe("text/markdown");
	});
	it("resolves each video extension", () => {
		expect(resolveAttachmentMime("clip.mp4", "", allow)).toBe("video/mp4");
		expect(resolveAttachmentMime("clip.mov", "", allow)).toBe(
			"video/quicktime",
		);
		expect(resolveAttachmentMime("clip.avi", "", allow)).toBe(
			"video/x-msvideo",
		);
		expect(resolveAttachmentMime("clip.webm", "", allow)).toBe(
			"video/webm",
		);
	});
	it("treats jpg and jpeg as image/jpeg", () => {
		expect(resolveAttachmentMime("p.jpg", "", allow)).toBe("image/jpeg");
		expect(resolveAttachmentMime("p.jpeg", "", allow)).toBe("image/jpeg");
	});
	it("returns null for an unknown extension and unallowed mime", () => {
		expect(
			resolveAttachmentMime(
				"evil.exe",
				"application/x-msdownload",
				allow,
			),
		).toBeNull();
	});
	it("fails closed on an empty allowlist even with a known extension", () => {
		expect(
			resolveAttachmentMime("notes.md", "text/markdown", []),
		).toBeNull();
	});
});

describe("EXTENSION_MIME / ATTACHMENT_ACCEPT_ATTR", () => {
	it("maps md to text/markdown", () => {
		expect(EXTENSION_MIME.md).toBe("text/markdown");
	});
	it("accept attr lists dotted extensions incl .md and .mp4", () => {
		expect(ATTACHMENT_ACCEPT_ATTR).toContain(".md");
		expect(ATTACHMENT_ACCEPT_ATTR).toContain(".mp4");
	});
});

describe("TEXT_ATTACHMENT_MIME_ALLOWLIST (create-flow narrowed set)", () => {
	it("contains docx, xlsx, markdown, plain text, and excalidraw", () => {
		expect([...TEXT_ATTACHMENT_MIME_ALLOWLIST].sort()).toEqual(
			[
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				"text/markdown",
				"text/plain",
				"application/vnd.excalidraw+json",
			].sort(),
		);
	});
	it("resolves a .xlsx now that spreadsheets reach ticket AI context", () => {
		expect(
			resolveAttachmentMime(
				"budget.xlsx",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
	});
	it("resolves an empty-mime .md via the extension rescue", () => {
		expect(
			resolveAttachmentMime(
				"notes.md",
				"",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe("text/markdown");
	});
	it("resolves a .txt and a .docx", () => {
		expect(
			resolveAttachmentMime(
				"readme.txt",
				"text/plain",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe("text/plain");
		expect(
			resolveAttachmentMime(
				"spec.docx",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
	});
	it("rejects types outside the narrowed set (pdf, csv, png)", () => {
		expect(
			resolveAttachmentMime(
				"a.pdf",
				"application/pdf",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBeNull();
		expect(
			resolveAttachmentMime(
				"a.csv",
				"text/csv",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBeNull();
		expect(
			resolveAttachmentMime(
				"a.png",
				"image/png",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBeNull();
	});
});

describe("TEXT_ATTACHMENT_ACCEPT_ATTR", () => {
	it("is the docx/xlsx/md/txt extensions plus .excalidraw", () => {
		expect(TEXT_ATTACHMENT_ACCEPT_ATTR).toBe(
			".docx,.xlsx,.md,.txt,.excalidraw",
		);
	});
});

describe("excalidraw support", () => {
	it("EXCALIDRAW_MIME is the custom vendor json mime", () => {
		expect(EXCALIDRAW_MIME).toBe("application/vnd.excalidraw+json");
	});
	it("is in the default allowlist", () => {
		expect(DEFAULT_ATTACHMENT_MIME_ALLOWLIST).toContain(EXCALIDRAW_MIME);
	});
	it("maps the excalidraw extension both ways", () => {
		expect(EXTENSION_MIME.excalidraw).toBe(EXCALIDRAW_MIME);
		expect(extensionForMime(EXCALIDRAW_MIME)).toBe("excalidraw");
	});
	it("accept attr lists .excalidraw", () => {
		expect(ATTACHMENT_ACCEPT_ATTR).toContain(".excalidraw");
	});
	it("resolves an empty / octet-stream .excalidraw via the extension rescue", () => {
		expect(
			resolveAttachmentMime(
				"diagram.excalidraw",
				"",
				DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe(EXCALIDRAW_MIME);
		expect(
			resolveAttachmentMime(
				"diagram.excalidraw",
				"application/octet-stream",
				DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe(EXCALIDRAW_MIME);
	});
	it("also resolves in the narrowed create-flow set (Create work item dialog)", () => {
		expect(
			resolveAttachmentMime(
				"d.excalidraw",
				"",
				TEXT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe(EXCALIDRAW_MIME);
	});
});

describe("isValidExcalidrawContent", () => {
	it("accepts a well-formed excalidraw document", () => {
		expect(
			isValidExcalidrawContent(
				JSON.stringify({
					type: "excalidraw",
					version: 2,
					elements: [],
				}),
			),
		).toBe(true);
	});
	it("rejects valid JSON without the excalidraw marker", () => {
		expect(
			isValidExcalidrawContent(JSON.stringify({ hello: "world" })),
		).toBe(false);
	});
	it("rejects an excalidraw type with no elements array", () => {
		expect(
			isValidExcalidrawContent(JSON.stringify({ type: "excalidraw" })),
		).toBe(false);
	});
	it("rejects malformed JSON", () => {
		expect(isValidExcalidrawContent("{ not json")).toBe(false);
	});
	it("rejects a JSON array (not an object)", () => {
		expect(isValidExcalidrawContent("[1,2,3]")).toBe(false);
	});
});

describe("html support", () => {
	// One canonical MIME for three extensions. A second admitted MIME
	// (application/xhtml+xml) would need its own extractor, chunking branch and
	// download mapping — four places to drift — so .xhtml canonicalizes here.
	it("accepts text/html as a ticket attachment type", () => {
		expect(DEFAULT_ATTACHMENT_MIME_ALLOWLIST).toContain("text/html");
	});

	it("maps text/html to the canonical .html extension", () => {
		expect(MIME_EXTENSION["text/html"]).toBe("html");
		expect(extensionForMime("text/html")).toBe("html");
	});

	it("maps all three html extensions back to text/html", () => {
		expect(EXTENSION_MIME.html).toBe("text/html");
		expect(EXTENSION_MIME.htm).toBe("text/html");
		expect(EXTENSION_MIME.xhtml).toBe("text/html");
	});

	it("advertises all three extensions in the picker accept attribute", () => {
		expect(ATTACHMENT_ACCEPT_ATTR).toContain(".html");
		expect(ATTACHMENT_ACCEPT_ATTR).toContain(".htm");
		expect(ATTACHMENT_ACCEPT_ATTR).toContain(".xhtml");
	});

	it("rescues .xhtml reported as application/xhtml+xml", () => {
		// Browsers report .xhtml as application/xhtml+xml, which is deliberately
		// NOT allowlisted. The extension branch is what rescues it.
		expect(
			resolveAttachmentMime(
				"spec.xhtml",
				"application/xhtml+xml",
				DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe("text/html");
	});

	it("rescues .html and .htm from an empty or octet-stream mime", () => {
		expect(
			resolveAttachmentMime(
				"a.html",
				"",
				DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe("text/html");
		expect(
			resolveAttachmentMime(
				"a.htm",
				"application/octet-stream",
				DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
			),
		).toBe("text/html");
	});

	it("stays out of the narrowed create-flow text set", () => {
		// Card #1684 Open Question, decided by Product: the create dialog keeps
		// its curated "reference documents" set. Pinned so a later widening is a
		// deliberate act, not a drive-by.
		expect(TEXT_ATTACHMENT_MIME_ALLOWLIST).not.toContain("text/html");
		expect(TEXT_ATTACHMENT_ACCEPT_ATTR).not.toContain("html");
	});
});

describe("html is never served inline", () => {
	// Card #1684 AC-6 requires that uploaded HTML is never executed by the
	// platform. Nothing renders attachment content as live HTML today; the
	// remaining guarantee is that the download path cannot serve it inline.
	// This pins that — a change to `attachment` disposition would turn every
	// uploaded .html into a stored-XSS delivery mechanism.
	it("forces attachment disposition for an html filename", () => {
		const header = buildContentDisposition("report.html");
		expect(header.startsWith("attachment;")).toBe(true);
		expect(header).not.toContain("inline");
	});

	it("forces attachment disposition for .htm and .xhtml too", () => {
		expect(buildContentDisposition("a.htm").startsWith("attachment;")).toBe(
			true,
		);
		expect(
			buildContentDisposition("a.xhtml").startsWith("attachment;"),
		).toBe(true);
	});

	it("cannot break out of the quoted filename with an embedded quote", () => {
		// The double-quote is the assertion that bites. CR and LF are stripped
		// independently by the ASCII-safety step (`[^\x20-\x7e]` -> "_"), which
		// runs whether or not the name was sanitized, so asserting only on those
		// would stay green even with sanitizeAttachmentFilename removed
		// entirely. `"` is the Content-Disposition delimiter and sanitization is
		// the only thing that strips it, so an unsanitized `evil".html` would
		// terminate the filename attribute early and let the remainder of the
		// name be parsed as further header content.
		const header = buildContentDisposition('evil";\r\nX-Evil: 1.html');

		// Exactly the two delimiters of `filename="..."`. A third quote means
		// the injected one survived into the header.
		expect(header.split('"')).toHaveLength(3);

		// Read the attribute using the trailing `"; filename*=` delimiter, not
		// the first `";` — an injected quote creates an earlier `";` and would
		// otherwise hide itself from the extraction.
		const start = header.indexOf('filename="') + 'filename="'.length;
		const quoted = header.slice(start, header.indexOf('"; filename*='));
		expect(quoted).not.toContain('"');
		expect(quoted).toBe("evil;X-Evil: 1.html");

		expect(header).not.toContain("\r");
		expect(header).not.toContain("\n");
		expect(header.startsWith("attachment;")).toBe(true);
	});
});
