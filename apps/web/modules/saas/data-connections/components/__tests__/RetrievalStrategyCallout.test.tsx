import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RetrievalStrategyCallout } from "../RetrievalStrategyCallout";

describe("RetrievalStrategyCallout", () => {
	it("renders retrieval guidance for indexed and live systems", () => {
		render(<RetrievalStrategyCallout />);

		expect(
			screen.getByText("How Fabric Chooses Context"),
		).toBeInTheDocument();
		expect(screen.getByText("Indexed knowledge first")).toBeInTheDocument();
		expect(
			screen.getByText("Live systems when freshness matters"),
		).toBeInTheDocument();
		expect(screen.getByText("Best fit by task type")).toBeInTheDocument();
	});

	it("renders the compact variant for constrained surfaces", () => {
		render(<RetrievalStrategyCallout variant="compact" />);

		expect(
			screen.getByText("How Fabric Chooses Context"),
		).toBeInTheDocument();
		expect(screen.getByText("Indexed knowledge first")).toBeInTheDocument();
		expect(
			screen.getByText("Live systems when freshness matters"),
		).toBeInTheDocument();
		expect(screen.getByText("Best fit by task type")).toBeInTheDocument();
	});
});
