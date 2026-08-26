/**
 * OAuth Tool Executors
 *
 * Re-exports from @repo/integrations for backward compatibility.
 * The actual implementation is now in the shared integrations package.
 */

export {
	executeMicrosoftTeamsTool,
	truncateContent,
} from "@repo/integrations/microsoft";

export { executeSlackTool } from "@repo/integrations/slack";
