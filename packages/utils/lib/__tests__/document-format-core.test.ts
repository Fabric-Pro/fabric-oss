import { describe, expect, it } from "vitest";
import { EXTENSION_MIME } from "../attachment";
import {
	configFor,
	DOCUMENT_FORMAT_CORE,
	type DocumentFormatEntry,
	forcedExtensionMap,
	formatAcceptAttr,
	formatAllowlist,
	formatExtensionMap,
	formatLabels,
	resolveFormatMime,
} from "../document-format-core";

describe("DOCUMENT_FORMAT_CORE", () => {
	it("lists the canonical extension first in every alias list", () => {
		for (const [mimeType, entry] of Object.entries(DOCUMENT_FORMAT_CORE)) {
			if (!entry.acceptExtensions) {
				continue;
			}
			expect(
				entry.acceptExtensions[0],
				`${mimeType} should lead with its canonical extension`,
			).toBe(entry.extension);
		}
	});

	it("claims each extension exactly once", () => {
		// Two formats claiming one extension would make resolution order decide
		// which wins, silently.
		const seen = new Set<string>();
		for (const entry of Object.values(DOCUMENT_FORMAT_CORE)) {
			for (const extension of entry.acceptExtensions ?? [
				entry.extension,
			]) {
				expect(seen.has(extension), `${extension} claimed twice`).toBe(
					false,
				);
				seen.add(extension);
			}
		}
	});

	it("admits no image or vendor-diagram format", () => {
		// Those belong to the project-context surface's own extras. Letting one
		// into the core would hand it to workspace documents, which is a document
		// library.
		for (const mimeType of Object.keys(DOCUMENT_FORMAT_CORE)) {
			expect(mimeType.startsWith("image/")).toBe(false);
			expect(mimeType).not.toContain("excalidraw");
		}
	});

	it("forces every format whose declared type is unreliable", () => {
		// The structured-text formats have no entry in the shared extension map
		// (deliberately — see workspace-document-upload.test.ts), so forcing is
		// their only rescue path for an untyped file.
		for (const mimeType of [
			"application/xml",
			"application/json",
			"application/yaml",
			"text/html",
		]) {
			expect(DOCUMENT_FORMAT_CORE[mimeType].forceByExtension).toBe(true);
		}
	});
});

describe("projections", () => {
	const sample: Record<string, DocumentFormatEntry> = {
		"text/plain": { type: "FILE", extension: "txt" },
		"application/yaml": {
			type: "FILE",
			extension: "yaml",
			acceptExtensions: ["yaml", "yml"],
			forceByExtension: true,
		},
	};

	it("derives an allowlist of MIME types", () => {
		expect(formatAllowlist(sample)).toEqual([
			"text/plain",
			"application/yaml",
		]);
	});

	it("derives a dotted accept attribute covering every alias", () => {
		expect(formatAcceptAttr(sample)).toBe(".txt,.yaml,.yml");
	});

	it("derives labels from the canonical extension only", () => {
		// Spelling every alias out in a refusal message adds noise, not clarity.
		expect(formatLabels(sample)).toEqual(["TXT", "YAML"]);
	});

	it("derives a forced map covering every alias of forced formats only", () => {
		expect(forcedExtensionMap(sample)).toEqual({
			yaml: "application/yaml",
			yml: "application/yaml",
		});
	});

	it("derives a MIME-to-canonical-extension map", () => {
		expect(formatExtensionMap(sample)).toEqual({
			"text/plain": "txt",
			"application/yaml": "yaml",
		});
	});

	it("keeps the accept attribute free of MIME strings", () => {
		for (const entry of formatAcceptAttr(DOCUMENT_FORMAT_CORE).split(",")) {
			expect(entry.startsWith(".")).toBe(true);
			expect(entry).not.toContain("/");
		}
	});
});

describe("resolveFormatMime", () => {
	const forced = { yaml: "application/yaml", yml: "application/yaml" };
	const allowlist = ["text/plain", "application/yaml"];

	it("prefers a forced extension over the declared type", () => {
		// The whole reason the forced step exists: the declared value is wrong
		// often enough that believing it routes the file to the wrong reader.
		expect(
			resolveFormatMime("a.yml", "text/plain", forced, allowlist),
		).toBe("application/yaml");
	});

	it("rescues a file the OS gave no type at all", () => {
		expect(resolveFormatMime("a.yaml", "", forced, allowlist)).toBe(
			"application/yaml",
		);
	});

	it("keeps an allowlisted declared type when nothing is forced", () => {
		expect(
			resolveFormatMime("a.txt", "text/plain", forced, allowlist),
		).toBe("text/plain");
	});

	it("returns the caller's value when nothing resolves", () => {
		// Not null: the caller quotes this in its refusal message, and the server
		// normalizes with it rather than gating on it.
		expect(
			resolveFormatMime(
				"a.bin",
				"application/x-thing",
				forced,
				allowlist,
			),
		).toBe("application/x-thing");
	});

	it("does not treat an inherited object key as a forced extension", () => {
		expect(
			resolveFormatMime("x.constructor", "", forced, allowlist),
		).not.toBe("[object Object]");
		expect(resolveFormatMime("x.constructor", "", forced, allowlist)).toBe(
			"",
		);
	});

	it("ignores a name with no extension", () => {
		// `split(".").pop()` would return the whole name here and resolve "yaml".
		expect(resolveFormatMime("yaml", "", forced, allowlist)).toBe("");
	});
});

describe("configFor", () => {
	const entries = {
		"text/plain": { type: "FILE" as const, extension: "txt" },
	};

	it("returns the entry for an admitted type", () => {
		expect(configFor(entries, "text/plain")).toEqual({
			type: "FILE",
			extension: "txt",
		});
	});

	it("returns undefined for a type the surface does not admit", () => {
		expect(configFor(entries, "image/png")).toBeUndefined();
	});

	it.each(["constructor", "toString", "__proto__", "valueOf"])(
		"returns undefined for the inherited key %s",
		(key) => {
			// A plain-object index is truthy for these, so a gate written as
			// `if (!MAP[mime])` would admit them and then size the upload against
			// an undefined limit, which every comparison passes.
			expect(configFor(entries, key)).toBeUndefined();
		},
	);
});

describe("the forced-extension invariant is structural, not per-format", () => {
	// The failure this catches is silent and fail-closed, which is the worst
	// shape: a twelfth format added without `forceByExtension` whose extension
	// the shared map does not carry would be advertised by every picker and then
	// refused for any untyped or alias-typed upload — exactly the #2139 bug,
	// reintroduced for one format only. Today's other tests check the four known
	// formats by name and would not catch the twelfth.
	it.each(Object.entries(DOCUMENT_FORMAT_CORE))(
		"%s is either resolvable through the shared extension map or forced",
		(_mimeType, entry) => {
			const reachableWithoutForcing = (
				entry.acceptExtensions ?? [entry.extension]
			).every((extension) => extension in EXTENSION_MIME);

			expect(
				entry.forceByExtension === true || reachableWithoutForcing,
			).toBe(true);
		},
	);

	it("is frozen, so a surface cannot widen the core for everyone", () => {
		// workspace-document-upload.ts aliases this object by reference while
		// context-upload.ts spreads a copy — an accidental mutation would have
		// widened only the workspace allowlist, and silently.
		expect(Object.isFrozen(DOCUMENT_FORMAT_CORE)).toBe(true);
	});
});
