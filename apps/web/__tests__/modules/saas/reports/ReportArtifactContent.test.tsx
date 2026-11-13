import { ReportArtifactContent } from "@saas/reports/components/ReportArtifactContent";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("ReportArtifactContent", () => {
	it("renders a report's blockquote outside the typography styles that add quotation marks", () => {
		// Arrange
		const content =
			"> ⚠️ **Partial data** — some sections may be based on a subset.";

		// Act
		const { container } = render(
			<ReportArtifactContent
				name="report.md"
				content={content}
				projectSourcePath="/app/example-org/projects"
			/>,
		);

		// Assert
		const blockquote = container.querySelector("blockquote");
		expect(blockquote?.textContent).toContain("Partial data");
		expect(blockquote?.classList.contains("not-prose")).toBe(true);
	});
});
