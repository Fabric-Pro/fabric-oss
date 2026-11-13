import { describe, expect, it } from "vitest";
import { ragToolResultText } from "../../lib/rag-tool-result";

describe("recorded RAG tool text", () => {
	it.each(["project", "workspace"] as const)(
		"retains nonempty %s results",
		(owner) => {
			expect(
				ragToolResultText(owner, "example query", {
					context: "example context",
					chunkCount: 1,
				}),
			).toBe("example context");
		},
	);
	it.each(["project", "workspace"] as const)(
		"formats empty or zero-chunk %s results",
		(owner) => {
			const expected = `No relevant content found in ${owner === "project" ? "project contexts" : "workspace documents"} for query: "example query".`;
			expect(
				ragToolResultText(owner, "example query", {
					context: "",
					chunkCount: 1,
				}),
			).toBe(expected);
			expect(
				ragToolResultText(owner, "example query", {
					context: "example error",
					chunkCount: 0,
				}),
			).toBe(expected);
		},
	);
});
