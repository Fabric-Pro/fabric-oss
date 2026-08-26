/**
 * @repo/agent-tools
 *
 * Framework-agnostic tool definitions for agents.
 * These tool definitions work with agents written in any language (TypeScript, Python, C#)
 * as long as they support the AG-UI protocol.
 */
/**
 * Framework-agnostic tool definition
 * This format can be serialized and sent to agents in any language
 */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, any>;
			required?: string[];
		};
	};
}
/**
 * Write document tool
 * Single source of truth for the document writing tool definition
 * Used by all agents regardless of implementation language
 */
export declare const WRITE_DOCUMENT_TOOL: ToolDefinition;
/**
 * Confirm changes tool
 * Used to request user confirmation for document changes
 */
export declare const CONFIRM_CHANGES_TOOL: ToolDefinition;
/**
 * Enhance prompt tool
 * Used by the Prompt Enhancer Agent to update prompt content
 */
export declare const ENHANCE_PROMPT_TOOL: ToolDefinition;
/**
 * Get all standard document tools
 */
export declare function getDocumentTools(): ToolDefinition[];
/**
 * Get all prompt enhancement tools
 */
export declare function getPromptTools(): ToolDefinition[];
//# sourceMappingURL=index.d.ts.map
