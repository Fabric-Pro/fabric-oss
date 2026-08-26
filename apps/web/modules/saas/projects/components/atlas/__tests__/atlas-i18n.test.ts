import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";

/**
 * Locale parity for the Atlas surface.
 *
 * The status bar (credential states, branch editor) and the unified chat
 * assistant read every user-facing string from the `projects.atlas`
 * namespace. A key that exists in one locale but not the other renders as a
 * raw key path at runtime, so parity is asserted here for both directions:
 * every required key resolves to a non-empty string in BOTH locales, and the
 * retired mode-specific / credentials-expired keys are absent from BOTH.
 */

const ADDED_STATUS_KEYS = [
	"monitoringPaused",
	"monitoringPausedTooltip",
	"reconnect",
	"reconnectTooltip",
	"reconnectNeeded",
	"reconnectNeededTooltip",
	"patExpired",
	"patExpiredTooltip",
	// Fizzy #2252: the No-access state (credential fine, repo unreadable).
	"repoUnavailable",
	"repoUnavailableTooltip",
	"monitoringPausedRepoUnavailableTooltip",
	"reanalyzeDisabledRepo",
	"manageRepository",
	"reanalyzeDisabledPat",
	"reanalyzeDisabledReconnect",
	"editBranch",
	"branchPopoverTitle",
	"branchPopoverDescription",
	"branchInputLabel",
	"branchSave",
	"branchCancel",
	"branchSaved",
	"branchErrorNotFound",
	"branchErrorCredentials",
	"branchErrorNetwork",
	"branchErrorGeneric",
	"reanalyzeToApply",
	"commitDiffAriaAhead",
	"commitDiffAriaBehind",
	"commitDiffTooltipAhead",
	"commitDiffTooltipBehind",
	// Branch picker + pin toggles.
	"branchSearchPlaceholder",
	"branchListHeading",
	"branchEmpty",
	"branchListError",
	"branchUseCustom",
	"branchCurrent",
	"branchDefaultBadge",
	"pinBranch",
	"unpinBranch",
	"branchPinError",
	// Re-analyse split button (default vs from-fresh).
	"reanalyzeNormal",
	"reanalyzeNormalHint",
	"reanalyzeFresh",
	"reanalyzeFreshHint",
	"analyzeOptions",
	// Non-blocking background re-analysis.
	"analyzingInBackground",
	"backgroundRunUpdated",
] as const;

// Analysis-history AI telemetry line (branch / model / tokens / cost) + the
// paginated history controls (total count, "Show more"). Plus the solo
// "re-map" run mode badges (keep / fresh) surfaced in the per-repo history.
const ADDED_HISTORY_KEYS = [
	"tokensCompact",
	"tokensTooltip",
	"costTooltip",
	"runsTotal",
	"showMore",
	"modeRemap",
	"modeRemapFresh",
] as const;

// "Re-map relationships" control (solo + system) — button/menu copy, the
// destructive fresh-reset confirmation, success/error toasts.
const ADDED_REMAP_KEYS = [
	"button",
	"soloButton",
	"systemButton",
	"keep",
	"keepHint",
	"fresh",
	"freshHint",
	"pending",
	"options",
	"confirmTitle",
	"confirmBody",
	"confirmAction",
	"cancel",
	"soloSuccess",
	"systemSuccess",
	"error",
] as const;

// System-map relationship (cross-link recompute) history panel.
const ADDED_SYSTEM_KEYS = ["remapHistoryTitle", "remapHistoryEmpty"] as const;

// The three trigger labels live nested under `system.remapTrigger`.
const ADDED_SYSTEM_REMAP_TRIGGER_KEYS = [
	"auto",
	"remap",
	"remap_fresh",
] as const;

const ADDED_CHAT_KEYS = [
	"assistantTitle",
	"interrupted",
	"turnNotSaved",
	"suggestionsLabel",
	// Grouped, paginated conversation-history view.
	"conversationsTotal",
	"conversationsClose",
	"conversationsShowMore",
	"conversationsBucketToday",
	"conversationsBucketYesterday",
	"conversationsBucketThisWeek",
	"conversationsBucketOlder",
] as const;

// The seven Atlas graph categories (node colour / legend / panel) must resolve
// in both locales — a missing key renders as a raw path on screen.
const ADDED_CATEGORY_KEYS = [
	"ai",
	"integration",
	"security",
	"infra",
	"data",
	"experience",
	"ops",
	// One-line meanings surfaced as hover tooltips in the legend + node card.
	"aiDesc",
	"integrationDesc",
	"securityDesc",
	"infraDesc",
	"dataDesc",
	"experienceDesc",
	"opsDesc",
] as const;

// Chat empty-state starter chips.
const ADDED_SUGGESTION_KEYS = [
	"authentication",
	"isolation",
	"schema",
	"capabilityDepends",
] as const;

// Node-card editable description / category / edit-history affordances. A missing
// key renders as a raw path on screen, so both locales must carry all of them.
const ADDED_NODE_KEYS = [
	"editDescription",
	"editPlaceholder",
	"editSave",
	"editCancel",
	"editClear",
	"editSaved",
	"editError",
	"editedByYou",
	"editedDescriptionHint",
	"regenerateAi",
	"regenerateOverrideNote",
	"editCategory",
	"categoryEditedByYou",
	"categorySearchPlaceholder",
	"categoryPresetsHeading",
	"categoryCustomHeading",
	"categoryUseCustom",
	"categoryEmpty",
	"categoryResetToAi",
	"history",
	"historyTitle",
	"historyEmpty",
	"historyError",
	"historyBy",
] as const;

// The two history-field labels live nested under `node.historyField`.
const ADDED_HISTORY_FIELD_KEYS = ["description", "category"] as const;

// Editable-connections (edge override) UI: the shared connections list + the
// edge detail panel. A missing key renders as a raw path on screen.
const ADDED_CONNECTIONS_KEYS = [
	"tab",
	"regionLabel",
	"searchPlaceholder",
	"searchAria",
	"showDeleted",
	"newConnection",
	"empty",
	"noMatches",
	"restore",
	"restoreSuccess",
	"restoreError",
	"createSource",
	"createTarget",
	"createKind",
	"createDescription",
	"createDescriptionPlaceholder",
	"createSelectNode",
	"createSearchNodes",
	"createNoNodes",
	"createSubmit",
	"createCancel",
	"createSuccess",
	"createError",
	// "(i)" info popover explaining what connections are (both maps).
	"info",
	"infoTitle",
	"infoBody",
] as const;

// Floating Save / Discard bar for staged structural graph edits (both maps).
const ADDED_STAGED_KEYS = [
	"unsavedCount",
	"save",
	"discard",
	"saveSuccess",
	"saveError",
] as const;

// Connection editor dialog (kind + description for a freshly-drawn / clicked
// provisional connection, both maps).
const ADDED_CONNECTION_EDITOR_KEYS = [
	"title",
	"kind",
	"description",
	"descriptionPlaceholder",
	"save",
	"remove",
	"cancel",
] as const;

const ADDED_EDGE_PANEL_KEYS = [
	"regionLabel",
	"close",
	"description",
	"manualBadge",
	"editedBadge",
	"deletedBadge",
	"editDescription",
	"editPlaceholder",
	"editSave",
	"editCancel",
	"editClear",
	"noDescription",
	"noDescriptionEditable",
	"showMore",
	"showLess",
	"history",
	"historyTitle",
	"historyEmpty",
	"historyError",
	"historyBy",
	"delete",
	"deleteConfirm",
	"deleteCancel",
	"deleteConfirmBody",
	"restore",
] as const;

// The four edge-history actions live nested under `edgePanel.historyAction`.
const ADDED_EDGE_HISTORY_ACTION_KEYS = [
	"created",
	"description",
	"deleted",
	"restored",
] as const;

// The new `graph.list` disclosure label (Nodes ⇄ Connections toggle button).
const ADDED_GRAPH_KEYS = ["list"] as const;

// On-map legend "Connections" section title (solo graph colours edges by kind).
const ADDED_LEGEND_KEYS = ["connectionsTitle"] as const;

const REMOVED_STATUS_KEYS = [
	"credentialsExpired",
	"credentialsExpiredTooltip",
	"reanalyzeDisabledExpired",
	// Replaced by the compact `+N −M` commit-diff indicator.
	"newCommits",
] as const;

const REMOVED_CHAT_KEYS = ["businessTitle", "technicalTitle"] as const;

type LocaleMessages = Record<string, unknown>;

function atlasSection(
	locale: LocaleMessages,
	section:
		| "status"
		| "chat"
		| "category"
		| "node"
		| "history"
		| "connections"
		| "edgePanel"
		| "graph"
		| "legend"
		| "remap"
		| "system"
		| "staged"
		| "connectionEditor",
) {
	const projects = locale.projects as Record<string, unknown> | undefined;
	const atlas = projects?.atlas as Record<string, unknown> | undefined;
	return (atlas?.[section] ?? {}) as Record<string, unknown>;
}

const locales: Array<{ name: "en" | "de"; messages: LocaleMessages }> = [
	{ name: "en", messages: en as LocaleMessages },
	{ name: "de", messages: de as LocaleMessages },
];

describe("atlas i18n parity", () => {
	for (const { name, messages } of locales) {
		describe(`${name} locale`, () => {
			const status = atlasSection(messages, "status");
			const chat = atlasSection(messages, "chat");
			const category = atlasSection(messages, "category");
			const nodeSection = atlasSection(messages, "node");
			const history = atlasSection(messages, "history");
			const connections = atlasSection(messages, "connections");
			const edgePanel = atlasSection(messages, "edgePanel");
			const graph = atlasSection(messages, "graph");
			const legend = atlasSection(messages, "legend");
			const remap = atlasSection(messages, "remap");
			const system = atlasSection(messages, "system");
			const staged = atlasSection(messages, "staged");
			const connectionEditor = atlasSection(messages, "connectionEditor");
			const systemRemapTrigger = (system.remapTrigger ?? {}) as Record<
				string,
				unknown
			>;
			const suggestions = (chat.suggestions ?? {}) as Record<
				string,
				unknown
			>;
			const historyField = (nodeSection.historyField ?? {}) as Record<
				string,
				unknown
			>;
			const edgeHistoryAction = (edgePanel.historyAction ?? {}) as Record<
				string,
				unknown
			>;

			it.each([...ADDED_STATUS_KEYS])(
				"projects.atlas.status.%s resolves to a non-empty string",
				(key) => {
					const value = status[key];
					expect(typeof value, `status.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_CHAT_KEYS])(
				"projects.atlas.chat.%s resolves to a non-empty string",
				(key) => {
					const value = chat[key];
					expect(typeof value, `chat.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_CATEGORY_KEYS])(
				"projects.atlas.category.%s resolves to a non-empty string",
				(key) => {
					const value = category[key];
					expect(
						typeof value,
						`category.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_SUGGESTION_KEYS])(
				"projects.atlas.chat.suggestions.%s resolves to a non-empty string",
				(key) => {
					const value = suggestions[key];
					expect(
						typeof value,
						`chat.suggestions.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_NODE_KEYS])(
				"projects.atlas.node.%s resolves to a non-empty string",
				(key) => {
					const value = nodeSection[key];
					expect(typeof value, `node.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_HISTORY_FIELD_KEYS])(
				"projects.atlas.node.historyField.%s resolves to a non-empty string",
				(key) => {
					const value = historyField[key];
					expect(
						typeof value,
						`node.historyField.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_HISTORY_KEYS])(
				"projects.atlas.history.%s resolves to a non-empty string",
				(key) => {
					const value = history[key];
					expect(typeof value, `history.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_CONNECTIONS_KEYS])(
				"projects.atlas.connections.%s resolves to a non-empty string",
				(key) => {
					const value = connections[key];
					expect(
						typeof value,
						`connections.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_EDGE_PANEL_KEYS])(
				"projects.atlas.edgePanel.%s resolves to a non-empty string",
				(key) => {
					const value = edgePanel[key];
					expect(
						typeof value,
						`edgePanel.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_EDGE_HISTORY_ACTION_KEYS])(
				"projects.atlas.edgePanel.historyAction.%s resolves to a non-empty string",
				(key) => {
					const value = edgeHistoryAction[key];
					expect(
						typeof value,
						`edgePanel.historyAction.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_GRAPH_KEYS])(
				"projects.atlas.graph.%s resolves to a non-empty string",
				(key) => {
					const value = graph[key];
					expect(typeof value, `graph.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_LEGEND_KEYS])(
				"projects.atlas.legend.%s resolves to a non-empty string",
				(key) => {
					const value = legend[key];
					expect(typeof value, `legend.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_REMAP_KEYS])(
				"projects.atlas.remap.%s resolves to a non-empty string",
				(key) => {
					const value = remap[key];
					expect(typeof value, `remap.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_SYSTEM_KEYS])(
				"projects.atlas.system.%s resolves to a non-empty string",
				(key) => {
					const value = system[key];
					expect(typeof value, `system.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_SYSTEM_REMAP_TRIGGER_KEYS])(
				"projects.atlas.system.remapTrigger.%s resolves to a non-empty string",
				(key) => {
					const value = systemRemapTrigger[key];
					expect(
						typeof value,
						`system.remapTrigger.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_STAGED_KEYS])(
				"projects.atlas.staged.%s resolves to a non-empty string",
				(key) => {
					const value = staged[key];
					expect(typeof value, `staged.${key} in ${name}.json`).toBe(
						"string",
					);
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...ADDED_CONNECTION_EDITOR_KEYS])(
				"projects.atlas.connectionEditor.%s resolves to a non-empty string",
				(key) => {
					const value = connectionEditor[key];
					expect(
						typeof value,
						`connectionEditor.${key} in ${name}.json`,
					).toBe("string");
					expect((value as string).trim().length).toBeGreaterThan(0);
				},
			);

			it.each([...REMOVED_STATUS_KEYS])(
				"retired key projects.atlas.status.%s is absent",
				(key) => {
					expect(
						status,
						`status.${key} should be gone from ${name}.json`,
					).not.toHaveProperty(key);
				},
			);

			it.each([...REMOVED_CHAT_KEYS])(
				"retired key projects.atlas.chat.%s is absent",
				(key) => {
					expect(
						chat,
						`chat.${key} should be gone from ${name}.json`,
					).not.toHaveProperty(key);
				},
			);
		});
	}
});
