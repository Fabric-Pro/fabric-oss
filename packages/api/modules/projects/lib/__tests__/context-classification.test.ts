import { describe, expect, it } from "vitest";
import { dedupeFilename } from "../context-classification";

describe("dedupeFilename", () => {
	it("returns the original name on first sighting", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "a.md")).toBe("a.md");
	});

	it("appends numeric suffix before the extension on collision", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "a.md")).toBe("a.md");
		expect(dedupeFilename(seen, "a.md")).toBe("a-1.md");
		expect(dedupeFilename(seen, "a.md")).toBe("a-2.md");
	});

	it("appends a bare suffix when the name has no extension", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "README")).toBe("README");
		expect(dedupeFilename(seen, "README")).toBe("README-1");
		expect(dedupeFilename(seen, "README")).toBe("README-2");
	});

	it("uses the last dot to split stem and extension", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "archive.tar.gz")).toBe("archive.tar.gz");
		expect(dedupeFilename(seen, "archive.tar.gz")).toBe("archive.tar-1.gz");
	});

	it("tracks independent counters per filename", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "a.md")).toBe("a.md");
		expect(dedupeFilename(seen, "b.md")).toBe("b.md");
		expect(dedupeFilename(seen, "a.md")).toBe("a-1.md");
	});
});
