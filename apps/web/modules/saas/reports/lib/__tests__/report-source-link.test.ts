import { describe, expect, it } from "vitest";
import { resolveReportSourceLink } from "../report-source-link";

const projects = "/app/example-org/projects";
describe("report source links", () => {
	it("opens current shared-text citations in the existing project Context tab", () => {
		expect(
			resolveReportSourceLink(
				"projects/example-project?tab=context&source=example-source",
				projects,
			),
		).toBe(
			"/app/example-org/projects/example-project?tab=context&source=example-source",
		);
	});
	it("repairs early text citations at display time without changing stored evidence", () => {
		const stored = "projects/example-project/context?source=example-source";
		expect(resolveReportSourceLink(stored, projects)).toBe(
			"/app/example-org/projects/example-project?tab=context&source=example-source",
		);
		expect(stored).toBe(
			"projects/example-project/context?source=example-source",
		);
	});
	it("keeps generated document links and unrelated anchors intact", () => {
		expect(
			resolveReportSourceLink(
				"projects/example-project/documents/example-doc",
				projects,
			),
		).toBe(
			"/app/example-org/projects/example-project/documents/example-doc",
		);
		expect(resolveReportSourceLink("#summary", projects)).toBe("#summary");
		expect(resolveReportSourceLink(undefined, projects)).toBeUndefined();
	});
});
