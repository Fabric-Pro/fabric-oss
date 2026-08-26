/**
 * Workflow Builder Types
 * Based on Vercel workflow-builder-template with adaptations for fabric-portal
 */

import type { Edge, Node } from "@xyflow/react";

// Node data types for different action types
// Using Record<string, unknown> intersection to satisfy React Flow's type requirements
interface BaseNodeData extends Record<string, unknown> {
	label: string;
	description?: string;
	isConfigured?: boolean;
}

interface TriggerNodeData extends BaseNodeData {
	triggerType: "manual" | "schedule" | "webhook" | "event";
	config?: Record<string, unknown>;
}

interface AINodeData extends BaseNodeData {
	provider: "openai" | "anthropic" | "ai-gateway";
	model?: string;
	prompt?: string;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
}

interface HttpNodeData extends BaseNodeData {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	url?: string;
	headers?: Record<string, string>;
	body?: string;
}

interface ConditionNodeData extends BaseNodeData {
	expression?: string;
	trueLabel?: string;
	falseLabel?: string;
}

interface FirecrawlNodeData extends BaseNodeData {
	action: "scrape" | "search";
	url?: string;
	query?: string;
	options?: Record<string, unknown>;
}

interface LinearNodeData extends BaseNodeData {
	action: "create_ticket" | "find_issues";
	teamId?: string;
	title?: string;
	description?: string;
	query?: string;
}

interface EmailNodeData extends BaseNodeData {
	to?: string;
	subject?: string;
	body?: string;
	template?: string;
}

interface SlackNodeData extends BaseNodeData {
	channel?: string;
	message?: string;
	webhookUrl?: string;
}

interface MCPNodeData extends BaseNodeData {
	serverId?: string;
	toolName?: string;
	arguments?: Record<string, unknown>;
}

// Union type for all node data
export type WorkflowNodeData =
	| TriggerNodeData
	| AINodeData
	| HttpNodeData
	| ConditionNodeData
	| FirecrawlNodeData
	| LinearNodeData
	| EmailNodeData
	| SlackNodeData
	| MCPNodeData
	| BaseNodeData;

/**
 * A workflow node's type.
 *
 * This was a closed union of 18 literals, but the set of node types is data:
 * it comes from the plugin registry plus `system-nodes.ts`, and it grows when
 * an integration is added. Every use site was already an `as WorkflowNodeType`
 * cast, which is the tell that the union never described reality — a plugin
 * action's node type was not assignable to it, so the compiler was being
 * talked out of the truth rather than checking it.
 *
 * The runtime guarantees live in tests instead: node types are distinct, every
 * one has an executor, and `nodeType === stepImportPath`
 * (`lib/plugins/__tests__/action-executor-contract.test.ts`).
 */
export type WorkflowNodeType = string;

// Typed workflow node
export type WorkflowNode = Node<WorkflowNodeData, WorkflowNodeType>;

// Typed workflow edge
export type WorkflowEdge = Edge;

// Node category for UI grouping
export interface NodeCategory {
	id: string;
	label: string;
	description?: string;
	icon?: string;
	nodes: NodeTypeDefinition[];
}

// Node type definition for the palette
export interface NodeTypeDefinition {
	type: WorkflowNodeType;
	label: string;
	description: string;
	icon: string;
	category: string;
	defaultData: Partial<WorkflowNodeData>;
	configFields?: ConfigField[];
}

// Configuration field definition
export interface ConfigField {
	name: string;
	label: string;
	type:
		| "text"
		| "textarea"
		| "number"
		| "select"
		| "boolean"
		| "json"
		| "mcp-selector"
		| "mcp-tool-selector"
		| "ai-model-selector";
	required?: boolean;
	placeholder?: string;
	options?: { value: string; label: string }[];
	defaultValue?: unknown;
}
