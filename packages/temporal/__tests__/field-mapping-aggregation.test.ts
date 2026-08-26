/**
 * Replace-mode aggregation matrix.
 *
 * Covers the 8 cases: no-config → legacy precedence chain (regression guard);
 * empty `fields[]` → legacy; provider mismatch → legacy; flag off → legacy despite
 * a valid saved config (flag reverts BACKEND behavior, not just UI); valid + match
 * + flag on → `##`-headed body in configured order with empty fields omitted and
 * HTML converted via `simpleHtmlToMarkdown` (REPLACES, does not augment, the legacy
 * body); a configured field absent from the output is skipped (no throw); all
 * configured fields empty → `description: undefined` (don't clobber — no legacy
 * leak); title always preserved.
 *
 * Drives the pure `evaluateReplaceModeActivation` + `assembleFieldMappingDescription`
 * plus at least one end-to-end `parsePMItemFromGetOutput` assertion per branch.
 *
 * Mock header copied verbatim from `story-sync.test.ts` (adds `deleteStory`,
 * `getMcpConfigById`, `readFieldMappingConfig` as `vi.fn()`): importing the real
 * `@repo/database` keeps pg.Pool handles alive past vitest exit (vitest #4373), so
 * the heavy/leaky modules are stubbed — the pure functions under test need nothing
 * from them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
	canMcpToolsHandleTask: vi
		.fn()
		.mockReturnValue({ canHandle: false, matchedTools: [] }),
	generateMemoryContext: vi
		.fn()
		.mockResolvedValue({ contextString: "", memoryCount: 0 }),
	getConfiguredAIModel: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		getSignedUrl: vi.fn(
			async (key: string) =>
				`https://signed.example.com/${key}?Sig=test&Expires=999999`,
		),
	})),
	deleteObjects: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		storyTask: { findUnique: vi.fn() },
		organization: { findUnique: vi.fn() },
		project: { findUnique: vi.fn() },
	},
	Prisma: {},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	listStoryStatuses: vi.fn(),
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateStory: vi.fn(),
	updateTask: vi.fn(),
	readFieldMappingConfig: vi.fn(),
	buildFabricStoryUrl: vi.fn(),
	appendFabricBackLink: (description: string | null | undefined) =>
		description ?? "",
	HTML_BACK_LINK_RE: /View in Fabric/i,
	formatBackLinkForProvider: (description: string | null | undefined) =>
		description ?? "",
	normalizeBackLinkFromProvider: (description: string | null | undefined) =>
		description ?? "",
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: vi.fn(),
}));

vi.mock(
	"../src/activities/pm-integration/reconcile-story-terminal-status",
	() => ({
		reconcileStoryTerminalStatus: vi.fn(),
	}),
);

import type { FieldMappingConfig } from "@repo/database";
import {
	assembleFieldMappingDescription,
	evaluateReplaceModeActivation,
	parsePMItemFromGetOutput,
	simpleHtmlToMarkdown,
} from "../src/activities/pm-integration/story-sync";

// =============================================================================
// Fixtures
// =============================================================================

const BUSINESS_RULES_HTML = "<p>Must follow <strong>rules</strong></p>";
const ACCEPTANCE_HTML = "<p>Given X <em>when</em> Y then Z</p>";
const LEGACY_DESCRIPTION_HTML = "<p>Legacy description body</p>";
const REPRO_STEPS_HTML = "<p>Repro steps body</p>";

/** A representative ADO `get` output: everything is nested under `fields`. */
function adoOutput(fields: Record<string, unknown>) {
	return { fields: { "System.Title": "Example work item", ...fields } };
}

const FULL_FIELDS = {
	"System.Description": LEGACY_DESCRIPTION_HTML,
	"Microsoft.VSTS.TCM.ReproSteps": REPRO_STEPS_HTML,
	"System.History": "history entry",
	"Custom.BusinessRules": BUSINESS_RULES_HTML,
	"Microsoft.VSTS.Common.AcceptanceCriteria": ACCEPTANCE_HTML,
};

const CONFIG: FieldMappingConfig = {
	provider: "azure-devops",
	fields: [
		{ id: "Custom.BusinessRules", displayName: "Business Rules" },
		{
			id: "Microsoft.VSTS.Common.AcceptanceCriteria",
			displayName: "Acceptance Criteria",
		},
	],
};

/** Baseline replace-mode options — perturb exactly one dimension per case. */
const ACTIVE_OPTIONS = {
	connectedProvider: "azure-devops",
	config: CONFIG,
	enabled: true,
} as const;

// The exact body the spec mandates for the active config against FULL_FIELDS:
// each configured field in order, `## <displayName>` + value converted via
// simpleHtmlToMarkdown, empty sections omitted, blank line between sections.
const EXPECTED_ACTIVE_BODY = [
	`## Business Rules\n\n${simpleHtmlToMarkdown(BUSINESS_RULES_HTML).trim()}`,
	`## Acceptance Criteria\n\n${simpleHtmlToMarkdown(ACCEPTANCE_HTML).trim()}`,
].join("\n\n");

// =============================================================================
// evaluateReplaceModeActivation — pure activation matrix
// =============================================================================

describe("evaluateReplaceModeActivation", () => {
	it("engages only when config + provider match + flag on all hold", () => {
		expect(evaluateReplaceModeActivation(ACTIVE_OPTIONS)).toEqual({
			engaged: true,
			reason: "engaged",
		});
	});

	it("no config → not engaged (reason: no-config)", () => {
		expect(
			evaluateReplaceModeActivation({ ...ACTIVE_OPTIONS, config: null }),
		).toEqual({ engaged: false, reason: "no-config" });
	});

	it("empty fields[] → not engaged (reason: empty-selection)", () => {
		expect(
			evaluateReplaceModeActivation({
				...ACTIVE_OPTIONS,
				config: { provider: "azure-devops", fields: [] },
			}),
		).toEqual({ engaged: false, reason: "empty-selection" });
	});

	it("provider mismatch → not engaged (reason: provider-mismatch)", () => {
		expect(
			evaluateReplaceModeActivation({
				...ACTIVE_OPTIONS,
				connectedProvider: "jira",
			}),
		).toEqual({ engaged: false, reason: "provider-mismatch" });
	});

	it("flag off → not engaged (reason: flag-off) even with a valid config", () => {
		expect(
			evaluateReplaceModeActivation({
				...ACTIVE_OPTIONS,
				enabled: false,
			}),
		).toEqual({ engaged: false, reason: "flag-off" });
	});
});

// =============================================================================
// assembleFieldMappingDescription — pure assembly
// =============================================================================

describe("assembleFieldMappingDescription", () => {
	it("emits `##`-headed sections in configured order, HTML converted", () => {
		const body = assembleFieldMappingDescription(FULL_FIELDS, CONFIG);
		expect(body).toBe(EXPECTED_ACTIVE_BODY);
		// Conversion actually happened — no raw HTML tags survive.
		expect(body).not.toContain("<p>");
		expect(body).not.toContain("<strong>");
	});

	it("REPLACES rather than augments — non-configured fields never appear", () => {
		const body = assembleFieldMappingDescription(FULL_FIELDS, CONFIG);
		expect(body).not.toContain("Legacy description body");
		expect(body).not.toContain("Repro steps body");
		expect(body).not.toContain("history entry");
	});

	it("omits empty/blank/absent configured fields entirely (no placeholder)", () => {
		const body = assembleFieldMappingDescription(
			{
				"Custom.BusinessRules": BUSINESS_RULES_HTML,
				"Microsoft.VSTS.Common.AcceptanceCriteria": "", // blank → omitted
				// Custom.DesignCriteria absent entirely below
			},
			{
				provider: "azure-devops",
				fields: [
					{
						id: "Custom.BusinessRules",
						displayName: "Business Rules",
					},
					{
						id: "Microsoft.VSTS.Common.AcceptanceCriteria",
						displayName: "Acceptance Criteria",
					},
					{
						id: "Custom.DesignCriteria",
						displayName: "Design Criteria",
					},
				],
			},
		);
		expect(body).toBe(
			`## Business Rules\n\n${simpleHtmlToMarkdown(BUSINESS_RULES_HTML).trim()}`,
		);
		expect(body).not.toContain("Acceptance Criteria");
		expect(body).not.toContain("Design Criteria");
	});

	it("returns undefined when every configured field is blank/absent", () => {
		expect(
			assembleFieldMappingDescription(
				{ "Custom.BusinessRules": "   " },
				CONFIG,
			),
		).toBeUndefined();
	});

	it("returns undefined when the ADO output has no fields object", () => {
		expect(
			assembleFieldMappingDescription(undefined, CONFIG),
		).toBeUndefined();
	});

	it("stringifies numeric/boolean field values", () => {
		const body = assembleFieldMappingDescription(
			{ "Custom.Points": 5, "Custom.Flag": true },
			{
				provider: "azure-devops",
				fields: [
					{ id: "Custom.Points", displayName: "Points" },
					{ id: "Custom.Flag", displayName: "Flag" },
				],
			},
		);
		expect(body).toBe("## Points\n\n5\n\n## Flag\n\ntrue");
	});
});

// =============================================================================
// parsePMItemFromGetOutput — end-to-end per branch
// =============================================================================

describe("parsePMItemFromGetOutput — replace-mode branches", () => {
	it("no config → legacy behavior byte-for-byte (no fieldMapping option)", () => {
		const result = parsePMItemFromGetOutput(adoOutput(FULL_FIELDS));
		// Legacy ADO chain: ReproSteps wins first.
		expect(result.description).toBe(REPRO_STEPS_HTML);
		expect(result.title).toBe("Example work item");
	});

	it("no config (config: null) → legacy chain", () => {
		const result = parsePMItemFromGetOutput(adoOutput(FULL_FIELDS), {
			fieldMapping: { ...ACTIVE_OPTIONS, config: null },
		});
		expect(result.description).toBe(REPRO_STEPS_HTML);
	});

	it("legacy chain honors ReproSteps → System.Description → System.History", () => {
		// No ReproSteps → System.Description.
		expect(
			parsePMItemFromGetOutput(
				adoOutput({
					"System.Description": LEGACY_DESCRIPTION_HTML,
					"System.History": "history entry",
				}),
			).description,
		).toBe(LEGACY_DESCRIPTION_HTML);
		// Only History → System.History.
		expect(
			parsePMItemFromGetOutput(
				adoOutput({ "System.History": "history entry" }),
			).description,
		).toBe("history entry");
	});

	it("empty fields[] → legacy chain", () => {
		const result = parsePMItemFromGetOutput(adoOutput(FULL_FIELDS), {
			fieldMapping: {
				...ACTIVE_OPTIONS,
				config: { provider: "azure-devops", fields: [] },
			},
		});
		expect(result.description).toBe(REPRO_STEPS_HTML);
	});

	it("provider mismatch → legacy chain (config preserved but inactive)", () => {
		const result = parsePMItemFromGetOutput(adoOutput(FULL_FIELDS), {
			fieldMapping: { ...ACTIVE_OPTIONS, connectedProvider: "jira" },
		});
		expect(result.description).toBe(REPRO_STEPS_HTML);
	});

	it("flag OFF → legacy chain even with a valid saved config (backend reverts)", () => {
		const result = parsePMItemFromGetOutput(adoOutput(FULL_FIELDS), {
			fieldMapping: { ...ACTIVE_OPTIONS, enabled: false },
		});
		expect(result.description).toBe(REPRO_STEPS_HTML);
		// The assembled `##` body must NOT appear.
		expect(result.description).not.toContain("## Business Rules");
	});

	it("valid + match + flag on → `##`-headed body in order (replaces legacy)", () => {
		const result = parsePMItemFromGetOutput(adoOutput(FULL_FIELDS), {
			fieldMapping: ACTIVE_OPTIONS,
		});
		expect(result.description).toBe(EXPECTED_ACTIVE_BODY);
		// Replace, not augment: legacy ReproSteps/Description content is gone.
		expect(result.description).not.toContain("Repro steps body");
		expect(result.description).not.toContain("Legacy description body");
		expect(result.title).toBe("Example work item");
	});

	it("configured field absent from output → skipped gracefully (no throw)", () => {
		const result = parsePMItemFromGetOutput(
			adoOutput({ "Custom.BusinessRules": BUSINESS_RULES_HTML }),
			{
				fieldMapping: {
					...ACTIVE_OPTIONS,
					config: {
						provider: "azure-devops",
						fields: [
							{
								id: "Custom.Missing",
								displayName: "Missing Field",
							},
							{
								id: "Custom.BusinessRules",
								displayName: "Business Rules",
							},
						],
					},
				},
			},
		);
		expect(result.description).toBe(
			`## Business Rules\n\n${simpleHtmlToMarkdown(BUSINESS_RULES_HTML).trim()}`,
		);
		expect(result.description).not.toContain("Missing Field");
	});

	it("all configured fields empty → description: undefined (no legacy clobber)", () => {
		const result = parsePMItemFromGetOutput(
			adoOutput({
				// Legacy content present, but NOT configured — must not leak back.
				"System.Description": LEGACY_DESCRIPTION_HTML,
				"Microsoft.VSTS.TCM.ReproSteps": REPRO_STEPS_HTML,
				// Configured fields are blank/absent.
				"Custom.BusinessRules": "",
			}),
			{ fieldMapping: ACTIVE_OPTIONS },
		);
		expect(result.description).toBeUndefined();
		expect(result.title).toBe("Example work item");
	});
});
