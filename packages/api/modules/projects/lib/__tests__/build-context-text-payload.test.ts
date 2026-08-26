import { describe, expect, it } from "vitest";
import { buildContextTextPayload } from "../build-context-text-payload";

const FIXED_DATE = new Date("2026-04-15T14:22:03.000Z");

describe("buildContextTextPayload", () => {
	it("emits the exact 7-line header + blank + '---' + blank + content", () => {
		const out = buildContextTextPayload({
			id: "ctx_123",
			title: "Release Kickoff",
			type: "MEETING_TRANSCRIPT",
			integrationProvider: "teams",
			createdAt: FIXED_DATE,
			content: "Line one\nLine two",
		});

		const expected =
			"Fabric Context Export\n" +
			"Title       : Release Kickoff\n" +
			"Context ID  : ctx_123\n" +
			"Type        : MEETING_TRANSCRIPT\n" +
			"Source      : teams\n" +
			"Captured at : 2026-04-15T14:22:03Z\n" +
			"\n" +
			"---\n" +
			"\n" +
			"Line one\nLine two";

		expect(out).toBe(expected);
	});

	it("renders missing integrationProvider as em dash", () => {
		const out = buildContextTextPayload({
			id: "ctx_1",
			title: "Note",
			type: "NOTE",
			integrationProvider: null,
			createdAt: FIXED_DATE,
			content: "hello",
		});
		expect(out).toContain("Source      : —");
	});

	it("renders undefined integrationProvider as em dash", () => {
		const out = buildContextTextPayload({
			id: "ctx_1",
			title: "Note",
			type: "NOTE",
			createdAt: FIXED_DATE,
			content: "hello",
		});
		expect(out).toContain("Source      : —");
	});

	it("renders createdAt as ISO 8601 UTC with Z suffix (no millis)", () => {
		const out = buildContextTextPayload({
			id: "ctx_1",
			title: "Note",
			type: "NOTE",
			integrationProvider: null,
			createdAt: new Date("2026-01-02T03:04:05.678Z"),
			content: "x",
		});
		expect(out).toContain("Captured at : 2026-01-02T03:04:05Z");
		expect(out).not.toContain(".678");
	});

	it("preserves content verbatim after the separator", () => {
		const content = "# Heading\n\n- bullet one\n- bullet two\n";
		const out = buildContextTextPayload({
			id: "ctx_1",
			title: "Doc",
			type: "NOTE",
			integrationProvider: null,
			createdAt: FIXED_DATE,
			content,
		});
		expect(out.endsWith(content)).toBe(true);
		expect(out).toContain("\n---\n\n");
	});
});
