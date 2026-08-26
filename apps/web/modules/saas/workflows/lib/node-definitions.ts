/**
 * The builder's palette, derived rather than authored.
 *
 * This file used to be an 865-line hand-maintained array of 18 node types,
 * kept in sync by hand with three other places: the plugin registry (28
 * plugins, ~68 actions), the React Flow node-type map, and the executor
 * registry. They drifted. `getAllActions()` was exported and never called by
 * any UI, so roughly twenty integrations — most of them with working
 * executors — could not be placed on a canvas at all.
 *
 * Now there is one authored source per concern:
 *
 *   - integration actions  -> lib/plugins/<name>/index.ts
 *   - system nodes         -> lib/system-nodes.ts
 *   - executors            -> packages/temporal/.../step-registry.ts
 *
 * and the palette is computed from the first two. An action is offered only
 * when it declares a step binding, so an action with no executor can never be
 * dropped onto a canvas. The three-way agreement between plugin actions,
 * their executors and their declared outputs is asserted by
 * `lib/plugins/__tests__/action-executor-contract.test.ts`.
 */

import { getAllActions } from "./plugins";
import type { ActionConfigField, ActionWithContext } from "./plugins/types";
import { SYSTEM_NODES } from "./system-nodes";
import type {
	NodeCategory,
	NodeTypeDefinition,
	WorkflowNodeType,
} from "./types";

/**
 * An action can be placed on a canvas only if something can execute it.
 * `stepImportPath`/`stepFunction` are present exactly when a step exists —
 * actions without one had their (untruthful) bindings removed, so this is a
 * reliable signal rather than a heuristic.
 */
export function hasExecutor(action: ActionWithContext): boolean {
	return Boolean(action.stepImportPath && action.stepFunction);
}

/** Flatten `group` fields so nested defaults are not lost. */
function flattenConfigFields(
	fields: ActionConfigField[] | undefined,
): ActionConfigField[] {
	const flat: ActionConfigField[] = [];
	for (const field of fields ?? []) {
		if (field.type === "group" && field.fields) {
			flat.push(...flattenConfigFields(field.fields));
		} else {
			flat.push(field);
		}
	}
	return flat;
}

/**
 * Seed a new node's config from the action's declared field defaults, so
 * dropping a node onto the canvas produces the same starting state the
 * hand-written `defaultData` used to.
 */
function defaultConfigFor(action: ActionWithContext): Record<string, unknown> {
	const config: Record<string, unknown> = {};

	for (const field of flattenConfigFields(action.configFields)) {
		if (field.defaultValue !== undefined) {
			config[field.key] = field.defaultValue;
			continue;
		}
		// Multi-select pickers need an array to render against, and
		// `defaultValue` is typed as a string so it cannot express one.
		if (field.type === "mcp-selector") {
			config[field.key] = [];
		}
	}

	return config;
}

function toNodeDefinition(action: ActionWithContext): NodeTypeDefinition {
	return {
		type: action.nodeType as WorkflowNodeType,
		label: action.label,
		description: action.description,
		// Only a fallback: `getNodeIcon` prefers the plugin's own brand icon,
		// and every registered plugin provides one.
		icon: "Wrench",
		category: action.category,
		defaultData: {
			label: action.label,
			config: defaultConfigFor(action),
		},
		// Config UI for a plugin action comes from the action's own
		// `configFields` via ActionConfigPanel, not from here — the two field
		// shapes differ (`key` vs `name`) and duplicating them is what drifted.
	};
}

/** Actions that can actually run, in a stable order. */
function getRunnableActions(): ActionWithContext[] {
	return getAllActions()
		.filter(hasExecutor)
		.sort(
			(a, b) =>
				a.category.localeCompare(b.category) ||
				a.label.localeCompare(b.label),
		);
}

// All node types the builder offers: system nodes first, then every
// integration action with a working executor.
export const nodeDefinitions: NodeTypeDefinition[] = [
	...SYSTEM_NODES,
	...getRunnableActions().map(toNodeDefinition),
];

/** The system-node group, pinned to the top of the palette. */
const CORE_CATEGORY = "Core";

const CATEGORY_ICONS: Record<string, string> = {
	Core: "Play",
	AI: "Sparkles",
	Web: "Globe",
	Communication: "Bell",
	Developer: "GitBranch",
};

// Categories present in the palette, derived from the nodes themselves so a
// new integration category cannot go missing from the grouping. Core first,
// then alphabetical.
export const nodeCategories: NodeCategory[] = Array.from(
	new Set(nodeDefinitions.map((node) => node.category)),
)
	.sort((a, b) => {
		if (a === CORE_CATEGORY) {
			return -1;
		}
		if (b === CORE_CATEGORY) {
			return 1;
		}
		return a.localeCompare(b);
	})
	.map((id) => ({
		id,
		label: id,
		icon: CATEGORY_ICONS[id] ?? "Plug",
		nodes: nodeDefinitions.filter((node) => node.category === id),
	}));

// Get node definition by type
export function getNodeDefinition(
	type: string,
): NodeTypeDefinition | undefined {
	return nodeDefinitions.find((n) => n.type === type);
}
