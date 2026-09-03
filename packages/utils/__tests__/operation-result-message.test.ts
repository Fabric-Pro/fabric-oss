/**
 * Tests for `buildOperationResultMessage`.
 *
 * The formatter is a PURE function: inputs → `{ content, metadata }`.
 * No DB, no logging, no side effects. It MUST be safe to import from
 * `@repo/temporal` (workflow boundary) without dragging in Prisma.
 *
 * # Output-shape contract (I3 fix)
 *
 * `content` carries ONLY the header + summary text. The artifact link
 * is exposed via `metadata.artifact` and rendered as a separate UI
 * element. Prior revisions inlined `\n\n[label](url)` at the end of
 * `content`, but that forced the renderer to regex-strip the trailing
 * link before rendering markdown — a strip that over-matched any
 * user-supplied summary ending in a markdown link (e.g.
 * `"See [related](https://x)"`). Splitting the data shape eliminates
 * the entire regex.
 *
 * Test matrix:
 *   - outcome: success / failure / partial / cancelled
 *   - artifact present / artifact absent (metadata only)
 *   - short summary / long summary that needs truncation
 *   - stack-trace-like error code masked into a generic copy
 *   - empty summary → still produces valid output
 *   - truncation: exactly at 2000 / link present does NOT shrink summary budget
 *   - summary ending in markdown link is preserved untouched
 *   - metadata.kind = "operation_result" always emitted
 *   - metadata.outcome echoes the outcome
 *   - metadata.artifact carries the structured link
 */

import { describe, expect, it } from "vitest";
import { buildOperationResultMessage } from "../lib/operation-result-message";

const HEADER = "SYSTEM";
const TRUNCATION_SUFFIX = "…";
const MAX_CONTENT_LENGTH = 2000;

describe("buildOperationResultMessage — outcome × artifact matrix", () => {
	it("success with artifact: content has header + summary; metadata carries the link", () => {
		const artifact = {
			label: "View PRD",
			url: "https://fabric.pro/app/acme/projects/p1/docs/d1",
		};
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Generate PRD",
			summary: "Generated PRD with 12 sections and 4 user stories.",
			artifact,
		});

		expect(out.content).toContain(HEADER);
		expect(out.content).toContain("Generated PRD");
		// The link MUST NOT appear in content — the renderer pulls it
		// from metadata.artifact and renders it as a separate element.
		expect(out.content).not.toContain(artifact.url);
		expect(out.content).not.toContain(`[${artifact.label}]`);
		expect(out.metadata.kind).toBe("operation_result");
		expect(out.metadata.outcome).toBe("success");
		expect(out.metadata.operationLabel).toBe("Generate PRD");
		expect(out.metadata.artifact).toEqual(artifact);
	});

	it("success without artifact: header + summary, no link region", () => {
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Run analysis",
			summary: "Analysis complete.",
		});

		expect(out.content).toContain("Analysis complete.");
		expect(out.metadata.outcome).toBe("success");
		expect(out.metadata.artifact).toBeUndefined();
	});

	it("failure with artifact: metadata carries the link, content has summary only", () => {
		const artifact = {
			label: "Open backlog",
			url: "https://fabric.pro/app/projects/p1/backlog",
		};
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Apply backlog changes",
			summary: "Could not connect to upstream PM tool.",
			artifact,
		});

		expect(out.content).toContain("Could not connect");
		expect(out.content).not.toContain(artifact.url);
		expect(out.metadata.outcome).toBe("failure");
		expect(out.metadata.artifact).toEqual(artifact);
	});

	it("failure without artifact: just header + summary, no link", () => {
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Sync project",
			summary: "Operation failed.",
		});

		expect(out.content).not.toMatch(/\]\(/);
		expect(out.metadata.outcome).toBe("failure");
	});

	it("preserves a summary that legitimately ends with a markdown link (I3 regression)", () => {
		// Prior revisions used a regex to strip the trailing
		// `\n\n[Label](URL)` link from content; that regex
		// over-matched any caller-supplied summary that happened to
		// end with a markdown link. With the link region moved out of
		// content into metadata, the summary survives untouched —
		// even when an artifact is ALSO supplied.
		const trailingLink = "See [related docs](https://example.com/docs)";
		const artifact = {
			label: "Open primary artifact",
			url: "https://fabric.pro/app/projects/p1/docs/d1",
		};
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Inspect docs",
			summary: trailingLink,
			artifact,
		});

		expect(out.content).toContain(trailingLink);
		// The summary's own embedded link must be intact.
		expect(out.content).toContain(
			"[related docs](https://example.com/docs)",
		);
		// The artifact link must NOT appear in content.
		expect(out.content).not.toContain(artifact.url);
		// And the artifact link IS available structurally.
		expect(out.metadata.artifact).toEqual(artifact);
	});

	it("partial outcome: distinct from success in metadata, content still well-formed", () => {
		const out = buildOperationResultMessage({
			outcome: "partial",
			operationLabel: "Multi-step plan",
			summary:
				"3 of 5 steps completed; remaining steps require approval.",
		});

		expect(out.metadata.outcome).toBe("partial");
		expect(out.content).toContain("3 of 5 steps");
	});

	it("cancelled outcome: distinct from failure, content reflects intent", () => {
		const out = buildOperationResultMessage({
			outcome: "cancelled",
			operationLabel: "Document generation",
			summary: "Stopped by user.",
		});

		expect(out.metadata.outcome).toBe("cancelled");
		expect(out.content).toContain("Stopped by user");
	});
});

describe("buildOperationResultMessage — truncation", () => {
	it("short summary stays under the budget unchanged", () => {
		const summary = "Hello.";
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary,
		});
		expect(out.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
		expect(out.content).toContain(summary);
		expect(out.content).not.toContain(TRUNCATION_SUFFIX);
	});

	it("long summary without link is sliced and ends with the suffix", () => {
		const longSummary = "x".repeat(MAX_CONTENT_LENGTH + 500);
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary: longSummary,
		});
		expect(out.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
		expect(out.content.endsWith(TRUNCATION_SUFFIX)).toBe(true);
	});

	it("long summary WITH artifact: link travels via metadata, summary truncated to content budget", () => {
		const longSummary = "y".repeat(MAX_CONTENT_LENGTH + 500);
		const link = {
			label: "Open artifact",
			url: "https://fabric.pro/app/acme/projects/p1/stories/s1",
		};
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary: longSummary,
			artifact: link,
		});
		expect(out.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
		// The link does NOT appear in content — it's structurally
		// available via metadata.artifact for the renderer.
		expect(out.content).not.toContain(link.url);
		expect(out.metadata.artifact).toEqual(link);
		expect(out.content).toContain(TRUNCATION_SUFFIX);
	});

	it("artifact does not consume summary budget (link lives in metadata only)", () => {
		// With the link out of content, the summary budget depends only
		// on header + paragraph separator — adding an artifact should
		// NOT shrink the summary's allowed length.
		const linkA = {
			label: "L",
			url: "https://e.example/a",
		};
		const summary = "z".repeat(MAX_CONTENT_LENGTH - HEADER.length - 2);
		const withArtifact = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary,
			artifact: linkA,
		});
		const withoutArtifact = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary,
		});
		// Same content length whether or not an artifact is present.
		expect(withArtifact.content.length).toBe(
			withoutArtifact.content.length,
		);
		expect(withArtifact.content.length).toBeLessThanOrEqual(
			MAX_CONTENT_LENGTH,
		);
	});

	it("content lands exactly at 2000 when summary fills the remaining budget", () => {
		// content = HEADER + "\n\n" + summary
		const overhead = HEADER.length + 2;
		const summary = "a".repeat(MAX_CONTENT_LENGTH - overhead);

		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary,
		});

		expect(out.content.length).toBe(MAX_CONTENT_LENGTH);
		expect(out.content).not.toContain(TRUNCATION_SUFFIX);
	});
});

describe("buildOperationResultMessage — error masking", () => {
	it("replaces stack-trace-like errorCode with generic copy", () => {
		const stackish =
			"Error: ENOENT: no such file or directory at /app/src/index.ts:42\n    at process._tickCallback (internal/process/next_tick.js:68:7)";
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Read file",
			summary: stackish,
			errorCode: stackish,
		});

		expect(out.content).not.toContain("at process._tickCallback");
		expect(out.content).not.toContain("ENOENT");
		expect(out.content.toLowerCase()).toMatch(/error|failed|unable/);
	});

	it("preserves a clean errorCode that is not a stack trace", () => {
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Upload",
			summary: "Upload rejected by storage tier.",
			errorCode: "STORAGE_QUOTA_EXCEEDED",
		});

		expect(out.metadata.errorCode).toBe("STORAGE_QUOTA_EXCEEDED");
		expect(out.content).toContain("Upload rejected");
	});

	it("masks when summary itself looks like a stack trace, even without errorCode", () => {
		const stackish =
			"TypeError: Cannot read property 'foo' of undefined\n    at Object.<anonymous> (/app/index.js:1:1)";
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Run agent",
			summary: stackish,
		});

		expect(out.content).not.toContain("at Object.<anonymous>");
		expect(out.content).not.toContain("TypeError: Cannot read");
	});
});

describe("buildOperationResultMessage — bounded stack-trace scan (js/polynomial-redos)", () => {
	it("still masks a stack trace found within the bounded scan window", () => {
		const stackish = `${"context ".repeat(200)}\n    at handler (/app/src/index.ts:1:1)`;
		expect(stackish.length).toBeLessThan(4000);
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Run agent",
			summary: stackish,
		});
		expect(out.content).toContain("Check the activity log for details");
		expect(out.content).not.toContain("at handler");
	});

	it("does not scan past the bounded prefix for a stack marker far past it", () => {
		// A stack-trace marker beyond the scan window is not detected as
		// such — the heuristic only needs to catch a marker near the start
		// (FR-11), which is what keeps the regex bounded rather than
		// scanning unbounded content.
		const farStackTrace = `${"x".repeat(4500)}\n    at handler (/app/src/index.ts:1:1)`;
		const out = buildOperationResultMessage({
			outcome: "failure",
			operationLabel: "Run agent",
			summary: farStackTrace,
		});
		// Not masked: the raw (truncated) summary passes through instead of
		// the generic failure copy.
		expect(out.content).not.toContain("Check the activity log for details");
		expect(out.content.endsWith(TRUNCATION_SUFFIX)).toBe(true);
	});
});

describe("buildOperationResultMessage — edges", () => {
	it("empty summary still produces valid content (header + empty body)", () => {
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Trivial op",
			summary: "",
		});

		expect(out.content).toContain(HEADER);
		expect(out.metadata.kind).toBe("operation_result");
		expect(out.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
	});

	it("operationLabel is preserved in metadata exactly", () => {
		const label = "Generate document — chapter 4";
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: label,
			summary: "Done.",
		});
		expect(out.metadata.operationLabel).toBe(label);
	});

	it("artifact metadata is echoed when artifact is present", () => {
		const artifact = {
			label: "View",
			url: "https://e.example/x",
		};
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary: "Done.",
			artifact,
		});
		expect(out.metadata.artifact).toEqual(artifact);
	});

	it("metadata.artifact is omitted when no artifact provided", () => {
		const out = buildOperationResultMessage({
			outcome: "success",
			operationLabel: "Op",
			summary: "Done.",
		});
		expect(out.metadata.artifact).toBeUndefined();
	});
});
