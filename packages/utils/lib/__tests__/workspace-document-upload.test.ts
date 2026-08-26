import { describe, expect, it } from "vitest";
import { resolveAttachmentMime } from "../attachment";
import {
	resolveWorkspaceDocumentMime,
	WORKSPACE_DOCUMENT_ACCEPT_ATTR,
	WORKSPACE_DOCUMENT_FORMAT_LABELS,
	WORKSPACE_DOCUMENT_MIME_ALLOWLIST,
	WORKSPACE_DOCUMENT_MIME_TYPES,
	workspaceDocumentConfigFor,
} from "../workspace-document-upload";

/**
 * The gate the picker applies: resolve, then look the result up. Written out
 * here rather than imported as one helper because the two halves are the point
 * — `resolveWorkspaceDocumentMime` deliberately cannot refuse, so a client that
 * tested its result for null would accept everything. Fizzy #2149.
 */
const gate = (filename: string, mimeType: string) =>
	workspaceDocumentConfigFor(
		resolveWorkspaceDocumentMime(filename, mimeType),
	);

describe("workspace document vocabulary", () => {
	it("carries exactly the shared document core", () => {
		// Widened from five formats to eleven: CSV, XLSX, HTML, JSON, XML and
		// YAML were all extractable long before this picker offered them, and
		// project context had carried most of them for months. Fizzy #2149.
		expect(Object.values(WORKSPACE_DOCUMENT_MIME_TYPES).sort()).toEqual([
			"csv",
			"doc",
			"docx",
			"html",
			"json",
			"md",
			"pdf",
			"txt",
			"xlsx",
			"xml",
			"yaml",
		]);
	});

	it("derives the allowlist from the map", () => {
		expect([...WORKSPACE_DOCUMENT_MIME_ALLOWLIST].sort()).toEqual(
			Object.keys(WORKSPACE_DOCUMENT_MIME_TYPES).sort(),
		);
	});

	it("admits no image or diagram format", () => {
		// The core-plus-extras split exists so this surface cannot inherit what
		// the project-context surface adds for OCR and Excalidraw.
		for (const mimeType of WORKSPACE_DOCUMENT_MIME_ALLOWLIST) {
			expect(mimeType.startsWith("image/")).toBe(false);
		}
		expect(WORKSPACE_DOCUMENT_ACCEPT_ATTR).not.toContain(".excalidraw");
	});

	it("advertises dotted extensions, not MIME strings", () => {
		// Fizzy #2139: a MIME-only `accept` greys `.md` out of the OS dialog on
		// a machine with no `.md` registration.
		const advertised = WORKSPACE_DOCUMENT_ACCEPT_ATTR.split(",");
		expect(advertised).toEqual([
			".pdf",
			".docx",
			".doc",
			".txt",
			".md",
			".html",
			".htm",
			".xhtml",
			".csv",
			".xlsx",
			".json",
			".xml",
			".yaml",
			".yml",
		]);
		for (const entry of advertised) {
			expect(entry.startsWith(".")).toBe(true);
			expect(entry).not.toContain("/");
		}
	});

	it("advertises the alias extensions the projected map cannot express", () => {
		// `WORKSPACE_DOCUMENT_MIME_TYPES` is MIME -> *canonical* extension, so
		// deriving `accept` from its values would silently drop `.htm`, `.xhtml`
		// and `.yml` while every label assertion still passed.
		for (const alias of [".htm", ".xhtml", ".yml"]) {
			expect(WORKSPACE_DOCUMENT_ACCEPT_ATTR.split(",")).toContain(alias);
		}
	});

	it("advertises every allowlisted format and nothing beyond it", () => {
		const advertised = WORKSPACE_DOCUMENT_ACCEPT_ATTR.split(",").map(
			(entry) => entry.replace(/^\./, ""),
		);
		// Every canonical extension is offered...
		for (const extension of Object.values(WORKSPACE_DOCUMENT_MIME_TYPES)) {
			expect(advertised).toContain(extension);
		}
		// ...and every offered extension resolves back into the allowlist, so the
		// picker cannot advertise something the gate refuses.
		for (const extension of advertised) {
			expect(gate(`design.${extension}`, "")).toBeDefined();
		}
	});

	it("labels every format for the dialog copy", () => {
		expect([...WORKSPACE_DOCUMENT_FORMAT_LABELS]).toEqual([
			"PDF",
			"DOCX",
			"DOC",
			"TXT",
			"MD",
			"HTML",
			"CSV",
			"XLSX",
			"JSON",
			"XML",
			"YAML",
		]);
	});
});

describe("resolving a workspace document upload", () => {
	const advertisedExtensions = WORKSPACE_DOCUMENT_ACCEPT_ATTR.split(",").map(
		(entry) => entry.replace(/^\./, ""),
	);
	// The two shapes an unregistered extension arrives as: the browser reports
	// nothing at all, or the caller substitutes the generic placeholder.
	const untypedMimes = ["", "application/octet-stream"];

	it.each(
		advertisedExtensions.flatMap((extension) =>
			untypedMimes.map((mime) => [extension, mime] as const),
		),
	)("resolves .%s reported as %j", (extension, mime) => {
		// Goes through the surface resolver, not `resolveAttachmentMime`: the
		// forced-extension step is where `.xml`, `.json`, `.yaml` and `.yml` are
		// rescued, and the shared extension map carries none of those keys.
		const config = gate(`design.${extension}`, mime);
		expect(config).toBeDefined();
	});

	it("canonicalizes the alias spellings onto one MIME per format", () => {
		// One MIME per format is what keeps extraction working: the extractor
		// matches on the exact string, so admitting both `text/xml` and
		// `application/xml` would route half the uploads to no extractor at all.
		expect(resolveWorkspaceDocumentMime("data.xml", "text/xml")).toBe(
			"application/xml",
		);
		expect(resolveWorkspaceDocumentMime("pipeline.yml", "")).toBe(
			"application/yaml",
		);
		expect(
			resolveWorkspaceDocumentMime("pipeline.yaml", "application/x-yaml"),
		).toBe("application/yaml");
		expect(resolveWorkspaceDocumentMime("page.xhtml", "")).toBe(
			"text/html",
		);
	});

	it("resolves an untyped design.md to text/markdown", () => {
		expect(resolveWorkspaceDocumentMime("design.md", "")).toBe(
			"text/markdown",
		);
	});

	it("leaves a recognised declared type unchanged", () => {
		expect(
			resolveWorkspaceDocumentMime("report.pdf", "application/pdf"),
		).toBe("application/pdf");
	});

	it("refuses a format outside the allowlist", () => {
		expect(gate("photo.png", "image/png")).toBeUndefined();
		expect(gate("deck.pptx", "")).toBeUndefined();
		expect(gate("sheet.xls", "application/vnd.ms-excel")).toBeUndefined();
	});

	it("refuses a file with no extension and no usable type", () => {
		expect(gate("README", "")).toBeUndefined();
	});

	it("refuses an inherited object key masquerading as a type", () => {
		expect(gate("x.constructor", "constructor")).toBeUndefined();
	});

	describe("server-side normalization (confirmUpload / serverUpload)", () => {
		// Both persistence points normalize with the surface resolver, which
		// returns the caller's value when nothing resolves. That is
		// normalization, never a gate: a REST caller that bypasses the picker
		// must still be able to persist a row.
		const normalize = resolveWorkspaceDocumentMime;

		it("persists a resolved type when the caller supplies an empty one", () => {
			expect(normalize("design.md", "")).toBe("text/markdown");
			expect(normalize("notes.txt", "")).toBe("text/plain");
		});

		it("leaves a recognised type unchanged", () => {
			expect(normalize("report.pdf", "application/pdf")).toBe(
				"application/pdf",
			);
		});

		it("persists an unresolvable type rather than refusing it", () => {
			expect(normalize("mystery", "")).toBe("");
			expect(normalize("photo.png", "image/png")).toBe("image/png");
		});
	});

	describe("the shared extension map is not the rescue path", () => {
		// Regression guard for the trap this change navigated: adding `xml`,
		// `json` or `yaml` to `EXTENSION_MIME` in attachment.ts would rescue them
		// here too, but that map also builds the story-attachment picker's accept
		// attribute — so those formats would be advertised on a surface whose
		// gate refuses them. The forced-extension layer is the rescue instead.
		it.each(["xml", "json", "yaml", "yml"])(
			"leaves .%s unresolvable through the shared map alone",
			(extension) => {
				expect(
					resolveAttachmentMime(
						`data.${extension}`,
						"",
						WORKSPACE_DOCUMENT_MIME_ALLOWLIST,
					),
				).toBeNull();
			},
		);
	});
});
