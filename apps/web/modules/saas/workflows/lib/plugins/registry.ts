/**
 * Plugin Registry for Workflow Integrations
 * Aligned with Vercel workflow-builder-template patterns
 *
 * This registry manages all available integration plugins and provides
 * utilities for querying and organizing them.
 */

import type {
	ActionWithContext,
	IntegrationAction,
	IntegrationPlugin,
	IntegrationType,
} from "./types";

/**
 * Central registry for all integration plugins
 */
const integrationRegistry = new Map<IntegrationType, IntegrationPlugin>();

/**
 * Register an integration plugin
 */
export function registerIntegration(plugin: IntegrationPlugin): void {
	integrationRegistry.set(plugin.type, plugin);
}

/**
 * Get a specific integration plugin by type
 */
export function getIntegration(
	type: IntegrationType,
): IntegrationPlugin | undefined {
	return integrationRegistry.get(type);
}

/**
 * Get all registered integration plugins
 */
export function getAllIntegrations(): IntegrationPlugin[] {
	return Array.from(integrationRegistry.values());
}

/**
 * Get all registered integration types
 */
export function getIntegrationTypes(): IntegrationType[] {
	return Array.from(integrationRegistry.keys());
}

/**
 * Get integration types that can be used as knowledge sources
 * Includes integrations with category "knowledge" or "both"
 */
export function getKnowledgeIntegrationTypes(): IntegrationType[] {
	return getAllIntegrations()
		.filter((p) => p.category === "knowledge" || p.category === "both")
		.map((p) => p.type);
}

/**
 * Get integration types that can be used as tools
 * Includes integrations with category "tool" or "both"
 */
export function getToolIntegrationTypes(): IntegrationType[] {
	return getAllIntegrations()
		.filter((p) => p.category === "tool" || p.category === "both")
		.map((p) => p.type);
}

/**
 * Generate full action ID from integration type and action slug
 * Format: "integration-type/action-slug" (matches Vercel template)
 */
function getFullActionId(integrationType: string, actionSlug: string): string {
	return `${integrationType.toLowerCase().replace(/_/g, "-")}/${actionSlug}`;
}

/**
 * Resolve the node type an action is stored as.
 *
 * `action.nodeType` wins when set. It is set only for the handful of actions
 * whose stored name predates the `<integration-type>-<slug>` convention — see
 * the field's doc comment. Deriving those would rename the node in every saved
 * workflow.
 */
function resolveNodeType(
	integrationType: string,
	action: IntegrationAction,
): string {
	if (action.nodeType) {
		return action.nodeType;
	}
	return `${integrationType.toLowerCase().replace(/_/g, "-")}-${action.slug}`;
}

/**
 * Get all actions from all plugins with context
 */
export function getAllActions(): ActionWithContext[] {
	const actions: ActionWithContext[] = [];

	for (const plugin of integrationRegistry.values()) {
		for (const action of plugin.actions) {
			actions.push({
				...action,
				integrationType: plugin.type,
				integrationLabel: plugin.label,
				actionId: getFullActionId(plugin.type, action.slug),
				nodeType: resolveNodeType(plugin.type, action),
			});
		}
	}

	return actions;
}

/**
 * Get actions organized by category
 */
export function getActionsByCategory(): Record<string, ActionWithContext[]> {
	const categories: Record<string, ActionWithContext[]> = {};

	for (const action of getAllActions()) {
		if (!categories[action.category]) {
			categories[action.category] = [];
		}
		categories[action.category].push(action);
	}

	return categories;
}

/**
 * Find an action by various identifiers, in strict priority order:
 *
 * 1. Full action ID — "linear/create-ticket"        (unique by construction)
 * 2. Node type      — "linear-create-ticket"        (unique by construction)
 * 3. Action label   — "Create Linear Ticket"        (must be unambiguous)
 * 4. Action slug    — "create-ticket"               (must be unambiguous)
 *
 * Strategies 3 and 4 are not unique across plugins: "create-ticket" is a slug
 * on Linear, Zendesk AND Freshservice. The previous implementation walked the
 * registry plugin-by-plugin trying all four strategies per action, so a bare
 * slug on an early plugin beat an exact ID match on a later one, and which
 * plugin won depended on Map insertion order. Ambiguous identifiers now
 * resolve to `undefined` rather than to an arbitrary plugin — callers should
 * pass an action ID or node type.
 */
export function findActionById(
	identifier: string | undefined | null,
): ActionWithContext | undefined {
	if (!identifier) {
		return undefined;
	}

	const all = getAllActions();

	const byActionId = all.find((action) => action.actionId === identifier);
	if (byActionId) {
		return byActionId;
	}

	const byNodeType = all.find((action) => action.nodeType === identifier);
	if (byNodeType) {
		return byNodeType;
	}

	const byLabel = all.filter((action) => action.label === identifier);
	if (byLabel.length === 1) {
		return byLabel[0];
	}

	const bySlug = all.filter((action) => action.slug === identifier);
	if (bySlug.length === 1) {
		return bySlug[0];
	}

	if (byLabel.length > 1 || bySlug.length > 1) {
		const matches = (byLabel.length > 1 ? byLabel : bySlug)
			.map((action) => action.actionId)
			.join(", ");
		console.warn(
			`[Plugin Registry] Ambiguous action identifier "${identifier}" matches: ${matches}. Use the full action ID or node type.`,
		);
	}

	return undefined;
}

/**
 * Check if an integration is registered
 */
export function hasIntegration(type: IntegrationType): boolean {
	return integrationRegistry.has(type);
}

/**
 * Get the integration that provides a specific node type.
 *
 * Exact match only. This used to fall back to suffix and prefix heuristics
 * ("does the node type end with any action's slug?"), which existed solely to
 * paper over the five node types whose stored name predates the
 * `<type>-<slug>` convention. Those are now pinned on the action itself via
 * `nodeType`, so the heuristics are unnecessary — and they were unsafe:
 * `endsWith(action.slug)` made "github-create-issue" a candidate match for
 * GitLab's "create-issue" action, resolved by Map iteration order.
 */
export function getIntegrationByNodeType(
	nodeType: string,
): IntegrationPlugin | undefined {
	for (const plugin of integrationRegistry.values()) {
		for (const action of plugin.actions) {
			if (resolveNodeType(plugin.type, action) === nodeType) {
				return plugin;
			}
		}
	}

	return undefined;
}

/**
 * Generate credential mapping for a plugin from its formFields
 * Auto-generates mapping based on envVar field
 */
export function getCredentialMapping(
	plugin: IntegrationPlugin,
): (config: Record<string, unknown>) => Record<string, string> {
	return (config: Record<string, unknown>) => {
		const credentials: Record<string, string> = {};
		for (const field of plugin.formFields) {
			if (field.envVar) {
				credentials[field.envVar] =
					(config[field.configKey] as string) || "";
			}
		}
		return credentials;
	};
}
