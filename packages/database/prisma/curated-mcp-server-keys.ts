const CURATED_SYSTEM_MCP_SERVER_KEYS = [
	"gitlab",
	// Wizard-default PM tool (DEFAULT_PROJECT_MANAGEMENT_KEYS). Tenants on
	// GitLab's REST fallback have no MCPConfig referencing this row, so
	// omitting it here lets seed-mcp-registry's cleanupNonOfficialServers()
	// delete it — the availablePmTools picker then degrades to key-sentinel
	// ids (issue #2824).
	"gitlab-official",
	"playwright",
	"filesystem",
	"memory",
	"google-drive",
	"brave-search",
	"context7",
	"supabase",
	"firecrawl",
	"fabric-browser-automation",
	"exa-search",
	"cloudflare",
	"stripe",
	"sentry",
	"neon",
	"twilio",
	"airtable",
	"todoist",
	"axiom",
	"sequential-thinking",
	"everything",
	"fabric",
	"fizzy",
	"azure-devops",
	"atlassian",
	"notion-remote",
	"figma",
	"linear-remote",
	"github-remote",
	"slack-remote",
	"excalidraw",
] as const;

export const CURATED_SYSTEM_MCP_SERVER_KEY_SET: ReadonlySet<string> = new Set(
	CURATED_SYSTEM_MCP_SERVER_KEYS,
);

// Registry cleanup deletes retired system rows only when they have no configs.
// Referenced rows stay system-provided: the curated filter excludes them from
// listings, and the hidden-key union refuses new configs. Existing configs keep
// loading, running, and accepting edits through the system-server access path.
export const RETIRED_SYSTEM_MCP_SERVER_KEYS = [
	"sqlite",
	"fetch",
	"time",
	"notion",
	"vercel",
	"turso",
	"raycast",
	"github",
	"slack",
	"postgres",
	"puppeteer",
	"google-maps",
	"e2b",
	"obsidian",
	"asana",
	"resend",
	"upstash",
	"browserbase",
] as const;
