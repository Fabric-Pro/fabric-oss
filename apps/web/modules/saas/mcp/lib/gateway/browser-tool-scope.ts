import type { ToolScope } from "./tool-scope";

export const BROWSER_TOOL_SCOPES: Record<string, ToolScope> = {
	run_browser_task: { scope: "browser:write", kind: "write" },
	run_hybrid_task: { scope: "browser:write", kind: "write" },
	extract_web_content: { scope: "browser:write", kind: "write" },
	execute_template: { scope: "browser:write", kind: "write" },
	list_templates: { scope: "browser:read", kind: "read" },
};

export function browserToolScope(name: string): ToolScope | undefined {
	return Object.hasOwn(BROWSER_TOOL_SCOPES, name)
		? BROWSER_TOOL_SCOPES[name]
		: undefined;
}
