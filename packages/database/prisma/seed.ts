import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@repo/logs";
import { hashPassword } from "better-auth/crypto";
import { db } from "../prisma/client";
import { getUserByEmail } from "../prisma/queries/users";

/**
 * Document type bindings for system prompts
 * Maps prompt keys to their document types for automatic binding
 */
const PROMPT_DOCUMENT_TYPE_BINDINGS: Record<string, string[]> = {
	prd_template: ["PRD"],
	api_spec_template: ["API_SPEC"],
	proposal_doc_template: ["PROPOSAL"],
	architecture_doc_template: ["ARCHITECTURE"],
	technical_spec_template: ["TECHNICAL_SPEC"],
	user_stories_template: ["USER_STORY"],
};

/**
 * Seed script to create test admin users for development
 * This script is idempotent - it will skip users that already exist
 *
 * Uses Better Auth's API to create users with passwords to ensure
 * proper password hashing and account creation.
 *
 * Environment-aware: Uses environment variables for deployment URLs
 * Run with:
 *   pnpm --filter @repo/database seed           # Local (uses .env.local)
 *   pnpm --filter @repo/database seed:staging   # Staging (uses .env.staging)
 *   pnpm --filter @repo/database seed:prod      # Production (uses .env.production)
 */

/**
 * Get deployment URL from environment variable or fall back to localhost default
 * This allows the same seed script to work across environments
 */
function getDeploymentUrl(envVar: string, defaultPort: number): string {
	const envUrl = process.env[envVar];
	if (envUrl) {
		return envUrl;
	}
	return `http://localhost:${defaultPort}`;
}

// Log the environment being used
const env = process.env.NODE_ENV || "development";
logger.info(`\n=== Seed Environment: ${env.toUpperCase()} ===`);
if (process.env.DATABASE_URL?.includes("neon.tech")) {
	logger.info("Target: Neon (Staging/Production)");
} else {
	logger.info("Target: Local Database");
}

// User seeding is OFF by default. To enable in any environment, set:
//   SEED_DEV_USERS=true
// Then provide the user list via ONE of:
//   - SEED_USERS_JSON  (JSON string with the array — preferred for CI / managed envs)
//   - packages/database/prisma/seed-users.local.json  (gitignored file — local dev only)
//
// Each entry: { email, name, password, role: "admin" | "user" }.
// The first entry becomes the org "owner" if seedOrganization() runs.
type SeedUser = {
	email: string;
	name: string;
	password: string;
	role: "admin" | "user";
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_USERS_LOCAL_FILE = join(__dirname, "seed-users.local.json");

function loadSeedUsers(): SeedUser[] {
	if (process.env.SEED_DEV_USERS !== "true") {
		return [];
	}

	const json = process.env.SEED_USERS_JSON;
	if (json) {
		try {
			const parsed = JSON.parse(json);
			if (!Array.isArray(parsed)) {
				logger.error(
					"SEED_USERS_JSON must be a JSON array; got " +
						typeof parsed +
						". Skipping user seed.",
				);
				return [];
			}
			return parsed as SeedUser[];
		} catch (e) {
			logger.error(
				"SEED_USERS_JSON is set but failed to parse as JSON. Skipping user seed.",
				e,
			);
			return [];
		}
	}

	if (existsSync(SEED_USERS_LOCAL_FILE)) {
		try {
			return JSON.parse(
				readFileSync(SEED_USERS_LOCAL_FILE, "utf8"),
			) as SeedUser[];
		} catch (e) {
			logger.error(
				`Failed to parse ${SEED_USERS_LOCAL_FILE}. Skipping user seed.`,
				e,
			);
			return [];
		}
	}

	logger.info(
		"SEED_DEV_USERS=true but neither SEED_USERS_JSON nor seed-users.local.json is set; skipping user seed.",
	);
	return [];
}

const TEST_USERS: readonly SeedUser[] = loadSeedUsers();

async function seedUsers() {
	logger.info("Starting database seed...");

	if (TEST_USERS.length === 0) {
		logger.info(
			"No seed users configured (set SEED_DEV_USERS=true and provide SEED_USERS_JSON or seed-users.local.json to enable). Skipping user seed.",
		);
		return;
	}

	let createdCount = 0;
	let skippedCount = 0;

	// Hash passwords using Better Auth's scrypt implementation so seeded users
	// can sign in with the same hash format the runtime expects. Reuses a single
	// auth context across the loop.
	// const authContext = await auth.$context;

	for (const testUser of TEST_USERS) {
		try {
			// Check if user already exists
			const existingUser = await getUserByEmail(testUser.email);

			if (existingUser) {
				// Always update role, emailVerified, and onboardingComplete for existing users
				// This fixes cases where users signed up manually and are missing admin role or verification.
				// `mustChangePassword` is intentionally not re-set here — the force-change-password flow
				// is a one-time prompt on first login for new seeded users (cleared by the auth after-hook
				// once the user changes their password). Re-setting it on every seed run would force every
				// seeded user to change their password again on the next re-seed.
				await db.user.update({
					where: { id: existingUser.id },
					data: {
						role: testUser.role,
						emailVerified: true,
						onboardingComplete: true,
					},
				});
				logger.info(
					`User ${testUser.email} already exists, updated role/verification.`,
				);
				skippedCount++;
				continue;
			}

			// Create the user + credential account directly instead of going through
			// `auth.api.signUpEmail`. That API triggers Better Auth's
			// `sendVerificationEmail` hook (configured with `sendOnSignUp: true`),
			// which would deliver a real "Verify your email address" email — pointing
			// at the seeding developer's localhost — to every TEST_USERS address. The
			// seed marks users as `emailVerified: true` immediately anyway, so the
			// verification flow is pure noise.
			//
			// Wrapped in a transaction so a crash between the user insert and the
			// credential-account insert can't leave a half-created seed user that the
			// "already exists" branch above would then never repair.
			const hashedPassword = await hashPassword(testUser.password);
			const now = new Date();

			await db.$transaction(async (tx) => {
				const created = await tx.user.create({
					data: {
						email: testUser.email,
						name: testUser.name,
						role: testUser.role,
						emailVerified: true,
						onboardingComplete: true,
						mustChangePassword: true,
						createdAt: now,
						updatedAt: now,
					},
				});

				await tx.account.create({
					data: {
						userId: created.id,
						accountId: created.id,
						providerId: "credential",
						password: hashedPassword,
						createdAt: now,
						updatedAt: now,
					},
				});
			});

			logger.success(
				`Created user: ${testUser.email} (${testUser.role})`,
			);
			createdCount++;
		} catch (error) {
			logger.error(`Error creating user ${testUser.email}:`, error);
		}
	}

	logger.info("\n=== Seed Summary ===");
	logger.info(`Created: ${createdCount} user(s)`);
	logger.info(`Skipped: ${skippedCount} user(s) (already exist)`);
	logger.info(`Total: ${TEST_USERS.length} user(s)`);

	if (createdCount > 0) {
		logger.info("\n=== Test User Credentials ===");
		for (const user of TEST_USERS) {
			logger.info(`Email: ${user.email} (${user.role})`);
		}
		logger.info(
			"Passwords are stored only in SEED_USERS_JSON / seed-users.local.json; not logged.",
		);
	}

	logger.success("\nUsers seed completed!");
}

async function seedOrganization() {
	// Org seeding piggybacks on the user seed: nothing to do if no seed users.
	if (TEST_USERS.length === 0) {
		return;
	}

	// Optional org config — keep gated even when users seed, so an org is only
	// created when explicitly requested.
	const orgSlug = process.env.SEED_ORG_SLUG;
	const orgName = process.env.SEED_ORG_NAME;
	if (!orgSlug || !orgName) {
		logger.info(
			"SEED_ORG_SLUG / SEED_ORG_NAME not set; skipping organization seed.",
		);
		return;
	}

	logger.info(`\nSeeding "${orgName}" organization...`);

	// Check if organization already exists
	let organization = await db.organization.findUnique({
		where: { slug: orgSlug },
	});

	if (organization) {
		logger.info(`Organization "${orgName}" already exists, updating...`);
		organization = await db.organization.update({
			where: { slug: orgSlug },
			data: {
				name: orgName,
			},
		});
	} else {
		logger.info(`Creating organization "${orgName}"...`);
		organization = await db.organization.create({
			data: {
				name: orgName,
				slug: orgSlug,
				createdAt: new Date(),
			},
		});
		logger.success(`Created organization: ${orgName}`);
	}

	// All seeded users become org members. First entry is "owner"; rest "admin".
	let membersAdded = 0;
	let membersSkipped = 0;

	for (let i = 0; i < TEST_USERS.length; i++) {
		const seedUser = TEST_USERS[i];
		if (!seedUser) {
			continue;
		}
		const { email } = seedUser;
		const user = await db.user.findUnique({
			where: { email },
		});

		if (!user) {
			logger.warn(`User ${email} not found, skipping membership...`);
			continue;
		}

		// Check if already a member
		const existingMember = await db.member.findUnique({
			where: {
				organizationId_userId: {
					organizationId: organization.id,
					userId: user.id,
				},
			},
		});

		if (existingMember) {
			logger.info(`User ${email} is already a member, skipping...`);
			membersSkipped++;
			continue;
		}

		const role = i === 0 ? "owner" : "admin";
		await db.member.create({
			data: {
				organizationId: organization.id,
				userId: user.id,
				role,
				createdAt: new Date(),
			},
		});
		logger.success(`Added ${email} as ${role} to ${orgName}`);
		membersAdded++;
	}

	logger.info("\n=== Organization Seed Summary ===");
	logger.info(`Organization: ${orgName}`);
	logger.info(`Members added: ${membersAdded}`);
	logger.info(`Members skipped: ${membersSkipped}`);
}

async function seedMcpServers() {
	logger.info("\nSeeding MCP Servers...");

	const servers = [
		// =============================================
		// STDIO-based MCP Servers (run locally via npx)
		// =============================================
		{
			key: "github",
			name: "GitHub",
			description:
				"Repository management, file operations, and GitHub API integration. Runs locally via npx.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-github",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/github",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any, // Uses GITHUB_PERSONAL_ACCESS_TOKEN env var
			iconUrl: "https://github.githubassets.com/favicons/favicon.svg",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Developer Tools",
			tags: [
				"project-management",
				"issue-tracking",
				"code-repository",
				"version-control",
			],
		},
		// NOTE: this entry is upserted with `isSystemProvided: true` by
		// the loop below (which hardcodes the field). The newer
		// `seed-enterprise-mcp.ts` flips it to `false` for this legacy
		// row so the picker hides it. The next run of
		// `seed-enterprise-mcp.ts` after this seed will normalize the
		// value back to `false`.
		{
			key: "gitlab",
			name: "GitLab",
			description:
				"Deprecated — use 'GitLab (Official)' instead. Existing connections continue to work via REST fallback after the in-process shim is removed.",
			defaultUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"}/api/mcp/gitlab`,
			docsUrl:
				"https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
			transport: "HTTP" as any,
			authMethods: ["OAUTH2"] as any,
			oauthAuthorizationEndpoint: "https://gitlab.com/oauth/authorize",
			oauthTokenEndpoint: "https://gitlab.com/oauth/token",
			iconUrl: "https://gitlab.com/favicon.ico",
			author: "Fabric",
			// Deprecated row — kept in the catalog so existing MCPConfigs
			// still resolve, but no longer surfaced as a PM tool option.
			// `gitlab-official` is the supported PM path.
			category: "Developer Tools",
			tags: ["gitlab", "issues", "merge-requests", "git", "deprecated"],
		},
		{
			key: "gitlab-official",
			name: "GitLab (Official)",
			description:
				"GitLab's official remote MCP server. Requires GitLab Premium or Ultimate (Duo). For Free or unsupported tiers, Fabric falls back to direct GitLab REST via your connected GitLab integration.",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
			docsUrl:
				"https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
			transport: "HTTP" as any,
			authMethods: ["OAUTH2"] as any,
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
		},

		{
			key: "filesystem",
			name: "Filesystem",
			description:
				"Secure file operations with configurable access controls. Runs locally via npx.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-filesystem",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://cdn-icons-png.flaticon.com/512/716/716784.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Developer Tools",
		},
		{
			key: "postgres",
			name: "PostgreSQL",
			description:
				"Read-only database access with schema inspection. Runs locally via npx. Requires connection string.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-postgres",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any, // Connection string as "API key"
			iconUrl:
				"https://www.postgresql.org/media/img/about/press/elephant.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Data & Analytics",
		},
		{
			key: "sqlite",
			name: "SQLite",
			description:
				"Database interaction and business intelligence capabilities. Runs locally via npx.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-sqlite",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://www.sqlite.org/images/sqlite370_banner.gif",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Data & Analytics",
		},
		{
			key: "memory",
			name: "Memory",
			description:
				"Knowledge graph-based persistent memory system. Runs locally via npx.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-memory",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://cdn-icons-png.flaticon.com/512/2920/2920277.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "AI & ML",
		},
		{
			key: "fetch",
			name: "Fetch",
			description:
				"Web content fetching and conversion for efficient LLM usage. Runs locally via npx.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-fetch",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://cdn-icons-png.flaticon.com/512/2889/2889676.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Web & Internet",
		},
		{
			key: "puppeteer",
			name: "Puppeteer",
			description:
				"Browser automation and web scraping. Runs locally via npx.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-puppeteer",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl:
				"https://www.gstatic.com/devrel-devsite/prod/v0e0f589edd85502a40d78d7d0825db8ea5ef3b99ab4070381ee86977c9168730/puppeteer/images/lockup.svg",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Developer Tools",
		},
		{
			key: "slack",
			name: "Slack",
			description:
				"Channel management and messaging capabilities. Runs locally via npx. Requires SLACK_BOT_TOKEN and SLACK_TEAM_ID.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-slack",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any, // SLACK_BOT_TOKEN env var
			iconUrl:
				"https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Communication",
		},
		{
			key: "google-drive",
			name: "Google Drive",
			description:
				"File access and search capabilities for Google Drive. Runs locally via npx. Requires OAuth setup.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-gdrive",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
			transport: "STDIO" as any,
			authMethods: ["OAUTH2"] as any,
			oauthDiscoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			iconUrl:
				"https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_48dp.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Productivity",
		},
		{
			key: "google-maps",
			name: "Google Maps",
			description:
				"Maps, geocoding, directions, and place details. Runs locally via npx. Requires GOOGLE_MAPS_API_KEY.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-google-maps",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl:
				"https://www.gstatic.com/images/branding/product/1x/maps_48dp.png",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Location & Maps",
		},
		{
			key: "notion",
			name: "Notion (API Key)",
			description:
				"Workspace and document management. Runs locally via npx. Requires NOTION_API_KEY.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-notion",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/notion",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://www.notion.so/images/favicon.ico",
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Productivity",
		},
		{
			key: "brave-search",
			name: "Brave Search",
			description:
				"Web and local search using Brave's Search API. Runs locally via npx. Requires BRAVE_API_KEY.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-brave-search",
			docsUrl: "https://github.com/brave/brave-search-mcp-server",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl:
				"https://brave.com/static-assets/images/brave-logo-sans-text.svg",
			author: "Brave",
			repositoryUrl: "https://github.com/brave/brave-search-mcp-server",
			category: "Web & Internet",
		},
		// =============================================
		// Remote HTTP/SSE MCP Servers (hosted services)
		// =============================================
		{
			key: "context7",
			name: "Context7",
			description:
				"Up-to-date documentation and code examples for any library. Free public remote server.",
			defaultUrl: "https://mcp.context7.com/mcp",
			command: null,
			docsUrl: "https://context7.com",
			transport: "HTTP" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://context7.com/favicon.ico",
			author: "Upstash",
			repositoryUrl: "https://github.com/upstash/context7",
			category: "Developer Tools",
		},
		{
			key: "supabase",
			name: "Supabase",
			description:
				"Database and authentication management for Supabase projects. Remote server with OAuth.",
			defaultUrl: "https://mcp.supabase.com/mcp",
			command: null,
			docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
			transport: "HTTP" as any,
			authMethods: ["OAUTH2"] as any,
			iconUrl: "https://supabase.com/favicon/favicon-196x196.png",
			author: "Supabase",
			repositoryUrl: "https://github.com/supabase-community/supabase-mcp",
			category: "Data & Analytics",
		},
		{
			key: "firecrawl",
			name: "Firecrawl",
			description:
				"Web crawling and content extraction. Cloud MCP server - API key is embedded in URL path. HTTP preferred over SSE.",
			defaultUrl: "https://mcp.firecrawl.dev/{API_KEY}/v2/mcp",
			command: null,
			docsUrl: "https://docs.firecrawl.dev/mcp",
			transport: "HTTP" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://www.firecrawl.dev/favicon.ico",
			author: "Firecrawl",
			repositoryUrl: "https://github.com/mendableai/firecrawl",
			category: "Web & Internet",
		},
		// NOTE: The former "fabric-browser-automation" stdio entry
		// (npx @fabricorg/mcp-server → /api/mcp-server) was removed. Its tools,
		// including browser automation, are served by the hosted Fabric MCP
		// server at https://fabric.pro/mcp (seeded below as key "fabric"). The
		// stdio bridge targeted REST paths that were never implemented.
		// =============================================
		// Additional Popular Remote MCP Servers
		// =============================================
		{
			key: "exa-search",
			name: "Exa Search",
			description:
				"Fast, intelligent web search and crawling optimized for AI. Access real-time web data with semantic search capabilities.",
			defaultUrl: "https://mcp.exa.ai/mcp",
			command: null,
			docsUrl: "https://docs.exa.ai/reference/mcp-server",
			transport: "HTTP" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://exa.ai/favicon.ico",
			author: "Exa AI",
			repositoryUrl: "https://github.com/exa-labs/exa-mcp-server",
			category: "Web & Internet",
			tags: ["search", "web", "crawling", "semantic-search", "ai"],
		},
		{
			key: "cloudflare",
			name: "Cloudflare",
			description:
				"Manage Cloudflare Workers, KV, R2 storage, and DNS. Deploy and manage serverless applications at the edge.",
			defaultUrl: null,
			command: "npx -y @cloudflare/mcp-server-cloudflare",
			docsUrl: "https://developers.cloudflare.com/agents/mcp/",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://www.cloudflare.com/favicon.ico",
			author: "Cloudflare",
			repositoryUrl:
				"https://github.com/cloudflare/mcp-server-cloudflare",
			category: "Cloud & Infrastructure",
			tags: ["cloudflare", "workers", "serverless", "edge", "cdn"],
		},
		{
			key: "stripe",
			name: "Stripe",
			description:
				"Payment processing and billing management. Create charges, manage subscriptions, and handle customer data.",
			defaultUrl: null,
			command: "npx -y @stripe/mcp",
			docsUrl: "https://docs.stripe.com/agents",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://stripe.com/favicon.ico",
			author: "Stripe",
			repositoryUrl: "https://github.com/stripe/agent-toolkit",
			category: "Payments",
			tags: ["payments", "billing", "subscriptions", "fintech"],
		},
		{
			key: "resend",
			name: "Resend",
			description:
				"Modern email API for developers. Send transactional emails with excellent deliverability.",
			defaultUrl: null,
			command: "npx -y mcp-remote https://mcp.resend.com/sse",
			docsUrl: "https://resend.com/docs/mcp",
			transport: "SSE" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://resend.com/favicon.ico",
			author: "Resend",
			repositoryUrl: null,
			category: "Communication",
			tags: ["email", "transactional", "api", "developer-tools"],
		},
		{
			key: "vercel",
			name: "Vercel",
			description:
				"Deploy and manage Vercel projects. Access deployment logs, environment variables, and project settings.",
			defaultUrl: null,
			command: "npx -y @vercel/mcp",
			docsUrl:
				"https://vercel.com/docs/workflow-collaboration/vercel-mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://vercel.com/favicon.ico",
			author: "Vercel",
			repositoryUrl: null,
			category: "Cloud & Infrastructure",
			tags: ["deployment", "hosting", "serverless", "frontend"],
		},
		{
			key: "sentry",
			name: "Sentry",
			description:
				"Application monitoring and error tracking. Search issues, view stack traces, and manage error alerts.",
			defaultUrl: null,
			command: "npx -y @sentry/mcp-server",
			docsUrl: "https://docs.sentry.io/platforms/ai/mcp/",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://sentry.io/favicon.ico",
			author: "Sentry",
			repositoryUrl: "https://github.com/getsentry/sentry-mcp",
			category: "Developer Tools",
			tags: [
				"monitoring",
				"error-tracking",
				"debugging",
				"observability",
			],
		},
		{
			key: "neon",
			name: "Neon",
			description:
				"Serverless Postgres database management. Create databases, run queries, and manage branches.",
			defaultUrl: null,
			command: "npx -y @neondatabase/mcp-server-neon",
			docsUrl: "https://neon.tech/docs/ai/neon-mcp-server",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://neon.tech/favicon.ico",
			author: "Neon",
			repositoryUrl: "https://github.com/neondatabase/mcp-server-neon",
			category: "Data & Analytics",
			tags: ["database", "postgres", "serverless", "sql"],
		},
		{
			key: "turso",
			name: "Turso",
			description:
				"SQLite at the edge. Manage databases, run queries, and handle schema migrations.",
			defaultUrl: null,
			command: "npx -y @turso/mcp-server",
			docsUrl: "https://docs.turso.tech/features/ai-and-embeddings",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://turso.tech/favicon.ico",
			author: "Turso",
			repositoryUrl: "https://github.com/tursodatabase/turso-mcp",
			category: "Data & Analytics",
			tags: ["database", "sqlite", "edge", "libsql"],
		},
		{
			key: "upstash",
			name: "Upstash",
			description:
				"Serverless Redis, Kafka, and QStash. Manage caching, messaging, and background jobs.",
			defaultUrl: null,
			command: "npx -y @upstash/mcp-server",
			docsUrl: "https://upstash.com/docs/redis/integrations/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://upstash.com/favicon.ico",
			author: "Upstash",
			repositoryUrl: "https://github.com/upstash/mcp",
			category: "Data & Analytics",
			tags: ["redis", "kafka", "caching", "serverless", "messaging"],
		},
		{
			key: "twilio",
			name: "Twilio",
			description:
				"Communication APIs for SMS, voice, and messaging. Send texts, make calls, and manage conversations.",
			defaultUrl: null,
			command: "npx -y @twilio/mcp-server",
			docsUrl: "https://www.twilio.com/docs/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://www.twilio.com/favicon.ico",
			author: "Twilio",
			repositoryUrl: null,
			category: "Communication",
			tags: ["sms", "voice", "messaging", "communication"],
		},
		{
			key: "airtable",
			name: "Airtable",
			description:
				"Spreadsheet-database hybrid. Manage bases, tables, and records with a powerful API.",
			defaultUrl: null,
			command: "npx -y @airtable/mcp-server",
			docsUrl: "https://airtable.com/developers/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://airtable.com/favicon.ico",
			author: "Airtable",
			repositoryUrl: null,
			category: "Productivity",
			tags: ["database", "spreadsheet", "no-code", "collaboration"],
		},
		{
			key: "asana",
			name: "Asana",
			description:
				"Work management platform. Create tasks, manage projects, and track team progress.",
			defaultUrl: null,
			command: "npx -y @asana/mcp-server",
			docsUrl: "https://developers.asana.com/docs/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://asana.com/favicon.ico",
			author: "Asana",
			repositoryUrl: null,
			category: "Project Management",
			tags: ["project-management", "tasks", "team", "collaboration"],
		},
		{
			key: "todoist",
			name: "Todoist",
			description:
				"Task management for individuals and teams. Create, update, and organize tasks and projects.",
			defaultUrl: null,
			command: "npx -y @doist/todoist-mcp-server",
			docsUrl: "https://developer.todoist.com/mcp/",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://todoist.com/favicon.ico",
			author: "Doist",
			repositoryUrl: "https://github.com/Doist/todoist-mcp-server",
			category: "Productivity",
			tags: ["tasks", "todo", "productivity", "organization"],
		},
		{
			key: "raycast",
			name: "Raycast",
			description:
				"Productivity launcher and AI assistant. Execute commands, manage clipboard, and automate workflows.",
			defaultUrl: null,
			command: "npx -y @raycast/mcp-server",
			docsUrl: "https://developers.raycast.com/mcp",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://raycast.com/favicon.ico",
			author: "Raycast",
			repositoryUrl: null,
			category: "Productivity",
			tags: ["launcher", "automation", "productivity", "macos"],
		},
		{
			key: "axiom",
			name: "Axiom",
			description:
				"Log management and observability platform. Query logs, create dashboards, and set up alerts.",
			defaultUrl: null,
			command: "npx -y @axiomhq/mcp-server-axiom",
			docsUrl: "https://axiom.co/docs/send-data/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://axiom.co/favicon.ico",
			author: "Axiom",
			repositoryUrl: "https://github.com/axiomhq/mcp-server-axiom",
			category: "Developer Tools",
			tags: ["logging", "observability", "monitoring", "analytics"],
		},
		{
			key: "browserbase",
			name: "Browserbase",
			description:
				"Headless browser infrastructure. Run browser automation at scale with anti-detection features.",
			defaultUrl: null,
			command: "npx -y @browserbase/mcp-server",
			docsUrl: "https://docs.browserbase.com/integrations/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://browserbase.com/favicon.ico",
			author: "Browserbase",
			repositoryUrl:
				"https://github.com/browserbase/mcp-server-browserbase",
			category: "Browser Automation",
			tags: ["browser", "automation", "headless", "scraping"],
		},
		{
			key: "e2b",
			name: "E2B Code Interpreter",
			description:
				"Secure code execution sandbox. Run Python, JavaScript, and other code in isolated environments.",
			defaultUrl: null,
			command: "npx -y @e2b/mcp-server",
			docsUrl: "https://e2b.dev/docs/mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
			iconUrl: "https://e2b.dev/favicon.ico",
			author: "E2B",
			repositoryUrl: "https://github.com/e2b-dev/mcp-server",
			category: "Developer Tools",
			tags: ["code-execution", "sandbox", "python", "javascript"],
		},
		{
			key: "obsidian",
			name: "Obsidian",
			description:
				"Local-first knowledge management. Read, write, and search notes in your Obsidian vault.",
			defaultUrl: null,
			command: "npx -y mcp-obsidian",
			docsUrl: "https://github.com/smithery-ai/mcp-obsidian",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: "https://obsidian.md/favicon.ico",
			author: "Smithery AI",
			repositoryUrl: "https://github.com/smithery-ai/mcp-obsidian",
			category: "Productivity",
			tags: ["notes", "knowledge-base", "markdown", "local-first"],
		},
		{
			key: "sequential-thinking",
			name: "Sequential Thinking",
			description:
				"Dynamic problem-solving through thought sequences. Break down complex tasks into manageable steps.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-sequential-thinking",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: null,
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "AI & ML",
			tags: ["reasoning", "problem-solving", "thinking", "ai"],
		},
		{
			key: "everything",
			name: "Everything (MCP Test Server)",
			description:
				"Reference MCP server for testing. Demonstrates all MCP features including tools, prompts, and resources.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-everything",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: null,
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Developer Tools",
			tags: ["testing", "reference", "mcp", "demo"],
		},
		{
			key: "time",
			name: "Time",
			description:
				"Get current time and timezone information. Useful for scheduling and time-aware operations.",
			defaultUrl: null,
			command: "npx -y @modelcontextprotocol/server-time",
			docsUrl:
				"https://github.com/modelcontextprotocol/servers/tree/main/src/time",
			transport: "STDIO" as any,
			authMethods: ["NONE"] as any,
			iconUrl: null,
			author: "Anthropic",
			repositoryUrl: "https://github.com/modelcontextprotocol/servers",
			category: "Utilities",
			tags: ["time", "timezone", "scheduling", "utilities"],
		},
		{
			key: "azure-devops",
			name: "Azure DevOps",
			description:
				"Connect to Azure DevOps for work items, repositories, pipelines, wikis, and more. Requires your organization name and a Personal Access Token (PAT).",
			defaultUrl: null,
			// Pinned deliberately. 2.9.0 collapsed ~90 granular tools into ~40
			// action-dispatched ones (`wit_get_work_item` →
			// `wit_work_item {action:"get"}`), and most of our call sites still
			// resolve the granular names, so an unpinned `npx -y` silently
			// breaks pull/push on the next credential rotation. Lift the pin
			// once every site goes through `resolveAdoTool`.
			command: "npx -y @azure-devops/mcp@2.8.0",
			docsUrl: "https://github.com/microsoft/azure-devops-mcp",
			transport: "STDIO" as any,
			authMethods: ["API_KEY"] as any,
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
		},
	];

	let created = 0;
	let updated = 0;
	for (const s of servers) {
		const existing = await db.mCPServer.findFirst({
			where: { key: s.key, isSystemProvided: true },
		});
		if (existing) {
			await db.mCPServer.update({
				where: { id: existing.id },
				data: {
					name: s.name,
					description: s.description,
					defaultUrl: s.defaultUrl,
					command: s.command ?? null,
					docsUrl: s.docsUrl,
					transport: s.transport,
					authMethods: s.authMethods,
					oauthDiscoveryUrl: (s as any).oauthDiscoveryUrl ?? null,
					iconUrl: s.iconUrl ?? null,
					author: s.author ?? null,
					repositoryUrl: s.repositoryUrl ?? null,
					category: s.category ?? null,
					tags: (s as any).tags ?? [],
					isSystemProvided: true,
				},
			});
			updated++;
		} else {
			await db.mCPServer.create({
				data: {
					key: s.key,
					name: s.name,
					description: s.description,
					defaultUrl: s.defaultUrl,
					command: s.command ?? null,
					docsUrl: s.docsUrl,
					transport: s.transport,
					authMethods: s.authMethods,
					oauthDiscoveryUrl: (s as any).oauthDiscoveryUrl ?? null,
					iconUrl: s.iconUrl ?? null,
					author: s.author ?? null,
					repositoryUrl: s.repositoryUrl ?? null,
					category: s.category ?? null,
					tags: (s as any).tags ?? [],
					isSystemProvided: true,
				},
			});
			created++;
		}
	}
	logger.success(`MCP Servers - created: ${created}, updated: ${updated}`);
}

async function seedSystemPrompts() {
	logger.info("\nSeeding System Prompts...");
	const prompts = [
		{
			key: "document_generator_default",
			name: "Document Generator Default",
			description: "Default prompt for Document Generator agent",
			category: "General",
			tags: ["document", "generation", "default"],
			format: "MARKDOWN" as const,
			content:
				"You are a senior product manager AI. Generate a clear, structured PRD. Sections: Overview, Goals, Features, Success Metrics, Timeline. Use concise bullet points.",
			bindingTargetKey: "document_generator",
		},
		{
			key: "project_document_generator_default",
			name: "Project Document Generator Default",
			description: "Default prompt for Project Document Generator agent",
			category: "General",
			tags: ["project", "document", "generation", "default"],
			format: "MARKDOWN" as const,
			content:
				"You are a senior program manager AI. Generate a project document summarizing scope, milestones, owners, risks, and dependencies in a crisp, executive-friendly format.",
			bindingTargetKey: "project_document_generator",
		},
		// PM-sync conflict merge — the editable body of the 2-way AI merge
		// prompt. Resolved by key (`getPromptByKey`), NOT by an agent binding,
		// so it has no PROMPT_DOCUMENT_TYPE_BINDINGS entry. The locked
		// injection-safety clause is appended server-side and is intentionally
		// NOT part of this body. Content MUST match DEFAULT_MERGE_PROMPT_BODY
		// in `packages/api/.../sync/propose-ai-merge.ts`.
		{
			key: "pm_sync_conflict_merge",
			name: "PM Sync Conflict Merge",
			description:
				"Reconciles a work-item's title and description when it has diverged between Fabric and a connected PM tool.",
			category: "Project Management",
			tags: ["pm-sync", "conflict", "merge"],
			format: "MARKDOWN" as const,
			content: `You are reconciling two versions of a single work-item — its title and its description — that have diverged: one edited in Fabric, one edited in a connected project-management tool.

Produce one merged title and one merged description that preserve the useful intent and context from both sides. Change as little as possible — keep wording, structure, and formatting that both sides agree on, and weave in the distinct details each side adds. The result is a suggestion the user can edit, not a final answer.

Keep the merged title concise and plain (no markdown). Write the merged description as markdown. Do not add commentary, preamble, or explanations about what you changed.`,
		},
		// PRD Template - PM Standard v2 Format
		{
			key: "prd_template",
			name: "Product Requirements Document (PRD)",
			description:
				"PM Standard v2 PRD template following industry best practices for product planning and stakeholder alignment",
			category: "Project Management",
			tags: [
				"prd",
				"requirements",
				"product",
				"planning",
				"pm-standard-v2",
			],
			format: "HANDLEBARS" as const,
			isPublic: true,
			content: `## **PRD**

**Title:** {{projectName}}

**Owner:** {{#if author}}{{author}}{{else}}[PM Name]{{/if}}

**Status:** {{#if status}}{{status}}{{else}}Draft{{/if}}

**Target Release:** {{#if targetRelease}}{{targetRelease}}{{else}}[Quarter/Version]{{/if}}

**Links:** [Figma](link) · [Jira/Epics](link) · [Miro](link) · [Docs](link)

---

## **Benefit Hypothesis**

If we **[build {{projectName}}]** for **[target users]**, then **[measurable outcome]** improves because **[reason]**.

---

## **Overview**

- **Problem:** {{#if problemStatement}}{{problemStatement}}{{else}}[What's broken / slow / costly today? Quantify with numbers.]{{/if}}
- **Why now:** {{#if whyNow}}{{whyNow}}{{else}}[Trigger, urgency, or opportunity driving this work.]{{/if}}
- **Goal:**
{{#each goals}}
  - {{this}}
{{/each}}
{{#unless goals}}
  - [Specific goal 1]
  - [Specific goal 2]
  - [Specific goal 3 - max 3 goals]
{{/unless}}
- **Non-goals:**
{{#each nonGoals}}
  - {{this}}
{{/each}}
{{#unless nonGoals}}
  - [What we will NOT solve in this release]
  - [Another explicit exclusion]
{{/unless}}

---

## **Users / Personas**

- **Primary user:** {{#if primaryUser}}{{primaryUser}}{{else}}[Role/description of main user who benefits most]{{/if}}
- **Secondary user:** {{#if secondaryUser}}{{secondaryUser}}{{else}}[Other users who will use this]{{/if}}
- **Internal user (if any):** {{#if internalUser}}{{internalUser}}{{else}}[Internal teams affected]{{/if}}

---

## **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
{{#each kpis}}
| {{this.goal}} | {{this.metric}} |
{{/each}}
{{#unless kpis}}
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
{{/unless}}

**How we'll measure:** {{#if measurementMethod}}{{measurementMethod}}{{else}}[events/logs/dashboard] + [owner team/person]{{/if}}

---

## **Scope**

### **In Scope**
{{#each inScope}}
- {{this}}
{{/each}}
{{#unless inScope}}
- [What WILL be built/delivered]
- [Feature or capability included]
- [Another included item]
{{/unless}}

### **Out of Scope**
{{#each outOfScope}}
- {{this}}
{{/each}}
{{#unless outOfScope}}
- [What will NOT be addressed in this release]
- [Deferred item]
- [Explicit exclusion]
{{/unless}}

---

## **Requirements**

### **Must Have**
{{#each mustHave}}
- {{this}}
{{/each}}
{{#unless mustHave}}
- [Critical requirement 1 - MVP cannot ship without this]
- [Critical requirement 2]
- [Critical requirement 3]
{{/unless}}

### **Nice to Have**
{{#each niceToHave}}
- {{this}}
{{/each}}
{{#unless niceToHave}}
- [Enhancement that can be deferred if needed]
- [Additional feature for later]
{{/unless}}

**Non-Functional (only what matters)**

- Performance: {{#if performanceReqs}}{{performanceReqs}}{{else}}[Specific targets - response time, throughput]{{/if}}
- Security/Privacy: {{#if securityReqs}}{{securityReqs}}{{else}}[Compliance requirements, data protection]{{/if}}
- Reliability: {{#if reliabilityReqs}}{{reliabilityReqs}}{{else}}[Uptime SLA, failover requirements]{{/if}}

---

## **Key Flows / Use Cases**

1. **Happy path:**
{{#if happyPath}}
   - {{happyPath}}
{{else}}
   - [Step-by-step ideal scenario when everything works]
   - [Expected outcome and timing]
{{/if}}

2. **Edge cases:**
{{#each edgeCases}}
   - {{this.scenario}}: {{this.handling}}
{{/each}}
{{#unless edgeCases}}
   - [Unusual but valid scenario 1: how to handle]
   - [Unusual but valid scenario 2: how to handle]
{{/unless}}

3. **Failure / recovery:**
{{#each failureRecovery}}
   - {{this.failure}}: {{this.recovery}}
{{/each}}
{{#unless failureRecovery}}
   - [What happens when X fails: recovery approach]
   - [What happens when Y fails: recovery approach]
{{/unless}}

---

## **Dependencies / Risks**

- **Dependencies:**
{{#each dependencies}}
  - {{this.team}}: {{this.deliverable}} (due {{this.due}})
{{/each}}
{{#unless dependencies}}
  - [Team/API/vendor]: [What they must deliver] (due [when])
  - [Another dependency with owner and timing]
{{/unless}}

- **Risks:**
{{#each risks}}
  - {{this.risk}} → Mitigation: {{this.mitigation}}
{{/each}}
{{#unless risks}}
  - [Risk description] → Mitigation: [How we address it]
  - [Another risk] → Mitigation: [Mitigation strategy]
{{/unless}}

---

## **Open Questions**

{{#each openQuestions}}
- {{this}}
{{/each}}
{{#unless openQuestions}}
- [Unresolved question needing stakeholder input]
- [Another question requiring research or decision]
{{/unless}}

---

## **Work Breakdown**

- **Epics:**
{{#each epics}}
  - {{this}}
{{/each}}
{{#unless epics}}
  - [Epic 1: Large body of work]
  - [Epic 2: Another major workstream]
{{/unless}}

- **Features:**
{{#each features}}
  - {{this}}
{{/each}}
{{#unless features}}
  - [Feature 1: Distinct capability]
  - [Feature 2: Another capability]
{{/unless}}

- **Stories / Tasks:**
{{#each stories}}
  - {{this}}
{{/each}}
{{#unless stories}}
  - [Specific task or story]
  - [Another task]
{{/unless}}

- **Spikes (if needed):**
{{#each spikes}}
  - {{this}}
{{/each}}
{{#unless spikes}}
  - [Research or exploration needed]
{{/unless}}

---

## **Stakeholders**

- **Business/Sponsor:** {{#if businessSponsor}}{{businessSponsor}}{{else}}[Name, Title]{{/if}}
- **PM/PO:** {{#if pmOwner}}{{pmOwner}}{{else}}[Name, Title]{{/if}}
- **Engineering:** {{#if engineeringLead}}{{engineeringLead}}{{else}}[Tech Lead Name] + [Team Name]{{/if}}
- **Design:** {{#if designLead}}{{designLead}}{{else}}[Designer Name]{{/if}}
- **QA:** {{#if qaLead}}{{qaLead}}{{else}}[QA Lead Name]{{/if}}
- **Data/Analytics:** {{#if analyticsLead}}{{analyticsLead}}{{else}}[Analytics Lead Name]{{/if}}
- **Security/Compliance:** {{#if securityLead}}{{securityLead}}{{else}}[Security Lead Name]{{/if}}
- **Support/Ops:** {{#if supportLead}}{{supportLead}}{{else}}[Support/Ops Lead Name]{{/if}}

---

## **Release Notes**

{{#if releaseNotes}}{{releaseNotes}}{{else}}[What shipped] + [who it helps] + [any limitations or upcoming features].{{/if}}`,
			bindingTargetKey: null,
		},
		// Technical Specification Template
		{
			key: "technical_spec_template",
			name: "Technical Specification Document",
			description:
				"Detailed technical specification for system architecture and implementation",
			category: "Technical Documentation",
			tags: [
				"technical_spec",
				"technical",
				"specification",
				"architecture",
				"engineering",
			],
			format: "HANDLEBARS" as const,
			isPublic: true,
			content: `# Technical Specification: {{projectName}}

## 1. Executive Summary

**Project:** {{projectName}}

**Description:** {{projectDescription}}

**Tech Stack:** {{#each techStack}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}

## 2. System Architecture

### High-Level Architecture
- Describe the overall system architecture
- Identify major components and their interactions
- Define data flow and communication patterns

### Technology Stack
{{#each techStack}}
#### {{this}}
- **Purpose:** Why this technology was chosen
- **Version:** Specify version requirements
- **Integration:** How it integrates with other components
{{/each}}

## 3. System Components

### Frontend
- Framework and libraries
- State management approach
- UI/UX considerations
- Performance optimization strategies

### Backend
- API architecture (REST/GraphQL/gRPC)
- Business logic organization
- Authentication and authorization
- Error handling and logging

### Database
- Database type and schema design
- Data models and relationships
- Indexing strategy
- Backup and recovery procedures

### Infrastructure
- Hosting and deployment
- CI/CD pipeline
- Monitoring and observability
- Scaling strategy

## 4. API Specifications

### Endpoints
\`\`\`
GET /api/resource
POST /api/resource
PUT /api/resource/:id
DELETE /api/resource/:id
\`\`\`

### Request/Response Formats
- Define data structures
- Specify validation rules
- Document error responses

## 5. Data Models

### Core Entities
{{#each features}}
#### {{this}}
- Fields and data types
- Relationships
- Constraints and validations
{{/each}}

## 6. Security Considerations

### Authentication
- Authentication mechanism (JWT, OAuth, etc.)
- Session management
- Token refresh strategy

### Authorization
- Role-based access control (RBAC)
- Permission model
- Resource-level security

### Data Protection
- Encryption at rest and in transit
- PII handling
- Compliance requirements (GDPR, HIPAA, etc.)

## 7. Performance Requirements

### Response Time
- API response time targets
- Page load time goals
- Database query optimization

### Scalability
- Expected load and growth projections
- Horizontal vs vertical scaling strategy
- Caching strategy

## 8. Testing Strategy

### Unit Testing
- Coverage targets
- Testing frameworks
- Mocking strategy

### Integration Testing
- API testing approach
- Database testing
- Third-party integration testing

### End-to-End Testing
- User flow testing
- Cross-browser testing
- Performance testing

## 9. Deployment Strategy

### Environments
- Development
- Staging
- Production

### CI/CD Pipeline
- Build process
- Automated testing
- Deployment automation
- Rollback procedures

## 10. Monitoring and Maintenance

### Observability
- Logging strategy
- Metrics and dashboards
- Alerting rules

### Maintenance
- Update procedures
- Backup schedules
- Disaster recovery plan`,
			bindingTargetKey: null,
		},
		// Architecture Document Template
		{
			key: "architecture_doc_template",
			name: "Architecture Document",
			description:
				"System architecture documentation with diagrams and design decisions",
			category: "Technical Documentation",
			tags: ["architecture", "design", "system", "technical"],
			format: "HANDLEBARS" as const,
			isPublic: true,
			content: `# Architecture Document: {{projectName}}

## 1. Introduction

**Project:** {{projectName}}

**Description:** {{projectDescription}}

**Goals:** {{goals}}

## 2. Architecture Overview

### System Context
- Define the system boundaries
- Identify external systems and integrations
- Describe user interactions

### Architecture Style
- Microservices / Monolithic / Serverless
- Event-driven / Request-response
- Synchronous / Asynchronous communication

## 3. Component Architecture

### Frontend Architecture
- Framework: {{#each techStack}}{{#if (contains this "React|Vue|Angular|Next")}}{{this}}{{/if}}{{/each}}
- State management
- Routing strategy
- Component hierarchy

### Backend Architecture
- API layer
- Business logic layer
- Data access layer
- Background jobs and workers

### Data Architecture
- Database design
- Caching strategy
- Data flow and transformations

## 4. Technology Decisions

{{#each techStack}}
### {{this}}
- **Rationale:** Why this technology was chosen
- **Alternatives Considered:** Other options evaluated
- **Trade-offs:** Pros and cons
{{/each}}

## 5. Integration Points

### External Services
- Third-party APIs
- Payment gateways
- Authentication providers
- Analytics and monitoring

### Internal Services
- Service-to-service communication
- Message queues
- Event buses

## 6. Data Flow

### Request Flow
1. Client request
2. API gateway/Load balancer
3. Application server
4. Database/Cache
5. Response

### Event Flow
- Event producers
- Event consumers
- Event processing pipeline

## 7. Security Architecture

### Authentication & Authorization
- Identity provider
- Token management
- Permission model

### Network Security
- Firewall rules
- VPN/Private networks
- DDoS protection

### Data Security
- Encryption
- Key management
- Secrets management

## 8. Scalability & Performance

### Horizontal Scaling
- Load balancing strategy
- Session management
- Database replication

### Vertical Scaling
- Resource allocation
- Performance tuning
- Bottleneck identification

### Caching Strategy
- Cache layers (CDN, Application, Database)
- Cache invalidation
- Cache warming

## 9. Reliability & Resilience

### High Availability
- Redundancy
- Failover mechanisms
- Health checks

### Disaster Recovery
- Backup strategy
- Recovery procedures
- RTO and RPO targets

### Error Handling
- Retry logic
- Circuit breakers
- Graceful degradation

## 10. Monitoring & Observability

### Logging
- Log aggregation
- Log levels and formats
- Log retention

### Metrics
- Application metrics
- Infrastructure metrics
- Business metrics

### Tracing
- Distributed tracing
- Request correlation
- Performance profiling

## 11. Deployment Architecture

### Infrastructure
- Cloud provider
- Regions and availability zones
- Network topology

### Deployment Strategy
- Blue-green deployment
- Canary releases
- Rolling updates

## 12. Future Considerations

### Planned Improvements
- Technical debt items
- Performance optimizations
- Feature enhancements

### Scalability Roadmap
- Growth projections
- Scaling milestones
- Infrastructure evolution`,
			bindingTargetKey: null,
		},
		// Proposal Document Template - PM Standard v2
		{
			key: "proposal_doc_template",
			name: "Project Proposal Document",
			description:
				"PM Standard v2 project proposal template for stakeholder alignment and project approval",
			category: "Project Management",
			tags: [
				"proposal",
				"planning",
				"business",
				"stakeholder",
				"pm-standard-v2",
			],
			format: "HANDLEBARS" as const,
			isPublic: true,
			content: `### **Project Proposal**

**Title:** {{projectName}}

**Client/Team:** {{#if clientTeam}}{{clientTeam}}{{else}}[Client/Team Name]{{/if}}

**Sponsor:** {{#if sponsor}}{{sponsor}}{{else}}[Sponsor Name]{{/if}}

**Owner:** {{#if owner}}{{owner}}{{else}}[Owner Name]{{/if}}

**Date:** {{#if date}}{{date}}{{else}}[Date]{{/if}}

**Version:** {{#if version}}{{version}}{{else}}1.0{{/if}}

**Links:** PRD · Timeline · Budget (if any) · Architecture (if any)

---

### **Benefit Hypothesis**

If we deliver **[solution]**, then **[impact]** improves by **[metric]** because **[reason]**.

---

### **Overview**

**Current state:** {{#if currentState}}{{currentState}}{{else}}What exists today and what's painful.{{/if}}

**Proposed solution:** {{#if proposedSolution}}{{proposedSolution}}{{else}}What we'll change/build at a high level.{{/if}}

**Outcome:** {{#if outcome}}{{outcome}}{{else}}What success looks like.{{/if}}

---

### **Scope**

### **In Scope**
{{#each inScope}}
- {{this}}
{{/each}}
{{#unless inScope}}
- [What WILL be built/delivered]
- [Feature or capability included]
- [Another included item]
{{/unless}}

### **Out of Scope**
{{#each outOfScope}}
- {{this}}
{{/each}}
{{#unless outOfScope}}
- [What will NOT be addressed in this release]
- [Deferred item]
- [Explicit exclusion]
{{/unless}}

---

### **Deliverables**

**Product:** PRD, flows, wireframes, decisions

**Engineering:** services, integrations, automation, APIs

**Quality:** test plan, QA pass, release checklist

**Ops:** monitoring, alerts, runbook (if needed)

---

### **Plan (Phases)**

**Discovery:** outputs + decision gate

**Build:** outputs + decision gate

**Test & Launch:** outputs + decision gate

**Post-launch:** monitoring + iteration plan

---

### **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
{{#each kpis}}
| {{this.goal}} | {{this.metric}} |
{{/each}}
{{#unless kpis}}
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
| [Goal description] | [Specific metric with target] |
{{/unless}}

---

### **Dependencies / Risks**

**Dependencies:** access, data, teams, vendors
{{#each dependencies}}
- {{this.team}}: {{this.deliverable}} (due {{this.due}})
{{/each}}
{{#unless dependencies}}
- [Team/API/vendor]: [What they must deliver] (due [when])
- [Another dependency with owner and timing]
{{/unless}}

**Risks:** likelihood/impact + mitigation
{{#each risks}}
- {{this.risk}} → Mitigation: {{this.mitigation}}
{{/each}}
{{#unless risks}}
- [Risk description] → Mitigation: [How we address it]
- [Another risk] → Mitigation: [Mitigation strategy]
{{/unless}}

---

### **Stakeholders**
{{#each stakeholders}}
- {{this}}
{{/each}}
{{#unless stakeholders}}
- [Business/Sponsor]: [Name, Title]
- [PM/PO]: [Name, Title]
- [Engineering]: [Tech Lead Name] + [Team Name]
- [Design]: [Designer Name]
- [QA]: [QA Lead Name]
{{/unless}}

---

### **Open Questions**
{{#each openQuestions}}
- {{this}}
{{/each}}
{{#unless openQuestions}}
- [Unresolved question needing stakeholder input]
- [Another question requiring research or decision]
{{/unless}}

---

### **Release Notes**

{{#if releaseNotes}}{{releaseNotes}}{{else}}Plain language summary of what's delivered.{{/if}}`,
			bindingTargetKey: null,
		},
		// API Specification Template
		{
			key: "api_spec_template",
			name: "API Specification Document",
			description:
				"Comprehensive API documentation with endpoints, schemas, and examples",
			category: "Technical Documentation",
			tags: ["api_spec", "api", "specification", "documentation", "rest"],
			format: "HANDLEBARS" as const,
			isPublic: true,
			content: `# API Specification: {{projectName}}

## 1. Overview

**API Name:** {{projectName}} API

**Description:** {{projectDescription}}

**Base URL:** \`https://api.example.com/v1\`

**Authentication:** Bearer Token (JWT)

## 2. Authentication

### Obtain Access Token
\`\`\`http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
\`\`\`

**Response:**
\`\`\`json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
\`\`\`

### Using the Access Token
Include the access token in the Authorization header:
\`\`\`
Authorization: Bearer {accessToken}
\`\`\`

## 3. API Endpoints

{{#each features}}
### {{this}}

#### List {{this}}
\`\`\`http
GET /api/{{toLowerCase this}}
Authorization: Bearer {token}
\`\`\`

**Query Parameters:**
- \`page\` (integer): Page number (default: 1)
- \`limit\` (integer): Items per page (default: 20)
- \`sort\` (string): Sort field (default: createdAt)
- \`order\` (string): Sort order (asc/desc, default: desc)

**Response:**
\`\`\`json
{
  "data": [
    {
      "id": "uuid",
      "name": "Example",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
\`\`\`

#### Get {{this}} by ID
\`\`\`http
GET /api/{{toLowerCase this}}/:id
Authorization: Bearer {token}
\`\`\`

**Response:**
\`\`\`json
{
  "id": "uuid",
  "name": "Example",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
\`\`\`

#### Create {{this}}
\`\`\`http
POST /api/{{toLowerCase this}}
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "New Item",
  "description": "Description"
}
\`\`\`

**Response:**
\`\`\`json
{
  "id": "uuid",
  "name": "New Item",
  "description": "Description",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
\`\`\`

#### Update {{this}}
\`\`\`http
PUT /api/{{toLowerCase this}}/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "Updated Item",
  "description": "Updated description"
}
\`\`\`

**Response:**
\`\`\`json
{
  "id": "uuid",
  "name": "Updated Item",
  "description": "Updated description",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
\`\`\`

#### Delete {{this}}
\`\`\`http
DELETE /api/{{toLowerCase this}}/:id
Authorization: Bearer {token}
\`\`\`

**Response:**
\`\`\`json
{
  "message": "Item deleted successfully"
}
\`\`\`

{{/each}}

## 4. Data Models

{{#each features}}
### {{this}} Model
\`\`\`typescript
interface {{this}} {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}
\`\`\`
{{/each}}

## 5. Error Responses

### Error Format
\`\`\`json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
\`\`\`

### Common Error Codes
- \`400\` Bad Request: Invalid request parameters
- \`401\` Unauthorized: Missing or invalid authentication
- \`403\` Forbidden: Insufficient permissions
- \`404\` Not Found: Resource not found
- \`422\` Unprocessable Entity: Validation errors
- \`429\` Too Many Requests: Rate limit exceeded
- \`500\` Internal Server Error: Server error

## 6. Rate Limiting

- **Rate Limit:** 1000 requests per hour per API key
- **Headers:**
  - \`X-RateLimit-Limit\`: Maximum requests per hour
  - \`X-RateLimit-Remaining\`: Remaining requests
  - \`X-RateLimit-Reset\`: Time when limit resets (Unix timestamp)

## 7. Webhooks

### Webhook Events
{{#each features}}
- \`{{toLowerCase this}}.created\`
- \`{{toLowerCase this}}.updated\`
- \`{{toLowerCase this}}.deleted\`
{{/each}}

### Webhook Payload
\`\`\`json
{
  "event": "resource.created",
  "timestamp": "2024-01-01T00:00:00Z",
  "data": {
    "id": "uuid",
    "name": "Example"
  }
}
\`\`\`

## 8. Versioning

- Current version: v1
- Version specified in URL: \`/v1/resource\`
- Deprecated versions supported for 6 months

## 9. SDKs and Libraries

### Official SDKs
- JavaScript/TypeScript: \`npm install @example/api-client\`
- Python: \`pip install example-api-client\`
- Go: \`go get github.com/example/api-client-go\`

### Example Usage (TypeScript)
\`\`\`typescript
import { ApiClient } from '@example/api-client';

const client = new ApiClient({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.example.com/v1'
});

const items = await client.items.list();
\`\`\``,
			bindingTargetKey: null,
		},
		// Features Template - PM Standard v2
		{
			key: "user_stories_template",
			name: "Features Document",
			description:
				"PM Standard v2 feature template with Given/When/Then acceptance criteria",
			category: "Project Management",
			tags: [
				"user_story",
				"user-stories",
				"agile",
				"requirements",
				"backlog",
				"pm-standard-v2",
			],
			format: "MARKDOWN" as const,
			isPublic: true,
			content: `🛑 CRITICAL: Your output MUST start with "## **F-001:" - NO INTRODUCTION OR PREAMBLE

You are generating features for ACTUAL APP FEATURES. Output ONLY numbered features in the exact format below.

❌ FORBIDDEN - DO NOT OUTPUT ANY OF THESE:
- Introduction or overview text
- "User Personas and Goals" section or tables
- "Feature Format Template" section
- "Acceptance Criteria Patterns" section
- "Feature Sizing Guidelines" or XS/S/M/L/XL explanations
- "INVEST Validation" section
- "Definition of Ready" or "Definition of Done" sections
- "Example Features" section
- ANY numbered section like "1. User Personas"
- ANY explanatory text before the first feature
- ANY feature about "defining personas" or "creating templates" or "establishing guidelines"
- ANY meta-feature about documentation, specifications, or feature formats
- Features where the role is "product team member" or "documentation writer"

🚫 SPECIFICALLY FORBIDDEN FIRST FEATURE PATTERNS:
- "F-001: ... Specification" or "F-001: ... Framework" or "F-001: ... Guidelines"
- Features about "defining", "establishing", "creating documentation"
- Features where the goal is about templates, formats, or standards

✅ CORRECT FIRST FEATURES (actual app features):
- "F-001: User Registration" - actual feature
- "F-001: Create New Game" - actual feature
- "F-001: View Leaderboard" - actual feature

✅ YOUR EXACT OUTPUT FORMAT:

## **F-001: [Feature Title]**

### **Description**

As a **[role]**,

I want **[goal]**,

So that **[benefit]**.

### **Acceptance Criteria (G/W/T + AND)**

**Main Flow**

**GIVEN** [context]

**WHEN** [action]

**THEN** [expected result]

**AND** [additional expected result]

**Edge Cases** (only if applicable)

**GIVEN** [edge context]

**WHEN** [action]

**THEN** [expected result]

**Errors / Validation** (only if applicable)

**GIVEN** [invalid input or system failure]

**WHEN** [action is attempted]

**THEN** [clear error is shown]

**AND** [user can retry or recover]

**Permissions** (only if applicable)

**GIVEN** user is **[role]**

**WHEN** [action is attempted]

**THEN** [allowed/blocked behavior occurs]

**Tracking** (only if applicable)

**GIVEN** [event-worthy action occurs]

**WHEN** [system records analytics]

**THEN** event **[name]** is emitted

### **Notes / Links**

Designs:

API:

Test data:

### **Release Notes**

Plain language (1–2 lines).

---

## **F-002: [Next Feature Title]**

[Same structure...]

Continue with F-003, F-004, etc. for 15-25 total features.

🚨 THE FIRST LINE OF YOUR RESPONSE MUST BE: ## **F-001:`,
			bindingTargetKey: null,
		},
	];

	let created = 0;
	let updated = 0;
	let versionsCreated = 0;
	let bindingsCreated = 0;
	let bindingsUpdated = 0;

	for (const p of prompts) {
		const existing = await db.prompt.findFirst({
			where: { key: p.key, scope: "SYSTEM" as any },
		});
		let promptId: string;
		if (existing) {
			promptId = existing.id;
		} else {
			const createdPrompt = await db.prompt.create({
				data: {
					key: p.key,
					name: p.name,
					description: p.description,
					scope: "SYSTEM" as any,
					format: (p as any).format || "MARKDOWN",
					category: (p as any).category,
					tags: (p as any).tags || [],
					isPublic: (p as any).isPublic || false,
					createdBy: "system",
				},
			});
			promptId = createdPrompt.id;
			created++;
		}

		const latest = await db.promptVersion.findFirst({
			where: { promptId },
			orderBy: { version: "desc" },
		});

		let currentVersionId: string | null = null;

		if (!latest) {
			// No version exists - create first version
			const newVersion = await db.promptVersion.create({
				data: {
					promptId,
					version: 1,
					content: p.content,
					variables: {},
					createdBy: "system",
				},
			});
			currentVersionId = newVersion.id;
			versionsCreated++;
		} else if (latest.content !== p.content) {
			// Content has changed - create new version
			const newVersion = await db.promptVersion.create({
				data: {
					promptId,
					version: latest.version + 1,
					content: p.content,
					variables: {},
					createdBy: "system-seed-update",
				},
			});
			currentVersionId = newVersion.id;
			updated++;
			logger.info(
				`  Updated ${p.key}: v${latest.version} → v${newVersion.version}`,
			);

			// Update all existing bindings for this prompt to use the new version
			const existingBindings = await db.promptBinding.findMany({
				where: { promptVersionId: latest.id },
			});

			for (const binding of existingBindings) {
				await db.promptBinding.update({
					where: { id: binding.id },
					data: { promptVersionId: newVersion.id },
				});
				bindingsUpdated++;
			}
		} else {
			// Content unchanged - use existing version
			currentVersionId = latest.id;
		}

		// Create or update SYSTEM bindings for document types.
		// All entries in this seed are non-stage document templates (PRD, PROPOSAL,
		// etc.) so storyKind is always null — kind-scoped stage bindings live in
		// seed-prompts-only.ts (run via pnpm seed:prompts).
		const documentTypes = PROMPT_DOCUMENT_TYPE_BINDINGS[p.key] || [];
		if (documentTypes.length > 0 && currentVersionId) {
			for (const documentType of documentTypes) {
				const existingBinding = await db.promptBinding.findFirst({
					where: {
						targetType: "AGENT" as any,
						targetKey: "project_document_generator",
						documentType,
						storyKind: null,
						scope: "SYSTEM" as any,
						// SYSTEM bindings must have null userId/organizationId
						userId: null,
						organizationId: null,
					},
				});

				if (!existingBinding) {
					await db.promptBinding.create({
						data: {
							targetType: "AGENT" as any,
							targetKey: "project_document_generator",
							documentType,
							storyKind: null,
							scope: "SYSTEM" as any,
							promptVersionId: currentVersionId,
							isDefault: true,
							// SYSTEM bindings have no user/org context
							userId: null,
							organizationId: null,
						},
					});
					bindingsCreated++;
				} else if (
					existingBinding.promptVersionId !== currentVersionId
				) {
					// Update existing binding if it points to a different version/prompt
					await db.promptBinding.update({
						where: { id: existingBinding.id },
						data: { promptVersionId: currentVersionId },
					});
					bindingsUpdated++;
				}
			}
		}

		// Legacy binding support for agents with bindingTargetKey
		if (p.bindingTargetKey && currentVersionId) {
			const existingBinding = await db.promptBinding.findFirst({
				where: {
					targetType: "AGENT" as any,
					targetKey: p.bindingTargetKey,
					scope: "SYSTEM" as any,
				},
			});
			if (!existingBinding) {
				await db.promptBinding.create({
					data: {
						targetType: "AGENT" as any,
						targetKey: p.bindingTargetKey,
						scope: "SYSTEM" as any,
						promptVersionId: currentVersionId,
						documentType: "GENERAL",
						isDefault: false,
					},
				});
				bindingsCreated++;
			}
		}
	}

	logger.success(
		`Prompts - created: ${created}, updated: ${updated}, versions: ${versionsCreated}, bindings created: ${bindingsCreated}, bindings updated: ${bindingsUpdated}`,
	);
}

async function seedSystemAgents() {
	logger.info("\nSeeding System Agents...");

	// Log the URLs being used for agents (helps debug environment-specific issues)
	logger.info("Agent URLs being used:");
	logger.info(
		`  DOCUMENT_GENERATOR_URL: ${getDeploymentUrl("DOCUMENT_GENERATOR_URL", 8124)}`,
	);
	logger.info(
		`  PROJECT_DOCUMENT_GENERATOR_URL: ${getDeploymentUrl("PROJECT_DOCUMENT_GENERATOR_URL", 8125)}`,
	);
	logger.info(
		`  TASK_PLANNER_URL: ${getDeploymentUrl("TASK_PLANNER_URL", 8126)}`,
	);
	logger.info(
		`  STORY_BREAKDOWN_URL: ${getDeploymentUrl("STORY_BREAKDOWN_URL", 8127)}`,
	);
	logger.info(`  API_AGENT_URL: ${getDeploymentUrl("API_AGENT_URL", 8131)}`);
	logger.info(
		`  PROMPT_ENHANCER_URL: ${getDeploymentUrl("PROMPT_ENHANCER_URL", 8134)}`,
	);
	logger.info(
		`  CUGA_AGENT_URL: ${getDeploymentUrl("CUGA_AGENT_URL", 9999)}`,
	);
	logger.info(`  CUGA_UI_URL: ${getDeploymentUrl("CUGA_UI_URL", 7860)}`);

	// Get or create a system user for system agents
	let systemUser = await db.user.findFirst({
		where: { email: "system@fabric.local" },
	});

	if (!systemUser) {
		// Get first admin user as fallback
		systemUser = await db.user.findFirst({
			where: { role: "admin" },
		});
	}

	if (!systemUser) {
		logger.warn("No admin user found, skipping system agents seeding");
		return;
	}

	const systemUserId = systemUser.id;

	const agents = [
		{
			agentId: "document_generator",
			name: "document_generator",
			displayName: "Document Generator",
			description:
				"Generates various document types from templates and context",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v1",
			deploymentUrl: getDeploymentUrl("DOCUMENT_GENERATOR_URL", 8124),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			config: {
				graphId: "document_generator",
				supportedTypes: [
					"general",
					"prd",
					"api_spec",
					"architecture",
					"technical_spec",
				],
			},
			metadata: {
				icon: "file-text",
				category: "Document Generation",
			},
		},
		{
			agentId: "project_document_generator",
			name: "project_document_generator",
			displayName: "Project Document Generator",
			description:
				"Generates project documents with real-time streaming and diff preview",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v1",
			deploymentUrl: getDeploymentUrl(
				"PROJECT_DOCUMENT_GENERATOR_URL",
				8125,
			),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			config: {
				graphId: "project_document_generator",
				supportsPredictiveState: true,
			},
			metadata: {
				icon: "folder-kanban",
				category: "Document Generation",
			},
		},
		{
			agentId: "prompt_enhancer",
			name: "prompt_enhancer",
			displayName: "Prompt Enhancer",
			description:
				"Enhances prompts while preserving template syntax and formatting",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v1",
			deploymentUrl: getDeploymentUrl("PROMPT_ENHANCER_URL", 8134),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			config: {
				graphId: "prompt_enhancer",
				preservesTemplateFormat: true,
			},
			metadata: {
				icon: "sparkles",
				category: "Prompt Engineering",
			},
		},
		{
			agentId: "story_breakdown",
			name: "story_breakdown",
			displayName: "Story Breakdown",
			description: "Converts PRDs into features with acceptance criteria",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v1",
			deploymentUrl: getDeploymentUrl("STORY_BREAKDOWN_URL", 8127),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			config: {
				graphId: "story_breakdown",
				supportsPredictiveState: true,
			},
			metadata: {
				icon: "list-todo",
				category: "Development Workflow",
				pipelineStage: "story_breakdown",
			},
		},
		{
			agentId: "task_planner",
			name: "task_planner",
			displayName: "Task Planner",
			description:
				"CUGA-enhanced task decomposition with risk analysis, dependency graphs, and execution planning",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v2",
			deploymentUrl: getDeploymentUrl("TASK_PLANNER_URL", 8126),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			heroEmojis: ["📋", "⚡", "🎯"],
			config: {
				graphId: "task_planner",
				supportsPredictiveState: true,
				cugaFeatures: {
					taskDecomposition: true,
					riskAnalysis: true,
					dependencyGraphs: true,
					executionPlanning: true,
					reflection: true,
					hitl: true,
				},
				predictiveStates: [
					"document",
					"decomposedTasks",
					"riskAnalysis",
					"dependencyGraph",
					"executionPlan",
				],
			},
			metadata: {
				icon: "check-square",
				category: "Development Workflow",
				pipelineStage: "task_planning",
				version: "2.0.0",
				tags: ["cuga", "risk-analysis", "planning"],
			},
		},
		{
			agentId: "api_agent",
			name: "api_agent",
			displayName: "API Agent",
			description:
				"Executes external API calls based on registered OpenAPI specifications. Best for calling REST APIs, integrating with third-party services, and data retrieval using OpenAPI Services.",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v1",
			deploymentUrl: getDeploymentUrl("API_AGENT_URL", 8131),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			heroEmojis: ["🔌", "⚡", "🌐"],
			config: {
				graphId: "api_agent",
				supportsPredictiveState: false,
				usesOpenAPI: true,
			},
			metadata: {
				icon: "plug",
				category: "API Integration",
				version: "1.0.0",
				tags: ["api", "openapi", "integration", "rest"],
			},
		},
		{
			agentId: "cuga_generalist",
			name: "cuga_generalist",
			displayName: "CUGA Generalist Agent",
			description:
				"Configurable Universal Generalist Agent (CUGA) - A powerful multi-agent system with specialized sub-agents for browser automation, API orchestration, code execution, and task decomposition.",
			framework: "LANGGRAPH" as const,
			runtimeVersion: "v1",
			deploymentUrl: getDeploymentUrl("CUGA_AGENT_URL", 9999),
			scope: "SYSTEM" as const,
			status: "ACTIVE" as const,
			heroEmojis: ["🤖", "🧠", "⚡"],
			config: {
				graphId: "cuga_generalist",
				supportsPredictiveState: true,
				hasNativeUI: true,
				uiUrl: getDeploymentUrl("CUGA_UI_URL", 7860),
			},
			metadata: {
				icon: "bot",
				category: "Multi-Agent System",
				version: "1.0.0",
				tags: ["cuga", "browser", "automation", "generalist"],
			},
		},
	];

	let created = 0;
	let updated = 0;
	let registeredCreated = 0;
	let registeredUpdated = 0;

	for (const agent of agents) {
		// Upsert into Agent table (legacy/system table)
		const existing = await db.agent.findUnique({
			where: { agentId: agent.agentId },
		});

		if (existing) {
			await db.agent.update({
				where: { id: existing.id },
				data: {
					name: agent.name,
					displayName: agent.displayName,
					description: agent.description,
					framework: agent.framework,
					runtimeVersion: agent.runtimeVersion,
					deploymentUrl: agent.deploymentUrl,
					scope: agent.scope,
					status: agent.status,
					config: agent.config,
					metadata: agent.metadata,
					heroEmojis: agent.heroEmojis || [],
				},
			});
			updated++;
		} else {
			await db.agent.create({
				data: {
					agentId: agent.agentId,
					name: agent.name,
					displayName: agent.displayName,
					description: agent.description,
					framework: agent.framework,
					runtimeVersion: agent.runtimeVersion,
					deploymentUrl: agent.deploymentUrl,
					userId: systemUserId, // Use admin user for system agents
					scope: agent.scope,
					status: agent.status,
					config: agent.config,
					metadata: agent.metadata,
					heroEmojis: agent.heroEmojis || [],
				},
			});
			created++;
		}

		// Also upsert into RegisteredAgent table (used by UI agents page)
		const existingRegistered = await db.registeredAgent.findUnique({
			where: { agentId: agent.agentId },
		});

		if (existingRegistered) {
			await db.registeredAgent.update({
				where: { id: existingRegistered.id },
				data: {
					name: agent.name,
					displayName: agent.displayName,
					description: agent.description,
					framework: agent.framework,
					deploymentUrl: agent.deploymentUrl,
					scope: agent.scope,
					status: agent.status,
					config: agent.config,
					metadata: agent.metadata,
				},
			});
			registeredUpdated++;
		} else {
			await db.registeredAgent.create({
				data: {
					agentId: agent.agentId,
					name: agent.name,
					displayName: agent.displayName,
					description: agent.description,
					framework: agent.framework,
					deploymentUrl: agent.deploymentUrl,
					scope: agent.scope,
					status: agent.status,
					config: agent.config,
					metadata: agent.metadata,
				},
			});
			registeredCreated++;
		}
	}

	logger.success(`System Agents - created: ${created}, updated: ${updated}`);
	logger.success(
		`Registered Agents - created: ${registeredCreated}, updated: ${registeredUpdated}`,
	);
}

async function seedFizzyMcpServer() {
	logger.info("\nSeeding Fizzy MCP Server...");

	const existing = await db.mCPServer.findFirst({
		where: { key: "fizzy", isSystemProvided: true },
	});

	const fizzyServer = {
		key: "fizzy",
		name: "Fizzy",
		description:
			"Project management tool by Basecamp - manage boards, cards, and workflows",
		defaultUrl: "https://fizzy.fabric.pro/mcp",
		docsUrl: "https://github.com/Fabric-Pro/fizzy-mcp",
		// The proxy serves no icon; null so the catalog falls back to its placeholder.
		iconUrl: null,
		transport: "HTTP" as const,
		authMethods: ["API_KEY"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		author: "Fabric Pro",
		repositoryUrl: "https://github.com/Fabric-Pro/fizzy-mcp",
		category: "Project Management",
		tags: ["project-management", "issue-tracking", "kanban", "tasks"],
		isSystemProvided: true,
	};

	if (existing) {
		await db.mCPServer.update({
			where: { id: existing.id },
			data: fizzyServer,
		});
		logger.success("Fizzy MCP Server - updated");
	} else {
		await db.mCPServer.create({
			data: fizzyServer,
		});
		logger.success("Fizzy MCP Server - created");
	}
}

async function seedFabricMcpServer() {
	logger.info("\nSeeding Fabric MCP Server...");

	const existing = await db.mCPServer.findFirst({
		where: { key: "fabric", isSystemProvided: true },
	});

	const fabricServer = {
		key: "fabric",
		name: "Fabric MCP",
		description:
			"Connect to Fabric as an MCP server to access your Fabric workspaces, projects, prompts, documents, and connected tools from MCP clients.",
		defaultUrl: "https://fabric.pro/mcp",
		docsUrl: "https://fabric.pro/docs/integrations/mcp-gateway",
		transport: "HTTP" as const,
		authMethods: ["API_KEY"] as ("NONE" | "API_KEY" | "OAUTH2")[],
		iconUrl: "https://fabric.pro/favicon.ico",
		author: "Fabric",
		repositoryUrl: "https://github.com/Fabric-Pro/fabric-oss",
		category: "Productivity",
		tags: [
			"fabric",
			"projects",
			"documents",
			"workspaces",
			"automation",
			"ai",
		],
		isSystemProvided: true,
	};

	if (existing) {
		await db.mCPServer.update({
			where: { id: existing.id },
			data: fabricServer,
		});
		logger.success("Fabric MCP Server - updated");
	} else {
		await db.mCPServer.create({
			data: fabricServer,
		});
		logger.success("Fabric MCP Server - created");
	}
}

/**
 * Seed Enterprise Remote MCP Servers
 * These are official vendor-hosted MCP servers for Atlassian, Notion, and Linear
 */
async function seedEnterpriseMcpServers() {
	logger.info("\nSeeding Enterprise Remote MCP Servers...");

	const enterpriseServers = [
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
			// Notion MCP uses DCR - endpoints are auto-discovered from https://mcp.notion.com/.well-known/oauth-authorization-server
			// registration_endpoint: https://mcp.notion.com/register
			iconUrl: "https://www.notion.so/images/favicon.ico",
			author: "Notion",
			repositoryUrl: "https://github.com/makenotion/notion-mcp-server",
			category: "Productivity",
			tags: ["docs", "database", "wiki", "knowledge-base", "notes"],
			isSystemProvided: true,
		},
		{
			key: "linear-remote",
			name: "Linear (Official)",
			description:
				"Connect to Linear via Linear's official remote MCP server. Modern issue tracking for high-performance teams.",
			defaultUrl: "https://mcp.linear.app/mcp",
			docsUrl: "https://linear.app/docs/mcp",
			transport: "SSE" as const,
			authMethods: ["OAUTH2"] as ("NONE" | "API_KEY" | "OAUTH2")[],
			// Linear MCP uses DCR - endpoints are auto-discovered from https://mcp.linear.app/.well-known/oauth-authorization-server
			// registration_endpoint: https://mcp.linear.app/register
			iconUrl: "https://linear.app/favicon.ico",
			author: "Linear",
			category: "Project Management",
			tags: [
				"issues",
				"agile",
				"projects",
				"tracking",
				"project-management",
			],
			isSystemProvided: true,
		},
		{
			// Excalidraw — managed-default MCP server. Seeded as
			// `defaultEnabled = true` with eager-routing metadata so the
			// orchestrator can pre-load `create_view` whenever a user asks
			// for an Excalidraw diagram. The backfill migration's UPDATE
			// targets this same row by `key = 'excalidraw'`; keeping the
			// values identical here means a fresh `pnpm seed` produces the
			// same end-state a migrated DB has.
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

	let created = 0;
	let updated = 0;

	for (const server of enterpriseServers) {
		const existing = await db.mCPServer.findFirst({
			where: { key: server.key, isSystemProvided: true },
		});

		if (existing) {
			await db.mCPServer.update({
				where: { id: existing.id },
				data: {
					name: server.name,
					description: server.description,
					defaultUrl: server.defaultUrl,
					docsUrl: server.docsUrl,
					transport: server.transport,
					authMethods: server.authMethods,
					oauthDiscoveryUrl:
						(server as any).oauthDiscoveryUrl ?? null,
					oauthAuthorizationEndpoint:
						(server as any).oauthAuthorizationEndpoint ?? null,
					oauthTokenEndpoint:
						(server as any).oauthTokenEndpoint ?? null,
					iconUrl: server.iconUrl ?? null,
					author: server.author ?? null,
					repositoryUrl: (server as any).repositoryUrl ?? null,
					category: server.category ?? null,
					tags: server.tags ?? [],
					isSystemProvided: true,
					// Managed-default routing metadata (used by the
					// orchestrator's eager-routing helper). Defaults are
					// safe — most servers leave these unset.
					defaultEnabled: (server as any).defaultEnabled ?? false,
					eagerKeywords: (server as any).eagerKeywords ?? [],
					eagerToolName: (server as any).eagerToolName ?? null,
					suppressOnEager: (server as any).suppressOnEager ?? [],
				},
			});
			updated++;
		} else {
			await db.mCPServer.create({
				data: {
					key: server.key,
					name: server.name,
					description: server.description,
					defaultUrl: server.defaultUrl,
					docsUrl: server.docsUrl,
					transport: server.transport,
					authMethods: server.authMethods,
					oauthDiscoveryUrl:
						(server as any).oauthDiscoveryUrl ?? null,
					oauthAuthorizationEndpoint:
						(server as any).oauthAuthorizationEndpoint ?? null,
					oauthTokenEndpoint:
						(server as any).oauthTokenEndpoint ?? null,
					iconUrl: server.iconUrl ?? null,
					author: server.author ?? null,
					repositoryUrl: (server as any).repositoryUrl ?? null,
					category: server.category ?? null,
					tags: server.tags ?? [],
					isSystemProvided: true,
					// Managed-default routing metadata (used by the
					// orchestrator's eager-routing helper). Defaults are
					// safe — most servers leave these unset.
					defaultEnabled: (server as any).defaultEnabled ?? false,
					eagerKeywords: (server as any).eagerKeywords ?? [],
					eagerToolName: (server as any).eagerToolName ?? null,
					suppressOnEager: (server as any).suppressOnEager ?? [],
				},
			});
			created++;
		}
	}

	logger.success(
		`Enterprise MCP Servers - created: ${created}, updated: ${updated}`,
	);
}

/**
 * Seeds a managed-default sentinel `MCPConfig` for every existing
 * `(userId, organizationId | null)` tuple — one per server flagged
 * `defaultEnabled = true` in the registry. Idempotent: rows that
 * already exist are left alone.
 *
 * Why this exists: the production backfill migration's INSERT runs
 * against tenant rows that exist at migration time. Fresh local installs
 * apply migrations BEFORE `seedUsers()` runs, so the backfill's tenant
 * cross-join finds zero rows and the sentinels never get created. This
 * helper closes that gap by mirroring the same per-tenant seeding the
 * Better Auth `databaseHooks.user.create.after` hook does for new
 * signups.
 */
async function seedDefaultMcpConfigsForExistingTenants() {
	logger.info("\nSeeding managed-default MCPConfig sentinels...");

	const defaultServers = await db.mCPServer.findMany({
		where: { defaultEnabled: true, isSystemProvided: true },
		select: { id: true, key: true, authMethods: true },
	});
	if (defaultServers.length === 0) {
		logger.info("  (no default-enabled servers — skipping sentinel seed)");
		return;
	}

	const users = await db.user.findMany({ select: { id: true } });
	const members = await db.member.findMany({
		select: { userId: true, organizationId: true },
	});

	const tenantTuples: Array<{
		userId: string;
		organizationId: string | null;
	}> = [
		...users.map((u) => ({ userId: u.id, organizationId: null as null })),
		...members.map((m) => ({
			userId: m.userId,
			organizationId: m.organizationId,
		})),
	];

	let created = 0;
	for (const server of defaultServers) {
		// Pick the simplest available auth method. Excalidraw is "NONE".
		const authType = (server.authMethods?.[0] ?? "NONE") as
			| "NONE"
			| "API_KEY"
			| "OAUTH2";
		for (const tuple of tenantTuples) {
			const existing = await db.mCPConfig.findFirst({
				where: {
					mcpServerId: server.id,
					userId: tuple.userId,
					organizationId: tuple.organizationId,
				},
			});
			if (existing) {
				continue;
			}
			await db.mCPConfig.create({
				data: {
					mcpServerId: server.id,
					userId: tuple.userId,
					organizationId: tuple.organizationId,
					authType,
					enabled: true,
					isManagedDefault: true,
				},
			});
			created++;
		}
	}
	logger.success(`Managed-default MCPConfig sentinels - created: ${created}`);
}

async function seedAll() {
	await seedUsers();
	await seedOrganization(); // Create org and link users after users are created
	await seedMcpServers();
	await seedSystemPrompts();
	await seedSystemAgents();
	await seedFabricMcpServer();
	await seedFizzyMcpServer();
	await seedEnterpriseMcpServers();
	await seedDefaultMcpConfigsForExistingTenants();
}

// Run the seed function
seedAll()
	.catch((error) => {
		logger.error("Seed failed:", error);
		process.exit(1);
	})
	.finally(() => {
		process.exit(0);
	});
