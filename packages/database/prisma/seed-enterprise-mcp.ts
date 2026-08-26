/**
 * Seed Enterprise Remote MCP Servers
 * Run with: pnpm tsx prisma/seed-enterprise-mcp.ts
 */

import { db } from "../prisma/client";

export const enterpriseServers = [
	{
		key: "azure-devops",
		name: "Azure DevOps",
		description:
			"Connect to Azure DevOps for work items, repositories, pipelines, wikis, and more. Requires your organization name and a Personal Access Token (PAT).",
		// Pinned deliberately — see the matching note in `seed.ts`: 2.9.0
		// consolidated the granular tool surface our call sites resolve by name.
		command: "npx -y @azure-devops/mcp@2.8.0",
		docsUrl: "https://github.com/microsoft/azure-devops-mcp",
		transport: "STDIO" as const,
		authMethods: ["API_KEY"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		apiKeyMethod: "HEADER" as const,
		iconUrl: "https://cdn.vsassets.io/content/icons/favicon.ico",
		author: "Microsoft",
		repositoryUrl: "https://github.com/microsoft/azure-devops-mcp",
		category: "Project Management",
		tags: [
			"azure",
			"devops",
			"work-items",
			"pipelines",
			"repos",
			"git",
			"enterprise",
			"project-management",
			"ci-cd",
		],
		isSystemProvided: true,
	},
	{
		key: "atlassian",
		name: "Atlassian (Jira & Confluence)",
		description:
			"Connect to Jira for issue tracking and Confluence for documentation via Atlassian's official Rovo MCP server. One OAuth connection unlocks both.",
		defaultUrl: "https://mcp.atlassian.com/v1/mcp",
		docsUrl:
			"https://support.atlassian.com/atlassian-rovo-mcp-server/docs/",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		oauthDiscoveryUrl:
			"https://mcp.atlassian.com/.well-known/oauth-authorization-server",
		iconUrl:
			"https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png",
		author: "Atlassian",
		repositoryUrl: "https://github.com/atlassian/atlassian-mcp-server",
		category: "Project Management",
		tags: [
			"jira",
			"confluence",
			"bitbucket",
			"issues",
			"docs",
			"code",
			"enterprise",
			"project-management",
			"wiki",
		],
		isSystemProvided: true,
	},
	{
		key: "notion-remote",
		name: "Notion (Official)",
		description:
			"Connect to Notion workspaces via Notion's official remote MCP server. Access pages, databases, and collaborate with your team's knowledge base.",
		defaultUrl: "https://mcp.notion.com/mcp",
		docsUrl: "https://developers.notion.com/docs/mcp",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		iconUrl: "https://www.notion.so/images/favicon.ico",
		author: "Notion",
		repositoryUrl: "https://github.com/makenotion/notion-mcp-server",
		category: "Productivity",
		tags: ["docs", "database", "wiki", "knowledge-base", "notes"],
		isSystemProvided: true,
	},
	{
		key: "figma",
		name: "Figma",
		description:
			"Connect to Figma for design file access, component inspection, code generation, and design context extraction. Requires a Figma Personal Access Token (PAT).",
		command: "npx -y figma-developer-mcp --stdio",
		docsUrl:
			"https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens",
		transport: "STDIO" as const,
		authMethods: ["API_KEY"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		apiKeyMethod: "HEADER" as const,
		iconUrl: "https://static.figma.com/app/icon/1/favicon.png",
		author: "Figma",
		repositoryUrl: "https://www.npmjs.com/package/figma-developer-mcp",
		category: "Design",
		tags: [
			"figma",
			"design",
			"ui",
			"components",
			"code-generation",
			"assets",
			"prototyping",
		],
		isSystemProvided: true,
	},
	{
		key: "linear-remote",
		name: "Linear (Official)",
		description:
			"Connect to Linear via Linear's official remote MCP server. Modern issue tracking for high-performance teams. Supports HTTP (/mcp) and SSE (/sse) transports.",
		defaultUrl: "https://mcp.linear.app/mcp",
		docsUrl: "https://linear.app/docs/mcp",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		iconUrl: "https://linear.app/favicon.ico",
		author: "Linear",
		category: "Project Management",
		tags: ["issues", "agile", "projects", "tracking", "project-management"],
		isSystemProvided: true,
	},
	{
		key: "github-remote",
		name: "GitHub (Official)",
		description:
			"Connect to GitHub via GitHub's official remote MCP server. Manage repositories, pull requests, issues, and code reviews.",
		defaultUrl: "https://api.githubcopilot.com/mcp/",
		docsUrl: "https://github.com/github/github-mcp-server",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		oauthAuthorizationEndpoint: "https://github.com/login/oauth/authorize",
		oauthTokenEndpoint: "https://github.com/login/oauth/access_token",
		iconUrl: "https://github.githubassets.com/favicons/favicon.svg",
		author: "GitHub",
		category: "Developer Tools",
		tags: [
			"github",
			"git",
			"repositories",
			"pull-requests",
			"issues",
			"code-review",
			"developer-tools",
		],
		isSystemProvided: true,
	},
	{
		key: "gitlab",
		name: "GitLab",
		description:
			"Deprecated — use 'GitLab (Official)' instead. Existing connections continue to work via REST fallback after the in-process shim is removed.",
		defaultUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"}/api/mcp/gitlab`,
		docsUrl:
			"https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		oauthAuthorizationEndpoint: "https://gitlab.com/oauth/authorize",
		oauthTokenEndpoint: "https://gitlab.com/oauth/token",
		iconUrl: "https://gitlab.com/favicon.ico",
		author: "Fabric",
		// Deprecated row — kept in the catalog so existing MCPConfigs
		// still resolve, but no longer surfaced as a PM tool option.
		// `gitlab-official` is the supported PM path.
		category: "Developer Tools",
		tags: ["gitlab", "issues", "merge-requests", "git", "deprecated"],
		// Legacy entry — official GitLab MCP supersedes it. Marked
		// false so the picker hides it from new users.
		isSystemProvided: false,
	},
	{
		key: "gitlab-official",
		name: "GitLab (Official)",
		description:
			"GitLab's official remote MCP server. Requires GitLab Premium or Ultimate (Duo). For Free or unsupported tiers, Fabric falls back to direct GitLab REST via your connected GitLab integration.",
		defaultUrl: "https://gitlab.com/api/v4/mcp",
		docsUrl:
			"https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		oauthAuthorizationEndpoint: "https://gitlab.com/oauth/authorize",
		oauthTokenEndpoint: "https://gitlab.com/oauth/token",
		iconUrl: "https://gitlab.com/favicon.ico",
		author: "GitLab",
		category: "Project Management",
		tags: [
			"gitlab",
			"git",
			"issues",
			"project-management",
			"merge-requests",
			"premium",
			"duo",
		],
		isSystemProvided: true,
	},
	{
		key: "slack-remote",
		name: "Slack (Official)",
		description:
			"Connect to Slack via Slack's official remote MCP server. Send messages, manage channels, and interact with your Slack workspace.",
		defaultUrl: "https://mcp.slack.com/mcp",
		docsUrl: "https://api.slack.com/docs/mcp",
		transport: "HTTP" as const,
		authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		iconUrl:
			"https://a.slack-edge.com/80588/marketing/img/meta/favicon-32.png",
		author: "Slack",
		category: "Communication",
		tags: ["messaging", "channels", "chat", "collaboration", "workspace"],
		isSystemProvided: true,
	},
	{
		key: "excalidraw",
		name: "Excalidraw",
		description:
			"AI-powered diagramming with Excalidraw. Create architecture diagrams, flowcharts, sequence diagrams, and more with streaming animations. Diagrams are fully editable in a hand-drawn style canvas.",
		defaultUrl: "https://mcp.excalidraw.com/mcp",
		docsUrl: "https://github.com/excalidraw/excalidraw",
		transport: "HTTP" as const,
		authMethods: ["NONE"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		iconUrl: "https://excalidraw.com/favicon.ico",
		author: "Excalidraw",
		repositoryUrl: "https://github.com/nichochar/excalidraw-studio",
		category: "Design",
		tags: [
			"diagrams",
			"whiteboard",
			"architecture",
			"flowchart",
			"visualization",
			"drawing",
			"excalidraw",
		],
		isSystemProvided: true,
		// Managed-default routing — keep in lockstep with the seed-flip
		// UPDATE in 20260511072912_backfill_default_excalidraw_mcp_config.
		// A fresh seed against an empty DB MUST produce the same column
		// values that the migration writes to an existing prod row.
		defaultEnabled: true,
		eagerKeywords: ["excalidraw"],
		eagerToolName: "create_view",
		suppressOnEager: ["fabric_create_frame", "fabric_create_slideshow"],
	},
	{
		key: "playwright",
		name: "Playwright",
		description:
			"Automate browser testing and UI interactions. Run end-to-end tests against deployed environments using natural language.",
		command:
			"npx -y @playwright/mcp@0.0.76 --browser chromium --headless --no-sandbox --isolated",
		transport: "STDIO" as const,
		authMethods: ["NONE"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		iconUrl: "https://playwright.dev/img/playwright-logo.svg",
		author: "Microsoft",
		category: "QA & Testing",
		tags: ["playwright", "testing", "e2e", "browser", "automation"],
		isSystemProvided: true,
		defaultEnabled: false,
		isImplemented: true,
	},
];

async function seedEnterpriseMcpServers() {
	console.log("Seeding Enterprise MCP Servers...");

	let created = 0;
	let updated = 0;

	for (const server of enterpriseServers) {
		// Scope to global catalog rows (null tenancy). `key` is not unique and
		// tenants can name a custom server after a catalog key — matching by
		// key alone would update that tenant-owned row to isSystemProvided:
		// true, hijacking it into the global catalog instead of creating the
		// missing global row. Not `isSystemProvided: true` here: the deprecated
		// `gitlab` entry is seeded with isSystemProvided: false and must still
		// be found on re-runs.
		const existing = await db.mCPServer.findFirst({
			where: { key: server.key, userId: null, organizationId: null },
		});
		if (existing) {
			await db.mCPServer.update({
				where: { id: existing.id },
				data: server,
			});
			console.log(`  ✓ Updated: ${server.name}`);
			updated++;
		} else {
			await db.mCPServer.create({ data: server });
			console.log(`  ✓ Created: ${server.name}`);
			created++;
		}
	}

	// Remove old system-provided GitHub STDIO entry (replaced by github-remote)
	const oldGithub = await db.mCPServer.findFirst({
		where: { key: "github", isSystemProvided: true },
	});
	if (oldGithub) {
		await db.mCPServer.delete({ where: { id: oldGithub.id } });
		console.log("  ✗ Removed old: GitHub (STDIO)");
	}

	console.log(`\nDone! Created: ${created}, Updated: ${updated}`);
}

seedEnterpriseMcpServers()
	.then(() => {
		db.$disconnect();
	})
	.catch((e) => {
		console.error(e);
		db.$disconnect();
		process.exit(1);
	});
