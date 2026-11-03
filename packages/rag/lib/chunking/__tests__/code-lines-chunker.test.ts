import { describe, expect, it } from "vitest";
import {
	chunkCodeByLines,
	codeFileSkipReason,
	lineAtOffset,
} from "../code-lines-chunker";

const CSHARP = Array.from(
	{ length: 40 },
	(_, i) => `public sealed class Service${i}
{
    public Task<int> RunAsync(int value)
    {
        // Step ${i}: keep the booking flow readable.
        return Task.FromResult(value + ${i});
    }
}
`,
).join("\n");

describe("chunkCodeByLines", () => {
	it("covers the whole file, in order, with no gap or overlap", () => {
		const chunks = chunkCodeByLines(CSHARP, {
			targetChars: 600,
			maxChars: 1200,
		});
		expect(chunks.length).toBeGreaterThan(5);
		expect(chunks.map((c) => c.content).join("")).toBe(CSHARP);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i]?.startLine).toBe(
				(chunks[i - 1]?.endLine ?? 0) + 1,
			);
		}
		expect(chunks.at(-1)?.endLine).toBe(CSHARP.split("\n").length - 1);
	});

	it("cuts between declarations rather than inside one", () => {
		const chunks = chunkCodeByLines(CSHARP, {
			targetChars: 600,
			maxChars: 1200,
		});
		for (const chunk of chunks.slice(1)) {
			expect(chunk.content.startsWith("public sealed class")).toBe(true);
		}
	});

	it("keeps every chunk within the max, even without boundaries", () => {
		const flat = "x = 1;\n".repeat(2000);
		const chunks = chunkCodeByLines(flat, {
			targetChars: 500,
			maxChars: 800,
		});
		expect(chunks.every((c) => c.content.length <= 800)).toBe(true);
		expect(chunks.map((c) => c.content).join("")).toBe(flat);
	});

	it("keeps a file without a final newline whole", () => {
		const chunks = chunkCodeByLines("a\nb");
		expect(chunks).toEqual([
			{ content: "a\nb", index: 0, startLine: 1, endLine: 2 },
		]);
	});
});

describe("codeFileSkipReason", () => {
	it("indexes ordinary code of any language", () => {
		expect(codeFileSkipReason("src/Booking/Service.cs", CSHARP)).toBeNull();
		expect(
			codeFileSkipReason("app/models/user.rb", "class User\nend\n"),
		).toBeNull();
	});

	it("skips generated, minified, binary and empty files", () => {
		expect(codeFileSkipReason("obj/Debug/App.g.cs", "class A {}")).toBe(
			"generated",
		);
		expect(codeFileSkipReason("Forms/Main.Designer.cs", "class A {}")).toBe(
			"generated",
		);
		expect(codeFileSkipReason("web/app.js", `${"a".repeat(5000)}\n`)).toBe(
			"minified",
		);
		expect(codeFileSkipReason("data.bin", "a\u0000b")).toBe("binary");
		expect(codeFileSkipReason("empty.cs", "  \n")).toBe("empty");
	});
});

describe("lineAtOffset", () => {
	it("counts lines from 1", () => {
		expect(lineAtOffset("a\nb\nc", 0)).toBe(1);
		expect(lineAtOffset("a\nb\nc", 4)).toBe(3);
	});
});
