import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { fetchPmTicket } from "../fetch-pm-ticket";
import type { PMToolCapabilities } from "../tool-analyzer";

const baseCapabilities: PMToolCapabilities = {
	hasPMCapabilities: true,
	containerHierarchy: [],
	availableTools: ["get_card"],
	detectedType: "fizzy",
	taskGet: {
		toolName: "get_card",
		idParam: "card_id",
		additionalRequiredParams: [],
		allParams: [],
	},
} as unknown as PMToolCapabilities;

const baseInput = {
	mcpConfigId: "mcp-1",
	userId: "user-1",
	organizationId: undefined,
	capabilities: baseCapabilities,
	externalId: "PM-42",
	containerId: "container-1",
};

describe("fetchPmTicket", () => {
	beforeEach(() => {
		vi.mocked(executeMcpTool).mockReset();
	});

	it("returns null only when adapter has no taskGet capability", async () => {
		const result = await fetchPmTicket({
			...baseInput,
			capabilities: { ...baseCapabilities, taskGet: undefined },
		});
		expect(result).toBeNull();
		expect(executeMcpTool).not.toHaveBeenCalled();
	});

	it("throws (retryable) when the adapter reports failure", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: false,
			output: { error: "rate limited" },
		} as never);

		await expect(fetchPmTicket(baseInput)).rejects.toThrow(
			/PM ticket fetch failed for PM-42 via get_card: rate limited/,
		);
	});

	it("throws non-retryable PmFetchParseError when content text is unparsable JSON", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				content: [{ type: "text", text: "not-valid-json" }],
			},
		} as never);

		await expect(fetchPmTicket(baseInput)).rejects.toMatchObject({
			type: "PmFetchParseError",
			nonRetryable: true,
		});
	});

	it("returns the snapshot on success (top-level fields)", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				title: "Hello",
				description: "World",
				url: "https://example.com/x",
			},
		} as never);

		const result = await fetchPmTicket(baseInput);
		expect(result).toEqual({
			title: "Hello",
			description: "World",
			url: "https://example.com/x",
			lastChangedBy: null,
			lastChangedAt: null,
		});
	});

	it("parses Jira-style nested fields (fields.summary / fields.description)", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				fields: {
					summary: "Initial Git Setup",
					description: "Set up the repository and CI.",
				},
			},
		} as never);

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: {
				...baseCapabilities,
				detectedType: "jira",
			} as unknown as PMToolCapabilities,
		});

		expect(result?.title).toBe("Initial Git Setup");
		expect(result?.description).toBe("Set up the repository and CI.");
	});

	it("flattens Jira ADF descriptions instead of dropping them", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				fields: {
					summary: "Initial Git Setup",
					description: {
						type: "doc",
						version: 1,
						content: [
							{
								type: "heading",
								content: [
									{ type: "text", text: "Big Picture" },
								],
							},
							{
								type: "paragraph",
								content: [
									{ type: "text", text: "Small picture" },
								],
							},
						],
					},
				},
			},
		} as never);

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: {
				...baseCapabilities,
				detectedType: "jira",
			} as unknown as PMToolCapabilities,
		});

		expect(result?.title).toBe("Initial Git Setup");
		expect(result?.description).toBe("Big Picture\n\nSmall picture");
	});

	it("parses ADO-style nested fields", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				fields: {
					"System.Title": "ADO Title",
					"System.Description": "<p>ADO body</p>",
				},
				_links: {
					html: {
						href: "https://dev.azure.com/x/_workitems/edit/42",
					},
				},
			},
		} as never);

		const result = await fetchPmTicket(baseInput);
		expect(result).toEqual({
			title: "ADO Title",
			description: "<p>ADO body</p>",
			url: "https://dev.azure.com/x/_workitems/edit/42",
			// fizzy capabilities + no last_active_at in payload → date stays null
			lastChangedBy: null,
			lastChangedAt: null,
		});
	});
});

describe("fetchPmTicket — author/changed-date capture (Group 1)", () => {
	beforeEach(() => {
		vi.mocked(executeMcpTool).mockReset();
	});

	const withType = (detectedType: string): PMToolCapabilities =>
		({
			...baseCapabilities,
			detectedType,
		}) as unknown as PMToolCapabilities;

	const mockOutput = (output: unknown) => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output,
		} as never);
	};

	it("ADO: parses System.ChangedBy as an identity object + System.ChangedDate", async () => {
		mockOutput({
			fields: {
				"System.Title": "T",
				"System.Description": "D",
				"System.ChangedBy": {
					displayName: "Dana Lee",
					uniqueName: "dana@example.com",
				},
				"System.ChangedDate": "2026-05-26T10:00:00Z",
			},
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("azure-devops"),
		});

		expect(result?.lastChangedBy).toBe("Dana Lee");
		expect(result?.lastChangedAt).toBe("2026-05-26T10:00:00.000Z");
	});

	it("ADO: parses System.ChangedBy when it is a plain string", async () => {
		mockOutput({
			fields: {
				"System.Title": "T",
				"System.Description": "D",
				"System.ChangedBy": "Dana Lee",
				"System.ChangedDate": "2026-05-26T10:00:00Z",
			},
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("azure-devops"),
		});

		expect(result?.lastChangedBy).toBe("Dana Lee");
		expect(result?.lastChangedAt).toBe("2026-05-26T10:00:00.000Z");
	});

	it("Jira: parses updateAuthor.displayName + updated", async () => {
		mockOutput({
			fields: {
				summary: "T",
				description: "D",
				updateAuthor: { displayName: "Alex Kim" },
				updated: "2026-05-25T08:30:00.000+0000",
			},
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("jira"),
		});

		expect(result?.lastChangedBy).toBe("Alex Kim");
		expect(result?.lastChangedAt).toBe("2026-05-25T08:30:00.000Z");
		// Nested fields.summary/description must populate the diff, not "(empty)".
		expect(result?.title).toBe("T");
		expect(result?.description).toBe("D");
	});

	it("Jira: falls back to creator.displayName when updateAuthor is absent", async () => {
		mockOutput({
			fields: {
				summary: "T",
				description: "D",
				creator: { displayName: "Jamie Fox" },
				updated: "2026-05-25T08:30:00.000+0000",
			},
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("jira"),
		});

		expect(result?.lastChangedBy).toBe("Jamie Fox");
	});

	it("Linear: parses top-level updatedBy + updatedAt", async () => {
		mockOutput({
			title: "T",
			description: "D",
			updatedBy: { name: "Sam Doe" },
			updatedAt: "2026-05-24T12:00:00.000Z",
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("linear"),
		});

		expect(result?.lastChangedBy).toBe("Sam Doe");
		expect(result?.lastChangedAt).toBe("2026-05-24T12:00:00.000Z");
	});

	it("Linear: missing updatedBy yields null author but still parses updatedAt", async () => {
		mockOutput({
			title: "T",
			description: "D",
			updatedAt: "2026-05-24T12:00:00.000Z",
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("linear"),
		});

		expect(result?.lastChangedBy).toBeNull();
		expect(result?.lastChangedAt).toBe("2026-05-24T12:00:00.000Z");
	});

	it("Fizzy: captures last_active_at as changed date, but never an author", async () => {
		// Fizzy exposes `last_active_at` (last-touched time) and `creator` (the
		// original author), but no last-changed-by. We surface the date and leave
		// the author null rather than mislabel the creator as the recent editor.
		mockOutput({
			title: "T",
			description: "D",
			last_active_at: "2026-05-24T12:00:00.000Z",
			creator: { name: "Original Author" },
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("fizzy"),
		});

		expect(result?.lastChangedBy).toBeNull();
		expect(result?.lastChangedAt).toBe("2026-05-24T12:00:00.000Z");
	});

	it("Fizzy: no last_active_at and Linear-shaped fields stay null", async () => {
		mockOutput({
			title: "T",
			description: "D",
			updatedBy: { name: "Ignored" },
			updatedAt: "2026-05-24T12:00:00.000Z",
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("fizzy"),
		});

		expect(result?.lastChangedBy).toBeNull();
		expect(result?.lastChangedAt).toBeNull();
	});

	it("malformed/odd-shaped fields resolve to null without throwing", async () => {
		mockOutput({
			fields: {
				"System.Title": "T",
				"System.Description": "D",
				"System.ChangedBy": 12345,
				"System.ChangedDate": "not-a-date",
			},
		});

		const result = await fetchPmTicket({
			...baseInput,
			capabilities: withType("azure-devops"),
		});

		expect(result?.lastChangedBy).toBeNull();
		expect(result?.lastChangedAt).toBeNull();
		// Primary fields still parsed — the diff is never degraded.
		expect(result?.title).toBe("T");
	});
});
