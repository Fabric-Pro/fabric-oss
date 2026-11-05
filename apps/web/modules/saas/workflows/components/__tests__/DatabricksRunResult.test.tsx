import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DatabricksRunResult } from "../editor/DatabricksRunResult";
describe("Databricks run results", () => {
	it("renders typed columns, recorded rows, NULLs, the statement id and a safe workspace link", () => {
		render(
			<DatabricksRunResult
				output={{
					statementId: "example-statement",
					workspaceUrl: "https://example.cloud.databricks.com",
					columns: [
						{ name: "status", type_name: "STRING" },
						{ name: "optional" },
					],
					rows: [["Ready", null]],
					truncated: true,
				}}
			/>,
		);
		expect(
			screen.getByRole("columnheader", { name: "status STRING" }),
		).toBeInTheDocument();
		expect(screen.getByRole("cell", { name: "Ready" })).toBeInTheDocument();
		expect(screen.getByRole("cell", { name: "NULL" })).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("truncated");
		expect(
			screen.getByRole("link", { name: "Open Databricks ↗" }),
		).toHaveAttribute("rel", "noopener noreferrer");
		expect(screen.getByText("example-statement")).toBeInTheDocument();
	});
	it("bounds the rendered preview and tells the person where to inspect the rest", () => {
		render(
			<DatabricksRunResult
				output={{
					columns: [{ name: "value" }],
					rows: Array.from({ length: 101 }, (_, i) => [String(i)]),
				}}
			/>,
		);
		expect(screen.getAllByRole("row")).toHaveLength(101);
		expect(screen.getByText(/Showing up to 100 rows/)).toBeInTheDocument();
	});
	it("does not create a link from an unsafe output URL", () => {
		render(
			<DatabricksRunResult
				output={{
					workspaceUrl: "javascript:alert(1)",
					columns: [],
					rows: [],
				}}
			/>,
		);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(
			screen.getByText("The statement completed with no result rows."),
		).toBeInTheDocument();
	});
});
