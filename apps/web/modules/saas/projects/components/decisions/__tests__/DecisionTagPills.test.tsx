/**
 * DecisionTagPills — the type / duration / priority chips on a decision row.
 *
 * The case that matters here is the missing one. Capture through the form
 * enforces a type and a duration, but a decision extracted from a meeting is
 * tagged by a model call that can fail, and a failed call leaves the draft
 * untagged permanently. Without a marker such a decision renders exactly like
 * one nobody needed to classify, which is how an AC1 hole stays invisible.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DecisionTagPills } from "../DecisionAtoms";

describe("DecisionTagPills", () => {
	it("flags a decision with no type", () => {
		render(
			<DecisionTagPills decisionType={null} duration="LONG_STANDING" />,
		);
		expect(screen.getByText("Needs classification")).toBeInTheDocument();
	});

	it("flags a decision with no duration", () => {
		render(
			<DecisionTagPills
				decisionType={{ name: "Architecture" }}
				duration={null}
			/>,
		);
		expect(screen.getByText("Needs classification")).toBeInTheDocument();
	});

	it("stays quiet once both are present", () => {
		render(
			<DecisionTagPills
				decisionType={{ name: "Architecture" }}
				duration="SHORT_TERM"
			/>,
		);
		expect(
			screen.queryByText("Needs classification"),
		).not.toBeInTheDocument();
		expect(screen.getByText("Architecture")).toBeInTheDocument();
	});

	it("keeps the priority chip independent of classification", () => {
		render(
			<DecisionTagPills
				decisionType={null}
				duration={null}
				priorityFlagged
			/>,
		);
		expect(screen.getByText("Needs classification")).toBeInTheDocument();
		expect(screen.getByText("Priority")).toBeInTheDocument();
	});
});
