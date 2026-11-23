import { describe, expect, it } from "vitest";
import { parlumeProposalFields } from "../parlume-proposal";

describe("parlumeProposalFields", () => {
	// A bug proposal showed "Kind: BUG", the raw enum value.
	it("shows a work item kind and a priority as the app names them", () => {
		expect(
			parlumeProposalFields({
				title: "Export button does nothing",
				kind: "BUG",
				priority: "P1_HIGH",
			}),
		).toEqual(["Kind: Bug", "Priority: High"]);
	});

	it("keeps any other value as given, capitals included", () => {
		expect(
			parlumeProposalFields({
				status: "IN_PROGRESS",
				team: "QA",
				code: "SKU",
			}),
		).toEqual(["Status: IN_PROGRESS", "Team: QA", "Code: SKU"]);
	});
});
