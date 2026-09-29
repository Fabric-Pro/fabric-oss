/**
 * Meeting guests are not Fabric-authenticated. Existing MCP and integration
 * grants belong to the inviter and do not prove a tool is safely scoped to the
 * project or has no side effects. Keep those tools unavailable until a
 * per-meeting scoped capability contract exists.
 */
export function isParlumeMeetingToolAllowed(toolName: string): boolean {
	void toolName;
	return false;
}
