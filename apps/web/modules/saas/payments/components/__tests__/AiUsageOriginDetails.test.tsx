import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	AI_USAGE_ORIGIN_CSV_HEADERS,
	aiUsageOriginCsvFields,
	aiUsageOriginLinks,
} from "../../lib/ai-usage-origin";
import { AiUsageOriginDetails } from "../AiUsageOriginDetails";

const origin = {
	frameId: "frame-1",
	workflowId: "workflow-1",
	workflowExecutionId: "execution-1",
	originOrganizationSlug: "example-org",
	featureKey: "workspace",
	promptVersionId: "prompt-1",
};

describe("AI usage origin", () => {
	it("shows safe organization-scoped source links and the actual run", () => {
		render(<AiUsageOriginDetails origin={origin} />);
		expect(screen.getByRole("link", { name: /frame-1/ })).toHaveAttribute(
			"href",
			"/app/example-org/frames/frame-1",
		);
		expect(
			screen.getByRole("link", { name: /workflow-1/ }),
		).toHaveAttribute("href", "/app/example-org/workflows/workflow-1");
		expect(screen.getByText("execution-1")).toBeInTheDocument();
	});

	it("leaves legacy rows empty and never guesses an organization", () => {
		const { container } = render(<AiUsageOriginDetails origin={{}} />);
		expect(container).toBeEmptyDOMElement();
		expect(aiUsageOriginLinks({ frameId: "frame-1" })).toEqual({
			frame: null,
			workflow: null,
		});
	});

	it("exports origin fields in the same order as their CSV headers", () => {
		expect(AI_USAGE_ORIGIN_CSV_HEADERS).toEqual([
			"featureKey",
			"frameId",
			"workflowId",
			"workflowExecutionId",
			"promptVersionId",
		]);
		expect(aiUsageOriginCsvFields(origin)).toEqual([
			"workspace",
			"frame-1",
			"workflow-1",
			"execution-1",
			"prompt-1",
		]);
		expect(aiUsageOriginCsvFields({})).toEqual(["", "", "", "", ""]);
	});
});
