import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: {
			current: () => ({ heartbeat: vi.fn() }),
		},
	};
});

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

// Mock @repo/storage so resolveStoryMediaSignedUrls (called from
// hierarchy-sync's transformFieldForMarkdownPmTool / the non-ADO path) does
// not reach a real S3 client. Returns deterministic signed URLs for any
// story-media key the description references.
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		getSignedUrl: vi.fn(
			async (key: string) =>
				`https://signed.example.com/${key}?Sig=test&Expires=999999`,
		),
	})),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-project-contexts",
			},
		},
	},
}));

const { userStoryUpdateMock, userStoryUpdateManyMock } = vi.hoisted(() => ({
	userStoryUpdateMock: vi.fn(),
	userStoryUpdateManyMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	db: {
		userStory: {
			update: userStoryUpdateMock,
			updateMany: userStoryUpdateManyMock,
		},
		mCPConfig: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	getStoryById: vi.fn(),
	updateStory: vi.fn().mockResolvedValue(undefined),
	upsertPendingChange: vi.fn().mockResolvedValue({
		action: "created",
		pendingId: "pending-1",
	}),
	// Mirror the real regex + helper from fabric-url.ts so the back-link
	// extract / reorder logic in syncWorkItemToPM exercises the same behavior
	// the production code does. Keep in sync with packages/database/.../fabric-url.ts.
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	formatBackLinkForProvider: (
		description: string | null | undefined,
		providerDetectedType: string | null | undefined,
	) => {
		const current = description ?? "";
		if ((providerDetectedType ?? "").toLowerCase() !== "fizzy") {
			return current;
		}
		const re =
			/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i;
		const m = current.match(re);
		if (!m) {
			return current;
		}
		return current.replace(re, `[View in Fabric](${m[1]})`);
	},
}));

vi.mock("../story-sync", async () => {
	const actual = await vi.importActual<{
		markdownToSimpleHtml: (s: string) => string;
	}>("../story-sync");
	return {
		...actual,
		discoverPMToolCapabilities: vi.fn(),
		fetchPMItemsByIds: vi.fn(),
		HTML_DESCRIPTION_TOOLS: new Set<string>(),
		// Default: identity (preserves existing tests). Real-transform tests
		// can swap this in via mockImplementation.
		markdownToSimpleHtml: vi.fn((s: string) => s),
		__realMarkdownToSimpleHtml: actual.markdownToSimpleHtml,
	};
});

import { getStoryById, updateStory, upsertPendingChange } from "@repo/database";
import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { normalizePolledState } from "../extract-pm-item-state";
import {
	readbackPmCanonicalHash,
	stampPmSyncSuccess,
	syncWorkItemToPM,
} from "../hierarchy-sync";
import { computePmHash } from "../pm-sync-hash";
import { discoverPMToolCapabilities, fetchPMItemsByIds } from "../story-sync";

const STORY_ID = "story-1";
const PROJECT_ID = "project-1";
const EXTERNAL_ID = "PM-42";
const STORY_TITLE = "Story title";
const STORY_DESCRIPTION = "Story description";

function makeCapabilities() {
	return {
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: ["update_card", "get_card", "create_card"],
		detectedType: "fizzy",
		taskUpdate: {
			toolName: "update_card",
			idParam: "card_id",
			titleParam: "title",
			descriptionParam: "description",
			updatesBased: undefined,
			allParams: [
				{ name: "card_id", type: "string", required: true },
				{ name: "title", type: "string", required: false },
				{ name: "description", type: "string", required: false },
			],
		},
		taskCreation: {
			toolName: "create_card",
			containerParam: "board_id",
			titleParam: "title",
			descriptionParam: "description",
			fieldsBased: undefined,
			allParams: [],
		},
		taskGet: {
			toolName: "get_card",
			idParam: "card_id",
			additionalRequiredParams: [],
			allParams: [],
		},
	};
}

function makeStory(overrides: Record<string, unknown> = {}) {
	return {
		id: STORY_ID,
		title: STORY_TITLE,
		description: STORY_DESCRIPTION,
		acceptanceCriteria: null,
		identifier: "US-001",
		externalId: EXTERNAL_ID,
		lastSyncedPmHash: null,
		...overrides,
	};
}

const baseInput = {
	itemType: "story" as const,
	itemId: STORY_ID,
	projectId: PROJECT_ID,
	mcpConfigId: "mcp-1",
	containerId: "board-1",
	userId: "user-1",
	triggerSource: "ai-update" as const,
};

describe("syncWorkItemToPM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		userStoryUpdateMock.mockResolvedValue({});
		userStoryUpdateManyMock.mockResolvedValue({});
		vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
			makeCapabilities() as never,
		);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {},
		} as never);
	});

	it("fieldsObjectBased capability → update call wraps title/description in fields object (regression #1270)", async () => {
		// Regression for #1270 (verified live 2026-05-28 on staging Jira
		// F-002): hierarchy-sync was missing the `fieldsObjectBased`
		// branch that story-sync.ts already had, so the editJiraIssue
		// call sent only {issueIdOrKey, cloudId} with no `fields` key.
		// Atlassian's Rovo server then rejected with
		// `path: ["fields"], message: "Required"`. This test wires up an
		// Atlassian-shaped capability (fieldsObjectBased set, no
		// updatesBased) and asserts the final args include
		// `fields: {summary, description}` populated from the story.
		vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
			hasPMCapabilities: true,
			containerHierarchy: [],
			availableTools: [
				"editJiraIssue",
				"getJiraIssue",
				"createJiraIssue",
			],
			detectedType: "jira",
			taskUpdate: {
				toolName: "editJiraIssue",
				idParam: "issueIdOrKey",
				updatesBased: undefined,
				fieldsObjectBased: {
					fieldsParam: "fields",
					titleField: "summary",
					descriptionField: "description",
				},
				allParams: [
					{ name: "cloudId", type: "string", required: true },
					{ name: "issueIdOrKey", type: "string", required: true },
					{ name: "fields", type: "object", required: true },
				],
			},
			taskCreation: {
				toolName: "createJiraIssue",
				containerParam: "projectKey",
				titleParam: "summary",
				descriptionParam: "description",
				fieldsBased: undefined,
				allParams: [],
			},
			taskGet: {
				toolName: "getJiraIssue",
				idParam: "issueIdOrKey",
				additionalRequiredParams: [],
				allParams: [],
			},
		} as never);
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: null }) as never,
		);

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		const updateCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				([arg]) =>
					(arg as { toolName: string }).toolName === "editJiraIssue",
			);
		expect(updateCall).toBeDefined();
		const args = (updateCall as [{ args: Record<string, unknown> }])[0]
			.args;
		// The whole point of the regression: `fields` MUST be present.
		expect(args).toHaveProperty("fields");
		expect(args.issueIdOrKey).toBe(EXTERNAL_ID);
		expect(args.fields).toEqual({
			summary: STORY_TITLE,
			description: STORY_DESCRIPTION,
		});
		// AND it must NOT degrade to top-level title/description — those
		// keys are absent on the Atlassian editJiraIssue schema and the
		// server's `additionalProperties: false` would reject them.
		expect(args).not.toHaveProperty("summary");
		expect(args).not.toHaveProperty("description");
	});

	it("null baseline → pushes and stamps SUCCESS", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: null }) as never,
		);

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		expect(executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: "update_card" }),
		);
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: STORY_ID },
				data: expect.objectContaining({
					lastSyncedPmHash: computePmHash(
						STORY_TITLE,
						STORY_DESCRIPTION,
					),
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
				}),
			}),
		);
	});

	it("equal hash → pushes and re-stamps SUCCESS", async () => {
		const baseline = computePmHash(STORY_TITLE, STORY_DESCRIPTION);
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: baseline }) as never,
		);
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName } = args as { toolName: string };
			if (toolName === "get_card") {
				return {
					success: true,
					output: {
						title: STORY_TITLE,
						description: STORY_DESCRIPTION,
					},
				} as never;
			}
			return { success: true, output: {} } as never;
		});

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "SUCCESS",
				}),
			}),
		);
	});

	it("hash differs and pushAnyway=false → CONFLICT, no push", async () => {
		const baseline = computePmHash(STORY_TITLE, STORY_DESCRIPTION);
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: baseline }) as never,
		);
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName } = args as { toolName: string };
			if (toolName === "get_card") {
				return {
					success: true,
					output: {
						title: "PM edited title",
						description: "PM edited body",
					},
				} as never;
			}
			return { success: true, output: {} } as never;
		});

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("CONFLICT");
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const updateCalled = calls.some(
			([arg]) => (arg as { toolName: string }).toolName === "update_card",
		);
		expect(updateCalled).toBe(false);
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "CONFLICT",
				}),
			}),
		);
	});

	it("PM read fails with baseline present → throws and does NOT push (no silent overwrite)", async () => {
		const baseline = computePmHash(STORY_TITLE, STORY_DESCRIPTION);
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: baseline }) as never,
		);
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName } = args as { toolName: string };
			if (toolName === "get_card") {
				return {
					success: false,
					output: { error: "ADO permission denied" },
				} as never;
			}
			return { success: true, output: {} } as never;
		});

		await expect(syncWorkItemToPM(baseInput)).rejects.toThrow(
			/PM ticket fetch failed/,
		);

		const calls = vi.mocked(executeMcpTool).mock.calls;
		const updateCalled = calls.some(
			([arg]) => (arg as { toolName: string }).toolName === "update_card",
		);
		expect(updateCalled).toBe(false);
	});

	it("hash differs and pushAnyway=true → pushes and stamps SUCCESS", async () => {
		const baseline = computePmHash(STORY_TITLE, STORY_DESCRIPTION);
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: baseline }) as never,
		);
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName } = args as { toolName: string };
			if (toolName === "get_card") {
				return {
					success: true,
					output: { title: "differs", description: "differs" },
				} as never;
			}
			return { success: true, output: {} } as never;
		});

		const result = await syncWorkItemToPM({
			...baseInput,
			pushAnyway: true,
		});

		expect(result.status).toBe("SUCCESS");
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const updateCalled = calls.some(
			([arg]) => (arg as { toolName: string }).toolName === "update_card",
		);
		expect(updateCalled).toBe(true);
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "SUCCESS",
				}),
			}),
		);
	});

	it("update path receives success:false → throws PmUpdateError, no SUCCESS stamp", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: null }) as never,
		);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			output: { error: "auth expired" },
		} as never);

		await expect(syncWorkItemToPM(baseInput)).rejects.toMatchObject({
			type: "PmUpdateError",
		});
		expect(userStoryUpdateMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ lastPmSyncStatus: "SUCCESS" }),
			}),
		);
	});

	// Fix 1: an on-demand push that 404s (the linked PM card was deleted) must
	// be classified as PmNotFoundError AND immediately propose a FLAG_MISSING
	// unlink, so the user can heal the stale link from the Review Center instead
	// of dead-ending at a generic FAILED (which only the hourly poll would
	// eventually flag, ~3 cycles later).
	describe("push not-found (404) → classify + propose FLAG_MISSING", () => {
		const NOT_FOUND_OUTPUT = {
			success: false as const,
			output: {
				error: 'Resource not found: {"status":404,"error":"Not Found"}',
			},
		};

		it("STORY update 404 → throws PmNotFoundError and proposes a FLAG_MISSING unlink with row provenance", async () => {
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalMcpServerId: "srv-1",
					draftingStage: "PUBLISHED",
				}) as never,
			);
			vi.mocked(executeMcpTool).mockResolvedValue(
				NOT_FOUND_OUTPUT as never,
			);

			await expect(syncWorkItemToPM(baseInput)).rejects.toMatchObject({
				type: "PmNotFoundError",
			});
			expect(upsertPendingChange).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: PROJECT_ID,
					entityType: "STORY",
					entityId: STORY_ID,
					externalId: EXTERNAL_ID,
					newState: "MISSING",
					proposedAction: "FLAG_MISSING",
					// Provenance = the row's CURRENT server, so the atomic unlink
					// predicate matches the row exactly.
					expectedExternalMcpServerId: "srv-1",
					previousState: "PUBLISHED",
				}),
			);
		});

		it.each(["feature", "epic"] as const)(
			"legacy %s itemType fails fast with PmCapabilitiesError (folder tables removed)",
			async (itemType) => {
				await expect(
					syncWorkItemToPM({
						...baseInput,
						itemType,
						itemId: `${itemType}-1`,
					}),
				).rejects.toMatchObject({ type: "PmCapabilitiesError" });
				// No PM-side call and no FLAG_MISSING proposal — the guard fires
				// before any lookup or push.
				expect(executeMcpTool).not.toHaveBeenCalled();
				expect(upsertPendingChange).not.toHaveBeenCalled();
			},
		);

		it("BUG update 404 → proposes FLAG_MISSING logged as entityType STORY (bugs are UserStory rows)", async () => {
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({ externalMcpServerId: "srv-1" }) as never,
			);
			vi.mocked(executeMcpTool).mockResolvedValue(
				NOT_FOUND_OUTPUT as never,
			);

			await expect(
				syncWorkItemToPM({ ...baseInput, itemType: "bug" }),
			).rejects.toMatchObject({ type: "PmNotFoundError" });
			expect(upsertPendingChange).toHaveBeenCalledWith(
				expect.objectContaining({
					entityType: "STORY",
					proposedAction: "FLAG_MISSING",
				}),
			);
		});

		it("permission error (403) is NOT treated as missing → PmUpdateError, no FLAG_MISSING", async () => {
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({ externalMcpServerId: "srv-1" }) as never,
			);
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: false,
				output: { error: "403 Forbidden: access denied" },
			} as never);

			await expect(syncWorkItemToPM(baseInput)).rejects.toMatchObject({
				type: "PmUpdateError",
			});
			expect(upsertPendingChange).not.toHaveBeenCalled();
		});

		it("a FLAG_MISSING write failure is swallowed and does not mask the PmNotFoundError", async () => {
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({ externalMcpServerId: "srv-1" }) as never,
			);
			vi.mocked(executeMcpTool).mockResolvedValue(
				NOT_FOUND_OUTPUT as never,
			);
			vi.mocked(upsertPendingChange).mockRejectedValueOnce(
				new Error("db unavailable"),
			);

			await expect(syncWorkItemToPM(baseInput)).rejects.toMatchObject({
				type: "PmNotFoundError",
			});
		});
	});

	it("DB stamp failure after successful push → throws PmStampError", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: null }) as never,
		);
		userStoryUpdateMock.mockRejectedValueOnce(
			new Error("connection pool exhausted"),
		);

		await expect(syncWorkItemToPM(baseInput)).rejects.toMatchObject({
			type: "PmStampError",
		});
	});

	it("adapter throws on push → ApplicationFailure propagates", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({ lastSyncedPmHash: null }) as never,
		);
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName } = args as { toolName: string };
			if (toolName === "update_card") {
				throw new Error("boom");
			}
			return { success: true, output: {} } as never;
		});

		await expect(syncWorkItemToPM(baseInput)).rejects.toThrow();
		expect(userStoryUpdateMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ lastPmSyncStatus: "SUCCESS" }),
			}),
		);
	});

	// Round-trip: the hash baseline must equal what fetchPmTicket reads back
	// from the PM tool — i.e. the transformed string we pushed, NOT the raw
	// markdown stored in Fabric. Otherwise every subsequent sync sees a
	// false CONFLICT.
	it("HTML tool with AC → baseline hash matches the pushed transformed body", async () => {
		const storySync = (await import("../story-sync")) as unknown as {
			HTML_DESCRIPTION_TOOLS: Set<string>;
			markdownToSimpleHtml: ReturnType<typeof vi.fn>;
			__realMarkdownToSimpleHtml: (s: string) => string;
		};
		// Switch the shared mock to use the real transforms for this test.
		storySync.HTML_DESCRIPTION_TOOLS.add("fizzy");
		storySync.markdownToSimpleHtml.mockImplementation(
			storySync.__realMarkdownToSimpleHtml,
		);

		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({
				description: "Body **bold** text",
				acceptanceCriteria: "- One\n- Two",
				lastSyncedPmHash: null,
			}) as never,
		);

		let pushedDescription: string | undefined;
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName, args: callArgs } = args as {
				toolName: string;
				args: Record<string, unknown>;
			};
			if (toolName === "update_card") {
				pushedDescription = callArgs.description as string;
				return { success: true, output: {} } as never;
			}
			return { success: true, output: {} } as never;
		});

		const result = await syncWorkItemToPM(baseInput);

		// Cleanup so other tests aren't polluted.
		storySync.HTML_DESCRIPTION_TOOLS.delete("fizzy");
		storySync.markdownToSimpleHtml.mockImplementation((s: string) => s);

		expect(result.status).toBe("SUCCESS");
		expect(pushedDescription).toBeDefined();
		expect(pushedDescription).toContain("<strong>bold</strong>");

		// The stamped baseline hash must equal hashing the body that was
		// actually sent to PM (which is what fetchPmTicket will return on
		// the next sync). Hashing item.description (raw markdown) is the
		// bug we are fixing.
		const expectedHash = computePmHash(STORY_TITLE, pushedDescription);
		const rawMarkdownHash = computePmHash(
			STORY_TITLE,
			"Body **bold** text",
		);
		expect(expectedHash).not.toEqual(rawMarkdownHash);
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastSyncedPmHash: expectedHash,
				}),
			}),
		);
	});

	it("plain-text tool with AC → baseline hash matches the stripped body", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({
				description: "Body **bold** text",
				acceptanceCriteria: "Done when X",
				lastSyncedPmHash: null,
			}) as never,
		);

		let pushedDescription: string | undefined;
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName, args: callArgs } = args as {
				toolName: string;
				args: Record<string, unknown>;
			};
			if (toolName === "update_card") {
				pushedDescription = callArgs.description as string;
				return { success: true, output: {} } as never;
			}
			return { success: true, output: {} } as never;
		});

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		expect(pushedDescription).toBeDefined();
		// stripMarkdownForPlainText strips the ** markers
		expect(pushedDescription).toContain("Body bold text");
		expect(pushedDescription).not.toContain("**bold**");

		const expectedHash = computePmHash(STORY_TITLE, pushedDescription);
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastSyncedPmHash: expectedHash,
				}),
			}),
		);
	});

	// Verifies that the AI Update / hierarchy sync push path
	// (`syncWorkItemToPM`) shares the same table + media transforms as the
	// user-initiated sync path (`syncStoryToPM`). Without this, AI Update
	// generates new content with a Tiptap table → push → table escaped/
	// stripped in the PM tool. See bug spec ACs 1+2.
	describe("AI-Update push applies story-media + table transforms", () => {
		const TIPTAP_TABLE =
			'<table class="tiptap-table"><tbody><tr><th><p>Field</p></th><th><p>Value</p></th></tr><tr><td><p>A</p></td><td><p>1</p></td></tr></tbody></table>';

		it("Jira (plain-text branch) converts Fabric Tiptap tables to GFM markdown", async () => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
				...makeCapabilities(),
				detectedType: "jira",
			} as never);
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					description: TIPTAP_TABLE,
					acceptanceCriteria: null,
					lastSyncedPmHash: null,
				}) as never,
			);
			let pushedDescription: string | undefined;
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName, args: callArgs } = args as {
						toolName: string;
						args: Record<string, unknown>;
					};
					if (toolName === "update_card") {
						pushedDescription = callArgs.description as string;
						return { success: true, output: {} } as never;
					}
					return { success: true, output: {} } as never;
				},
			);

			const result = await syncWorkItemToPM(baseInput);

			expect(result.status).toBe("SUCCESS");
			expect(pushedDescription).toBeDefined();
			// HTML table → GFM markdown (renders natively in Jira).
			expect(pushedDescription).toContain("| Field | Value |");
			expect(pushedDescription).toContain("| --- | --- |");
			expect(pushedDescription).toContain("| A | 1 |");
			// No Tiptap markers leaked.
			expect(pushedDescription).not.toContain('class="tiptap-table"');
			expect(pushedDescription).not.toContain("<table");
		});

		it("HTML tool (Fizzy) emits a Lexxy <figure> table from a Tiptap source", async () => {
			const storySync = (await import("../story-sync")) as unknown as {
				HTML_DESCRIPTION_TOOLS: Set<string>;
				markdownToSimpleHtml: ReturnType<typeof vi.fn>;
				__realMarkdownToSimpleHtml: (s: string) => string;
			};
			storySync.HTML_DESCRIPTION_TOOLS.add("fizzy");
			storySync.markdownToSimpleHtml.mockImplementation(
				storySync.__realMarkdownToSimpleHtml,
			);

			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					description: TIPTAP_TABLE,
					acceptanceCriteria: null,
					lastSyncedPmHash: null,
				}) as never,
			);
			let pushedDescription: string | undefined;
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName, args: callArgs } = args as {
						toolName: string;
						args: Record<string, unknown>;
					};
					if (toolName === "update_card") {
						pushedDescription = callArgs.description as string;
						return { success: true, output: {} } as never;
					}
					return { success: true, output: {} } as never;
				},
			);

			const result = await syncWorkItemToPM(baseInput);

			// Cleanup so subsequent tests aren't polluted.
			storySync.HTML_DESCRIPTION_TOOLS.delete("fizzy");
			storySync.markdownToSimpleHtml.mockImplementation((s: string) => s);

			expect(result.status).toBe("SUCCESS");
			expect(pushedDescription).toContain(
				'<figure class="lexxy-content__table-wrapper">',
			);
			expect(pushedDescription).toContain(
				'<th class="lexxy-content__table-cell--header"><p>Field</p></th>',
			);
			expect(pushedDescription).toContain("<td><p>A</p></td>");
			expect(pushedDescription).not.toContain("&lt;table");
		});

		it("rewrites story-media ![alt](key) to signed URLs in the pushed body", async () => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
				...makeCapabilities(),
				detectedType: "jira",
			} as never);
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					description:
						"![flow](story-media/p/s/diagram.png)\n\n_caption_",
					acceptanceCriteria: null,
					lastSyncedPmHash: null,
				}) as never,
			);
			let pushedDescription: string | undefined;
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName, args: callArgs } = args as {
						toolName: string;
						args: Record<string, unknown>;
					};
					if (toolName === "update_card") {
						pushedDescription = callArgs.description as string;
						return { success: true, output: {} } as never;
					}
					return { success: true, output: {} } as never;
				},
			);

			const result = await syncWorkItemToPM(baseInput);

			expect(result.status).toBe("SUCCESS");
			expect(pushedDescription).toBeDefined();
			// Story-media key replaced with the mocked signed URL.
			expect(pushedDescription).toContain(
				"![flow](https://signed.example.com/story-media/p/s/diagram.png?Sig=test",
			);
			expect(pushedDescription).not.toMatch(
				/!\[flow\]\(story-media\/p\/s\/diagram\.png\)/,
			);
		});

		it("preserves pulled-from-PM HTML byte-for-byte (no Tiptap markers)", async () => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
				...makeCapabilities(),
				detectedType: "jira",
			} as never);
			const PULLED =
				"<p>Plain PM-tool description.</p><table><tbody><tr><td>A</td></tr></tbody></table>";
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					description: PULLED,
					acceptanceCriteria: null,
					lastSyncedPmHash: null,
				}) as never,
			);
			let pushedDescription: string | undefined;
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName, args: callArgs } = args as {
						toolName: string;
						args: Record<string, unknown>;
					};
					if (toolName === "update_card") {
						pushedDescription = callArgs.description as string;
						return { success: true, output: {} } as never;
					}
					return { success: true, output: {} } as never;
				},
			);

			await syncWorkItemToPM(baseInput);

			// HTML table preserved (no GFM conversion applied).
			expect(pushedDescription).toContain("<table><tbody>");
			expect(pushedDescription).toContain("<td>A</td>");
			expect(pushedDescription).not.toContain("| A |");
		});

		it("ADO push (AI Update path) sends clean HTML — not GFM markdown — for Fabric-authored tables", async () => {
			// ADO capability shape with `updatesBased` + `fieldsBased` so the
			// update path lands on the JSON-Patch branch (which has no
			// format hint) and the create path on the fields-array branch.
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
				hasPMCapabilities: true,
				containerHierarchy: [],
				availableTools: [
					"wit_update_work_item",
					"wit_get_work_item",
					"wit_create_work_item",
				],
				detectedType: "azure-devops",
				taskUpdate: {
					toolName: "wit_update_work_item",
					idParam: "id",
					updatesBased: { updatesParam: "updates" },
					allParams: [
						{ name: "id", type: "number", required: true },
						{ name: "updates", type: "array", required: true },
					],
				},
				taskCreation: {
					toolName: "wit_create_work_item",
					containerParam: "project",
					fieldsBased: {
						workItemTypeParam: "workItemType",
						fieldsParam: "fields",
						titleKey: "System.Title",
						descriptionKey: "System.Description",
					},
					allParams: [
						{ name: "project", type: "string", required: true },
						{
							name: "workItemType",
							type: "string",
							required: true,
						},
						{ name: "fields", type: "array", required: true },
					],
				},
				taskGet: {
					toolName: "wit_get_work_item",
					idParam: "id",
					additionalRequiredParams: [],
					allParams: [{ name: "id", type: "number", required: true }],
				},
			} as never);
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: "42",
					description: TIPTAP_TABLE,
					acceptanceCriteria: null,
					lastSyncedPmHash: null,
				}) as never,
			);
			let pushedUpdates:
				| Array<{ path: string; value: string }>
				| undefined;
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName, args: callArgs } = args as {
						toolName: string;
						args: Record<string, unknown>;
					};
					if (toolName === "wit_update_work_item") {
						pushedUpdates = callArgs.updates as Array<{
							path: string;
							value: string;
						}>;
						return { success: true, output: {} } as never;
					}
					return { success: true, output: {} } as never;
				},
			);

			const result = await syncWorkItemToPM(baseInput);

			expect(result.status).toBe("SUCCESS");
			const descEntry = pushedUpdates?.find(
				(u) => u.path === "/fields/System.Description",
			);
			expect(descEntry).toBeDefined();
			const desc = descEntry?.value ?? "";
			// Clean HTML preserved.
			expect(desc).toContain("<table>");
			expect(desc).toContain("<th>Field</th>");
			expect(desc).toContain("<td>A</td>");
			// Tiptap noise stripped.
			expect(desc).not.toContain("tiptap-table");
			expect(desc).not.toContain("colspan=");
			// And — regression guard — NO GFM markdown pipes.
			expect(desc).not.toContain("| Field |");
			expect(desc).not.toContain("| --- |");
		});
	});

	// PM tool mismatch detection. Without these guards, a story whose
	// externalId was stamped by a previous PM tool (e.g. project migrated
	// from Fizzy to Azure DevOps) gets fed to `wit_update_work_item`, where
	// ADO's `z.coerce.number()` rejects the non-numeric Fizzy ULID with
	// "Expected number, received nan". The guards either block (hard
	// signal: `externalMcpServerId` set to a different server) or silently
	// clear + re-create (legacy rows with no server-id stamp).
	describe("cross-tool migration safety", () => {
		const adoCapabilities = {
			hasPMCapabilities: true,
			containerHierarchy: [],
			availableTools: [
				"wit_update_work_item",
				"wit_get_work_item",
				"wit_create_work_item",
			],
			detectedType: "azure-devops",
			taskUpdate: {
				toolName: "wit_update_work_item",
				idParam: "id",
				updatesBased: {
					updatesParam: "updates",
				},
				allParams: [
					{ name: "id", type: "number", required: true },
					{ name: "updates", type: "array", required: true },
				],
			},
			taskCreation: {
				toolName: "wit_create_work_item",
				containerParam: "project",
				fieldsBased: {
					workItemTypeParam: "workItemType",
					fieldsParam: "fields",
					titleKey: "System.Title",
					descriptionKey: "System.Description",
				},
				allParams: [
					{ name: "project", type: "string", required: true },
					{ name: "workItemType", type: "string", required: true },
					{ name: "fields", type: "array", required: true },
				],
			},
			taskGet: {
				toolName: "wit_get_work_item",
				idParam: "id",
				additionalRequiredParams: [],
				allParams: [{ name: "id", type: "number", required: true }],
			},
		};

		it("legacy story with Fizzy URL + no externalMcpServerId → clears stale link, takes CREATE path", async () => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
				adoCapabilities as never,
			);
			// F-004 from staging: Fizzy ULID-style externalId, fizzy.do URL,
			// no externalMcpServerId (predates the column).
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: "03fzkovwwbnhh82sk1hfprp7p",
					externalUrl: "https://app.fizzy.do/000000/cards/1075",
					externalMcpServerId: null,
					lastSyncedPmHash: null,
				}) as never,
			);
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName } = args as { toolName: string };
					if (toolName === "wit_create_work_item") {
						return {
							success: true,
							output: {
								id: 1234,
								_links: {
									web: {
										href: "https://dev.azure.com/tf/proj/_workitems/edit/1234",
									},
								},
							},
						} as never;
					}
					return { success: true, output: {} } as never;
				},
			);

			const result = await syncWorkItemToPM({
				...baseInput,
				containerName: "MyProject",
			});

			expect(result.status).toBe("SUCCESS");
			const toolNames = vi
				.mocked(executeMcpTool)
				.mock.calls.map(
					([arg]) => (arg as { toolName: string }).toolName,
				);
			expect(toolNames).toContain("wit_create_work_item");
			expect(toolNames).not.toContain("wit_update_work_item");
			// Stale link should have been nulled out before the create.
			expect(vi.mocked(updateStory)).toHaveBeenCalledWith(
				STORY_ID,
				PROJECT_ID,
				expect.objectContaining({
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
				}),
				{ lastEditedSource: "PM_PULL" },
			);
			// And after the create succeeds, the new ADO id should be
			// stamped back (URL extraction depends on
			// `extractExternalInfo` behavior tested elsewhere).
			expect(vi.mocked(updateStory)).toHaveBeenCalledWith(
				STORY_ID,
				PROJECT_ID,
				expect.objectContaining({ externalId: "1234" }),
				{ lastEditedSource: "PM_PULL" },
			);
		});

		it("story with externalMcpServerId pointing at a different active server → throws PmToolMismatchError, no PM call", async () => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
				adoCapabilities as never,
			);
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: "1101",
					externalUrl: "https://app.fizzy.do/000000/cards/1101",
					externalMcpServerId: "mcp-server-fizzy",
					lastSyncedPmHash: null,
				}) as never,
			);
			// Active MCP config points at the ADO server.
			const { db } = (await import("@repo/database")) as unknown as {
				db: {
					mCPConfig: {
						findUnique: ReturnType<typeof vi.fn>;
					};
				};
			};
			db.mCPConfig.findUnique.mockResolvedValueOnce({
				baseUrl: null,
				mcpServerId: "mcp-server-ado",
				mcpServer: { defaultUrl: null },
			});

			await expect(
				syncWorkItemToPM({
					...baseInput,
					containerName: "MyProject",
				}),
			).rejects.toThrow(/different PM tool/i);

			expect(executeMcpTool).not.toHaveBeenCalled();
		});

		it("numeric externalId from current ADO server → updates (no false-positive clear)", async () => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
				adoCapabilities as never,
			);
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: "99",
					externalUrl:
						"https://dev.azure.com/example-org/proj/_workitems/edit/99",
					externalMcpServerId: null,
					lastSyncedPmHash: null,
				}) as never,
			);

			const result = await syncWorkItemToPM({
				...baseInput,
				containerName: "MyProject",
			});

			expect(result.status).toBe("SUCCESS");
			const toolNames = vi
				.mocked(executeMcpTool)
				.mock.calls.map(
					([arg]) => (arg as { toolName: string }).toolName,
				);
			expect(toolNames).toContain("wit_update_work_item");
			expect(toolNames).not.toContain("wit_create_work_item");
		});
	});

	describe("FEATURE_PM_TYPE_MAPPING — wit_create_work_item work-item-type resolution", () => {
		const adoCapabilitiesForMapping = {
			hasPMCapabilities: true,
			containerHierarchy: [],
			availableTools: [
				"wit_update_work_item",
				"wit_get_work_item",
				"wit_create_work_item",
			],
			detectedType: "azure-devops",
			taskUpdate: {
				toolName: "wit_update_work_item",
				idParam: "id",
				updatesBased: { updatesParam: "updates" },
				allParams: [
					{ name: "id", type: "number", required: true },
					{ name: "updates", type: "array", required: true },
				],
			},
			taskCreation: {
				toolName: "wit_create_work_item",
				containerParam: "project",
				fieldsBased: {
					workItemTypeParam: "workItemType",
					fieldsParam: "fields",
					titleKey: "System.Title",
					descriptionKey: "System.Description",
				},
				allParams: [
					{ name: "project", type: "string", required: true },
					{ name: "workItemType", type: "string", required: true },
					{ name: "fields", type: "array", required: true },
				],
			},
			taskGet: {
				toolName: "wit_get_work_item",
				idParam: "id",
				additionalRequiredParams: [],
				allParams: [{ name: "id", type: "number", required: true }],
			},
		};

		beforeEach(() => {
			vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
				adoCapabilitiesForMapping as never,
			);
			vi.mocked(executeMcpTool).mockImplementation(
				async (args: unknown) => {
					const { toolName } = args as { toolName: string };
					if (toolName === "wit_create_work_item") {
						return {
							success: true,
							output: {
								id: 999,
								_links: {
									web: {
										href: "https://dev.azure.com/tf/proj/_workitems/edit/999",
									},
								},
							},
						} as never;
					}
					return { success: true, output: {} } as never;
				},
			);
		});

		afterEach(() => {
			delete process.env.FEATURE_PM_TYPE_MAPPING;
		});

		it("flag ON + mapping FEATURE→Epic → wit_create_work_item receives workItemType='Epic'", async () => {
			process.env.FEATURE_PM_TYPE_MAPPING = "true";
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
					lastSyncedPmHash: null,
					kind: "FEATURE",
				}) as never,
			);

			const result = await syncWorkItemToPM({
				...baseInput,
				containerName: "MyProject",
				additionalContext: {
					workItemTypeMapping: { FEATURE: "Epic" },
				} as never,
			});

			expect(result.status).toBe("SUCCESS");
			const createCall = vi
				.mocked(executeMcpTool)
				.mock.calls.find(
					([arg]) =>
						(arg as { toolName: string }).toolName ===
						"wit_create_work_item",
				);
			expect(createCall).toBeDefined();
			const createArgs = (
				createCall as [{ args: Record<string, unknown> }]
			)[0].args;
			expect(createArgs.workItemType).toBe("Epic");
		});

		it("flag ON + no mapping → wit_create_work_item receives legacyFallback 'User Story'", async () => {
			process.env.FEATURE_PM_TYPE_MAPPING = "true";
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
					lastSyncedPmHash: null,
					kind: "FEATURE",
				}) as never,
			);

			const result = await syncWorkItemToPM({
				...baseInput,
				containerName: "MyProject",
			});

			expect(result.status).toBe("SUCCESS");
			const createCall = vi
				.mocked(executeMcpTool)
				.mock.calls.find(
					([arg]) =>
						(arg as { toolName: string }).toolName ===
						"wit_create_work_item",
				);
			expect(createCall).toBeDefined();
			const createArgs = (
				createCall as [{ args: Record<string, unknown> }]
			)[0].args;
			expect(createArgs.workItemType).toBe("User Story");
		});

		it("flag OFF → wit_create_work_item receives legacyFallback 'User Story' regardless of mapping", async () => {
			vi.mocked(getStoryById).mockResolvedValue(
				makeStory({
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
					lastSyncedPmHash: null,
					kind: "FEATURE",
				}) as never,
			);

			const result = await syncWorkItemToPM({
				...baseInput,
				containerName: "MyProject",
				additionalContext: {
					workItemTypeMapping: { FEATURE: "Epic" },
				} as never,
			});

			expect(result.status).toBe("SUCCESS");
			const createCall = vi
				.mocked(executeMcpTool)
				.mock.calls.find(
					([arg]) =>
						(arg as { toolName: string }).toolName ===
						"wit_create_work_item",
				);
			expect(createCall).toBeDefined();
			const createArgs = (
				createCall as [{ args: Record<string, unknown> }]
			)[0].args;
			expect(createArgs.workItemType).toBe("User Story");
		});
	});
});

// Legacy feature/epic item types: the Epic/Feature folder tables were
// dropped, so syncWorkItemToPM fails fast with PmCapabilitiesError before
// touching the DB or the PM tool. (Persisted Temporal histories may still
// carry these item types.)
describe.each(["feature", "epic"] as const)(
	"syncWorkItemToPM (legacy %s fail-fast)",
	(itemType) => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("throws PmCapabilitiesError without any DB or MCP access", async () => {
			await expect(
				syncWorkItemToPM({
					itemType,
					itemId: `${itemType}-1`,
					projectId: PROJECT_ID,
					mcpConfigId: "mcp-1",
					containerId: "board-1",
					userId: "user-1",
					triggerSource: "ai-update" as const,
				}),
			).rejects.toMatchObject({ type: "PmCapabilitiesError" });

			expect(executeMcpTool).not.toHaveBeenCalled();
			expect(getStoryById).not.toHaveBeenCalled();
			expect(userStoryUpdateMock).not.toHaveBeenCalled();
		});
	},
);

describe("readbackPmCanonicalHash", () => {
	const READBACK_INPUT = {
		mcpConfigId: "mcp-1",
		containerId: "board-1",
		externalId: EXTERNAL_ID,
		userId: "user-1",
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("hashes the content the PM tool STORED (re-rendered), not the pushed content", async () => {
		vi.mocked(fetchPMItemsByIds).mockResolvedValue({
			items: [
				{
					id: EXTERNAL_ID,
					title: "Stored title",
					description: "Re-rendered <action-text-attachment> body",
				},
			],
			hasNextPage: false,
			failedIds: [],
			notFoundIds: [],
		});

		const hash = await readbackPmCanonicalHash(READBACK_INPUT);

		expect(hash).toBe(
			computePmHash(
				"Stored title",
				"Re-rendered <action-text-attachment> body",
			),
		);
		// Reused the poll's exact fetch for just the pushed item.
		expect(fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: "mcp-1",
				containerId: "board-1",
				externalIds: [EXTERNAL_ID],
				userId: "user-1",
			}),
		);
	});

	it("matches the poll's drift hash byte-for-byte (lock-step, no false negatives)", async () => {
		// The poll hashes normalizePolledState(item).title/description; the
		// readback hashes item.title/description. normalizePolledState passes
		// title/description through unchanged, so the two MUST stay identical —
		// this is what guarantees a genuine external edit still registers as drift.
		const item = {
			id: EXTERNAL_ID,
			title: "Stored title",
			description: "Stored body",
			raw: { column: { name: "In Progress" } },
		};
		vi.mocked(fetchPMItemsByIds).mockResolvedValue({
			items: [item],
			hasNextPage: false,
		});

		const readbackHash = await readbackPmCanonicalHash(READBACK_INPUT);

		const polled = normalizePolledState(item, {
			kind: "mcp",
			pmTool: "fizzy",
		});
		const pollHash = computePmHash(polled.title, polled.description);

		expect(readbackHash).toBe(pollHash);
	});

	it("returns null on fetch error → caller falls back to the pushed-content hash", async () => {
		vi.mocked(fetchPMItemsByIds).mockRejectedValue(
			new Error("MCP timeout"),
		);
		expect(await readbackPmCanonicalHash(READBACK_INPUT)).toBeNull();
	});

	it("returns null when the item was not found (no baseline guess)", async () => {
		vi.mocked(fetchPMItemsByIds).mockResolvedValue({
			items: [],
			hasNextPage: false,
			failedIds: [EXTERNAL_ID],
			notFoundIds: [EXTERNAL_ID],
		});
		expect(await readbackPmCanonicalHash(READBACK_INPUT)).toBeNull();
	});

	it("returns null when the fetch yields no items", async () => {
		vi.mocked(fetchPMItemsByIds).mockResolvedValue({
			items: [],
			hasNextPage: false,
		});
		expect(await readbackPmCanonicalHash(READBACK_INPUT)).toBeNull();
	});
});

describe("stampPmSyncSuccess — pmCanonicalHash baseline", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		userStoryUpdateMock.mockResolvedValue({});
	});

	it("baselines lastSyncedPmHash from pmCanonicalHash (the readback) when provided", async () => {
		await stampPmSyncSuccess({
			itemType: "story",
			itemId: STORY_ID,
			title: "pushed title",
			description: "pushed description",
			pmCanonicalHash: "READBACK_HASH",
		});

		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: STORY_ID },
				data: expect.objectContaining({
					lastSyncedPmHash: "READBACK_HASH",
					lastPmSyncStatus: "SUCCESS",
				}),
			}),
		);
	});

	it("falls back to hashing the pushed content when pmCanonicalHash is null or omitted", async () => {
		const expected = computePmHash("pushed title", "pushed description");

		await stampPmSyncSuccess({
			itemType: "story",
			itemId: STORY_ID,
			title: "pushed title",
			description: "pushed description",
			pmCanonicalHash: null,
		});
		expect(userStoryUpdateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ lastSyncedPmHash: expected }),
			}),
		);

		await stampPmSyncSuccess({
			itemType: "story",
			itemId: STORY_ID,
			title: "pushed title",
			description: "pushed description",
		});
		expect(userStoryUpdateMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ lastSyncedPmHash: expected }),
			}),
		);
	});
});

describe("failed-media placeholders are stripped before the AI-update push", () => {
	// The pull ingester substitutes `[Image could not be imported …]` when a
	// PM-tool attachment can't be downloaded (Fizzy card 2027). Pushing that
	// token back overwrites the live attachment reference in the PM tool — the
	// real `_apis/wit/attachments/…` markup becomes inert text and the image is
	// gone from the work item. `syncStoryToPM` and `syncGitLabStoryViaRest`
	// both strip it; this path (AI-update / hierarchy) must too.
	const PLACEHOLDER =
		"[Image could not be imported from Azure DevOps: shot.png]";

	beforeEach(() => {
		vi.clearAllMocks();
		userStoryUpdateMock.mockResolvedValue({});
		userStoryUpdateManyMock.mockResolvedValue({});
		vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
			makeCapabilities() as never,
		);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {},
		} as never);
	});

	function pushedDescription(): string {
		const call = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				([arg]) =>
					(arg as { toolName: string }).toolName === "update_card",
			);
		if (!call) {
			throw new Error("update_card was never called");
		}
		return String(
			(call[0] as { args: Record<string, unknown> }).args.description ??
				"",
		);
	}

	it("does not push an image placeholder to the PM tool", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({
				description: `<p>Before</p><p><em>${PLACEHOLDER}</em></p><p>After</p>`,
			}) as never,
		);

		await syncWorkItemToPM(baseInput);

		expect(pushedDescription()).not.toContain("could not be imported");
	});

	it("keeps the surrounding description when stripping", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeStory({
				description: `<p>Before</p><p><em>${PLACEHOLDER}</em></p><p>After</p>`,
			}) as never,
		);

		await syncWorkItemToPM(baseInput);

		expect(pushedDescription()).toContain("Before");
		expect(pushedDescription()).toContain("After");
	});
});
