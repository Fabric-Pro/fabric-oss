/**
 * Default PM tools always surfaced in the project setup wizard.
 *
 * These three are the platform's baseline project-management
 * integrations. They appear as selectable options in the wizard's
 * "Project Management Tool" dropdown for every tenant, regardless of
 * whether the tenant has configured an MCPConfig for them.
 *
 * NOTE: this is *not* the same concept as `MCPServer.defaultEnabled`,
 * which controls managed-default chat MCPs (Excalidraw today). That
 * field auto-seeds a per-tenant MCPConfig and renders an "Always on"
 * pill in the chat/agent registry. The wizard defaults here are
 * **selectable stubs** — they appear as choices, but a tenant must
 * still create an MCPConfig (or follow the wizard's MCP Settings
 * link) before sync becomes operational.
 *
 * To add a new wizard default:
 *   1. Ensure the MCPServer row exists in `seed.ts` with
 *      `category = "Project Management"`.
 *   2. Add its `key` to `DEFAULT_PROJECT_MANAGEMENT_KEYS` below.
 *   3. Add a display-name override here only if the catalog `name`
 *      differs from the human label we want in the wizard.
 *
 * The wizard surfaces *any* PM-categorised MCPConfig automatically —
 * adding to this list is only required for tools we want visible
 * pre-configuration.
 */
export const DEFAULT_PROJECT_MANAGEMENT_KEYS = [
	"fizzy",
	"azure-devops",
	"atlassian",
	"gitlab-official",
] as const;

/**
 * Wizard-facing display overrides for catalog rows whose seeded `name`
 * differs from the label we want users to see. Today:
 *   - `atlassian` → "Jira" (the catalog row is "Atlassian (Jira &
 *     Confluence)" but the wizard says "Jira").
 *   - `gitlab-official` → "GitLab" (catalog row is "GitLab (Official)"
 *     but the wizard says just "GitLab"; the legacy `gitlab` MCPServer
 *     is no longer surfaced as a PM option).
 */
export const DEFAULT_PROJECT_MANAGEMENT_DISPLAY_OVERRIDES: Readonly<
	Record<string, string>
> = {
	atlassian: "Jira",
	"gitlab-official": "GitLab",
};

/**
 * Icon-registry key overrides for catalog rows whose `MCPServer.key`
 * differs from the brand-icon registry key in
 * `apps/web/modules/saas/projects/components/stories/pm-sync/pm-tool-brand-icon.tsx`.
 *
 * The icon registry keys mirror `detectPMTypeFromUrl()` values
 * (`packages/utils/lib/pm-tool-patterns.ts`). For most servers the
 * catalog key matches; Atlassian is the exception — catalog key is
 * `atlassian` but the icon registry uses `jira`.
 */
export const DEFAULT_PROJECT_MANAGEMENT_ICON_KEY_OVERRIDES: Readonly<
	Record<string, string>
> = {
	atlassian: "jira",
	"gitlab-official": "gitlab",
};

/**
 * Sentinel prefix used by `listAvailablePmTools` when an expected
 * `MCPServer` catalog row is missing (seed drift). In the normal case
 * `Project.projectManagementMcpServerId` stores a cuid, but if the row
 * was never seeded we emit `"key:<server-key>"` so the picker can still
 * surface the tool. `getProjectPMServerKey` recognises this shape and
 * resolves the key without needing the catalog row.
 *
 * Colon is safe — Prisma cuids do not contain ":".
 */
export const PM_SERVER_ID_KEY_SENTINEL_PREFIX = "key:";

/** True iff `id` is a `key:<server-key>` sentinel emitted as a degradation fallback. */
export function isPmServerIdKeySentinel(id: string): boolean {
	return id.startsWith(PM_SERVER_ID_KEY_SENTINEL_PREFIX);
}

/** Strip the sentinel prefix; returns the server key. Caller must verify with `isPmServerIdKeySentinel` first. */
export function readPmServerIdKeySentinel(id: string): string {
	return id.slice(PM_SERVER_ID_KEY_SENTINEL_PREFIX.length);
}
