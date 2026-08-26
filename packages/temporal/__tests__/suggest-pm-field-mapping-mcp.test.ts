/**
 * Arg-contract guard for the field-mapping suggestion activity.
 *
 * The read-mapping feature already shipped one live-only failure of exactly this
 * kind: the enumeration activity passed `type` where the ADO tool required
 * `workItemType`, and CI stayed green because the tests mocked the MCP layer and
 * never asserted the argument object. These assert the ACTUAL args handed to
 * `executeMcpTool`, on BOTH tool surfaces.
 *
 * All project names, labels and field identifiers are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeMcpTool: vi.fn(),
	discoverPMToolCapabilities: vi.fn(),
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: mocks.executeMcpTool,
}));
vi.mock("../src/activities/pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: mocks.discoverPMToolCapabilities,
	isPmNotFoundError: (message: string) => /not found/i.test(message),
	simpleHtmlToMarkdown: (html: string) => html.replace(/<[^>]+>/g, ""),
}));

import { suggestPmFieldMapping } from "../src/activities/pm-integration/suggest-pm-field-mapping";

const GRANULAR_TOOLS = ["wit_get_work_item", "wit_get_work_item_type"];
const CONSOLIDATED_TOOLS = ["wit_work_item"];

const EXAMPLE_FIELDS = {
	"System.WorkItemType": "User Story",
	"System.TeamProject": "example-project",
	"System.Description": "<p>The filter must persist across reloads.</p>",
	"Custom.BusinessRules":
		"<p>Billing reviewers segment records by requirement.</p>",
	"Custom.StateSummary": "AA(Done), FE(New), BE(Active), QA(Planning)",
	"System.ChangedDate": "2026-01-02T03:04:05.000Z",
};

/** Two rich-text bodies inside titled groups; everything else is a plain field. */
const XML_FORM = `
<FORM><Layout>
  <Group Label="Summary">
    <Control Label="Status Roll-up" FieldName="Custom.StateSummary" Type="FieldControl" />
  </Group>
  <Group Label="++ Story Summary ++">
    <Control Label="" FieldName="System.Description" Type="HtmlFieldControl" />
  </Group>
  <Group Label="++ Story Details (Analysis) ++">
    <Control Label="" FieldName="Custom.BusinessRules" Type="HtmlFieldControl" />
  </Group>
</Layout></FORM>`;

const BASE_INPUT = {
	mcpConfigId: "cfg-1",
	containerId: "container-1",
	containerName: "example-project",
	exampleWorkItemId: 4321,
	userId: "user-1",
	organizationId: "org-1",
};

function wireHappyPath(xmlForm: string = XML_FORM) {
	mocks.executeMcpTool
		.mockResolvedValueOnce({
			success: true,
			output: { fields: EXAMPLE_FIELDS },
		})
		.mockResolvedValueOnce({ success: true, output: { xmlForm } });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("suggestPmFieldMapping — granular surface (<= 2.8)", () => {
	beforeEach(() => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			availableTools: GRANULAR_TOOLS,
		});
	});

	it("reads the example, then that type's form definition — and nothing else", () => {
		wireHappyPath();
		return suggestPmFieldMapping(BASE_INPUT).then(() => {
			// Two round-trips. No peer sampling: the form already declares which
			// controls are bodies, so querying other work items buys nothing.
			expect(mocks.executeMcpTool).toHaveBeenCalledTimes(2);

			const [get, getType] = mocks.executeMcpTool.mock.calls.map(
				([args]) => args,
			);
			expect(get.toolName).toBe("wit_get_work_item");
			expect(get.args).toEqual({ id: 4321, project: "example-project" });

			expect(getType.toolName).toBe("wit_get_work_item_type");
			// The required param is `workItemType`, NOT `type` — the exact key
			// that broke this feature live once already.
			expect(getType.args).toEqual({
				project: "example-project",
				workItemType: "User Story",
			});
			expect(getType.args).not.toHaveProperty("action");
		});
	});

	it("returns only the form's rich-text controls, labelled as they appear on screen", async () => {
		wireHappyPath();
		const result = await suggestPmFieldMapping(BASE_INPUT);

		expect(result.source).toBe("form");
		expect(result.workItemType).toBe("User Story");
		expect(result.suggestions.map((s) => s.id)).toEqual([
			"Custom.BusinessRules",
			"System.Description",
		]);
		expect(result.suggestions[0]?.label).toBe(
			"++ Story Details (Analysis) ++",
		);
		// Populated on every ticket, but the form says it is not a body.
		expect(
			result.suggestions.some((s) => s.id === "Custom.StateSummary"),
		).toBe(false);
		// Dates never reach the list at all.
		expect(
			result.suggestions.some((s) => s.id === "System.ChangedDate"),
		).toBe(false);
	});

	it("keeps a body field that is empty on the example, ranked below populated ones", async () => {
		mocks.executeMcpTool
			.mockResolvedValueOnce({
				success: true,
				output: {
					fields: {
						...EXAMPLE_FIELDS,
						"Custom.BusinessRules": "",
					},
				},
			})
			.mockResolvedValueOnce({
				success: true,
				output: { xmlForm: XML_FORM },
			});

		const result = await suggestPmFieldMapping(BASE_INPUT);
		const empty = result.suggestions.find(
			(s) => s.id === "Custom.BusinessRules",
		);
		expect(empty).toBeDefined();
		expect(empty?.populatedOnExample).toBe(false);
		expect(result.suggestions[0]?.id).toBe("System.Description");
	});
});

describe("suggestPmFieldMapping — consolidated surface (>= 2.9)", () => {
	beforeEach(() => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			availableTools: CONSOLIDATED_TOOLS,
		});
	});

	it("dispatches both calls with the right action keys", async () => {
		wireHappyPath();
		await suggestPmFieldMapping(BASE_INPUT);

		const [get, getType] = mocks.executeMcpTool.mock.calls.map(
			([args]) => args,
		);
		expect(get.toolName).toBe("wit_work_item");
		expect(get.args.action).toBe("get");
		expect(getType.toolName).toBe("wit_work_item");
		expect(getType.args).toEqual({
			action: "get_type",
			project: "example-project",
			workItemType: "User Story",
		});
	});
});

describe("suggestPmFieldMapping — fallback and failure", () => {
	beforeEach(() => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			availableTools: GRANULAR_TOOLS,
		});
	});

	it("falls back to value ranking when the process exposes no form", async () => {
		// Inherited-process projects return a type payload with no xmlForm at all.
		mocks.executeMcpTool
			.mockResolvedValueOnce({
				success: true,
				output: { fields: EXAMPLE_FIELDS },
			})
			.mockResolvedValueOnce({
				success: true,
				output: { name: "User Story", fields: [] },
			});

		const result = await suggestPmFieldMapping(BASE_INPUT);

		expect(result.source).toBe("values");
		expect(result.suggestions.length).toBeGreaterThan(0);
		// Longest prose wins on this path.
		expect(result.suggestions[0]?.id).toBe("Custom.BusinessRules");
	});

	it("falls back rather than failing when the form read errors", async () => {
		mocks.executeMcpTool
			.mockResolvedValueOnce({
				success: true,
				output: { fields: EXAMPLE_FIELDS },
			})
			.mockRejectedValueOnce(new Error("type read exploded"));

		const result = await suggestPmFieldMapping(BASE_INPUT);
		expect(result.source).toBe("values");
	});

	it("raises a typed not-found for an unknown example ticket", async () => {
		mocks.executeMcpTool.mockResolvedValueOnce({ success: false });
		await expect(suggestPmFieldMapping(BASE_INPUT)).rejects.toMatchObject({
			type: "TICKET_NOT_FOUND",
		});
	});

	it("names both tool surfaces when neither is available", async () => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			availableTools: ["repo_file"],
		});
		await expect(suggestPmFieldMapping(BASE_INPUT)).rejects.toThrow(
			/wit_get_work_item|wit_work_item/,
		);
	});
});
