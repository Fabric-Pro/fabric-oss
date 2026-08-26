/**
 * Seed MCP Servers from Official Registry
 *
 * Fetches MCP servers from the official Model Context Protocol registry
 * (https://registry.modelcontextprotocol.io) and seeds them into the database.
 *
 * Run with: pnpm --filter @repo/database seed:mcp-registry
 */

import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";
import { db } from "./client";
import { CURATED_SYSTEM_MCP_SERVER_KEY_SET } from "./curated-mcp-server-keys";

const IMPLEMENTED_MCP_SERVER_KEYS = new Set([
	"slack-remote",
	"google-drive",
	"notion-remote",
	"github-remote",
	"fabric",
	"fizzy",
	"azure-devops",
	"atlassian",
	"excalidraw",
	"gitlab",
]);

// MCP Transport and Auth types (matching Prisma enum values)
type MCPTransport = "STDIO" | "HTTP" | "SSE";
type MCPAuthMethod = "NONE" | "API_KEY" | "OAUTH2";

interface RegistryPackage {
	registryType: "npm" | "oci" | "pypi";
	identifier: string;
	version?: string;
	transport?: {
		type: "stdio" | "streamable-http" | "sse";
		url?: string;
	};
	environmentVariables?: Array<{
		name: string;
		isSecret?: boolean;
		isRequired?: boolean;
		default?: string;
	}>;
}

interface RegistryRemote {
	type: "streamable-http" | "sse";
	url: string;
	headers?: Array<{
		name: string;
		isSecret?: boolean;
		isRequired?: boolean;
	}>;
}

interface RegistryServer {
	server: {
		$schema?: string;
		name: string;
		description?: string;
		title?: string;
		version?: string;
		repository?: {
			url: string;
			source?: string;
		};
		websiteUrl?: string;
		icons?: Array<{
			url: string;
			type?: string;
		}>;
		packages?: RegistryPackage[];
		remotes?: RegistryRemote[];
	};
	_meta?: {
		"io.modelcontextprotocol.registry/official"?: {
			status: string;
			publishedAt: string;
			updatedAt: string;
			isLatest: boolean;
		};
	};
}

interface RegistryResponse {
	servers: RegistryServer[];
	metadata: {
		nextCursor?: string;
		count: number;
	};
}

/**
 * Map registry transport type to our schema
 */
function mapTransport(registryServer: RegistryServer["server"]): MCPTransport {
	// Check remotes first (HTTP-based)
	if (registryServer.remotes && registryServer.remotes.length > 0) {
		const remote = registryServer.remotes[0];
		if (remote.type === "sse") {
			return "SSE";
		}
		return "HTTP";
	}

	// Check packages
	if (registryServer.packages && registryServer.packages.length > 0) {
		const pkg = registryServer.packages[0];
		if (pkg.transport?.type === "stdio") {
			return "STDIO";
		}
		if (pkg.transport?.type === "sse") {
			return "SSE";
		}
		if (pkg.transport?.type === "streamable-http") {
			return "HTTP";
		}
	}

	// Default to STDIO for npm/pypi packages
	return "STDIO";
}

/**
 * Determine auth methods from registry data
 */
function mapAuthMethods(
	registryServer: RegistryServer["server"],
): MCPAuthMethod[] {
	const authMethods: Set<MCPAuthMethod> = new Set();

	// Check remotes for auth headers
	if (registryServer.remotes) {
		for (const remote of registryServer.remotes) {
			if (remote.headers?.some((h) => h.isSecret || h.isRequired)) {
				authMethods.add("API_KEY");
			}
		}
	}

	// Check packages for environment variables
	if (registryServer.packages) {
		for (const pkg of registryServer.packages) {
			if (pkg.environmentVariables?.some((v) => v.isSecret)) {
				authMethods.add("API_KEY");
			}
		}
	}

	// Default to NONE if no auth found
	if (authMethods.size === 0) {
		authMethods.add("NONE");
	}

	return Array.from(authMethods);
}

/**
 * Get the remote URL if available
 */
function getDefaultUrl(
	registryServer: RegistryServer["server"],
): string | null {
	if (registryServer.remotes && registryServer.remotes.length > 0) {
		return registryServer.remotes[0].url;
	}
	return null;
}

/**
 * Get the command to run for STDIO servers
 */
function getCommand(registryServer: RegistryServer["server"]): string | null {
	if (registryServer.packages && registryServer.packages.length > 0) {
		const pkg = registryServer.packages[0];
		if (pkg.registryType === "npm") {
			return `npx -y ${pkg.identifier}`;
		}
		if (pkg.registryType === "pypi") {
			return `uvx ${pkg.identifier}`;
		}
		if (pkg.registryType === "oci") {
			return `docker run ${pkg.identifier}`;
		}
	}
	return null;
}

/**
 * Get icon URL
 */
function getIconUrl(registryServer: RegistryServer["server"]): string | null {
	if (registryServer.icons && registryServer.icons.length > 0) {
		return registryServer.icons[0].url;
	}
	return null;
}

/**
 * Generate a key from the server name
 */
function generateKey(name: string): string {
	// Convert "ai.exa/exa" to "exa" or "ai.com.mcp/contabo" to "contabo"
	const parts = name.split("/");
	const lastPart = parts[parts.length - 1];
	return lastPart.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

/**
 * Categorize server based on name and description
 */
function categorize(
	name: string,
	description?: string,
): { category: string; tags: string[] } {
	const nameLower = name.toLowerCase();
	const descLower = description?.toLowerCase() || "";
	const combined = `${nameLower} ${descLower}`;

	// Category mappings
	if (
		combined.includes("search") ||
		combined.includes("web") ||
		combined.includes("crawl")
	) {
		return {
			category: "Web & Internet",
			tags: ["search", "web", "crawling"],
		};
	}
	if (
		combined.includes("database") ||
		combined.includes("sql") ||
		combined.includes("postgres") ||
		combined.includes("mysql") ||
		combined.includes("mongo") ||
		combined.includes("cosmosdb") ||
		combined.includes("cosmos")
	) {
		return {
			category: "Data & Analytics",
			tags: ["database", "sql", "data"],
		};
	}
	if (
		combined.includes("git") ||
		combined.includes("github") ||
		combined.includes("gitlab")
	) {
		return {
			category: "Developer Tools",
			tags: ["git", "version-control", "code-repository"],
		};
	}
	if (
		combined.includes("file") ||
		combined.includes("storage") ||
		combined.includes("s3") ||
		combined.includes("drive")
	) {
		return {
			category: "Productivity",
			tags: ["files", "storage", "cloud"],
		};
	}
	if (
		combined.includes("slack") ||
		combined.includes("discord") ||
		combined.includes("email") ||
		combined.includes("mail") ||
		combined.includes("chat")
	) {
		return {
			category: "Communication",
			tags: ["messaging", "communication", "chat"],
		};
	}
	if (
		combined.includes("ai") ||
		combined.includes("llm") ||
		combined.includes("openai") ||
		combined.includes("anthropic")
	) {
		return { category: "AI & ML", tags: ["ai", "llm", "machine-learning"] };
	}
	if (
		combined.includes("cloud") ||
		combined.includes("aws") ||
		combined.includes("azure") ||
		combined.includes("gcp")
	) {
		return {
			category: "Cloud & Infrastructure",
			tags: ["cloud", "infrastructure", "devops"],
		};
	}
	if (
		combined.includes("salesforce") ||
		combined.includes("crm") ||
		combined.includes("hubspot")
	) {
		return {
			category: "CRM & Sales",
			tags: ["crm", "sales", "enterprise"],
		};
	}
	if (
		combined.includes("shopify") ||
		combined.includes("ecommerce") ||
		combined.includes("stripe")
	) {
		return {
			category: "E-commerce",
			tags: ["ecommerce", "payments", "store"],
		};
	}
	if (
		combined.includes("jira") ||
		combined.includes("linear") ||
		combined.includes("asana") ||
		combined.includes("project")
	) {
		return {
			category: "Project Management",
			tags: ["project-management", "issue-tracking", "tasks"],
		};
	}
	if (
		combined.includes("notion") ||
		combined.includes("confluence") ||
		combined.includes("docs")
	) {
		return {
			category: "Productivity",
			tags: ["docs", "wiki", "knowledge-base"],
		};
	}
	if (
		combined.includes("browser") ||
		combined.includes("playwright") ||
		combined.includes("puppeteer")
	) {
		return {
			category: "Browser Automation",
			tags: ["browser", "automation", "testing"],
		};
	}
	if (
		combined.includes("kubernetes") ||
		combined.includes("docker") ||
		combined.includes("container")
	) {
		return {
			category: "DevOps",
			tags: ["kubernetes", "docker", "containers"],
		};
	}

	// Default
	return { category: "Developer Tools", tags: ["mcp", "integration"] };
}

/**
 * Fetch all servers from the registry with pagination
 */
async function fetchAllServers(): Promise<RegistryServer[]> {
	const allServers: RegistryServer[] = [];
	let cursor: string | undefined;
	const limit = 100;
	let pageCount = 0;
	const maxPages = 20; // Safety limit to prevent infinite loops

	console.log("Fetching servers from official MCP Registry...");

	while (pageCount < maxPages) {
		const url = cursor
			? `https://registry.modelcontextprotocol.io/v0/servers?limit=${limit}&cursor=${cursor}`
			: `https://registry.modelcontextprotocol.io/v0/servers?limit=${limit}`;

		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Registry API error: ${response.status}`);
			}

			const data: RegistryResponse = await response.json();
			allServers.push(...data.servers);
			pageCount++;

			console.log(
				`  Fetched page ${pageCount}: ${data.servers.length} servers (total: ${allServers.length})`,
			);

			if (!data.metadata.nextCursor) {
				break;
			}
			cursor = data.metadata.nextCursor;
		} catch (error) {
			console.error(`Error fetching page ${pageCount + 1}:`, error);
			break;
		}
	}

	return allServers;
}

/**
 * Remove previously seeded non-official servers from the registry.
 * We identify them by checking whether the author is a known community
 * hosting platform (smithery) or whether the server name prefix is not
 * a reverse-domain identifier (e.g. "com.github", "io.github", etc.)
 * Only touches rows that are isSystemProvided=true and have no MCPConfig
 * referencing them (safe to delete).
 */
async function cleanupNonOfficialServers() {
	console.log("Cleaning up non-curated registry servers...");

	// Delete system-provided servers that are not part of Fabric's curated allowlist.
	// Only delete rows that are not referenced by user configs.
	const deleted = await db.mCPServer.deleteMany({
		where: {
			isSystemProvided: true,
			configs: { none: {} },
			key: {
				notIn: Array.from(CURATED_SYSTEM_MCP_SERVER_KEY_SET),
			},
		},
	});

	console.log(`  Removed ${deleted.count} non-curated registry servers\n`);
}

/**
 * Force-invalidate every cached MCP registry system-server list in Redis.
 *
 * Belt-and-braces: the `mcp_server_bump_registry_version` Postgres trigger
 * (migration 20260523000200) already rotates the cache key on every write,
 * so the API serves fresh data on the next request even without this call.
 * We still wipe the family explicitly on seed completion so operators see
 * the orphaned old-version keys disappear immediately instead of waiting
 * out their 1-hour TTL.
 *
 * Non-fatal — seed proceeds even if Redis is unavailable.
 */
async function invalidateRegistryCache() {
	const cacheHost = process.env.CACHE_HOST;
	const rawUrl = process.env.REDIS_URL;
	const url = cacheHost
		? (() => {
				const port = process.env.CACHE_PORT || "6379";
				const password =
					process.env.CACHE_PASSWORD || process.env.REDIS_PASSWORD;
				return password
					? `redis://:${encodeURIComponent(password)}@${cacheHost}:${port}`
					: `redis://${cacheHost}:${port}`;
			})()
		: rawUrl;

	if (!url) {
		console.log("No Redis URL configured — skipping cache invalidation");
		return;
	}

	try {
		// Dynamic require — ioredis is available in the monorepo workspace but not
		// declared as a direct dependency of this package. Using Function to avoid
		// the static import analysis that would cause a TS2307 type error.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ioredis: any = await new Function(
			"specifier",
			"return import(specifier)",
		)("ioredis");
		const client = new ioredis.default(url, {
			maxRetriesPerRequest: 1,
			// Without this, ioredis disables TCP keepalive and an idle
			// connection is reaped upstream, surfacing as ECONNRESET on the
			// next write instead of a clean reconnect.
			keepAlive: REDIS_KEEPALIVE_MS,
			connectTimeout: 2000,
			lazyConnect: true,
		});
		await client.connect();

		// SCAN+DEL the whole family. Older revisions of this seed wrote
		// `DEL "mcp:registry:system-servers"` directly, but the live cache key
		// includes a version suffix (`:v<N>`), so the DEL silently no-op'd —
		// this is why the cache appeared "stuck" after every seed.
		let cursor = "0";
		let deleted = 0;
		do {
			const [next, batch] = await client.scan(
				cursor,
				"MATCH",
				"mcp:registry:system-servers:*",
				"COUNT",
				100,
			);
			cursor = next;
			if (batch.length > 0) {
				deleted += await client.del(...batch);
			}
		} while (cursor !== "0");
		await client.quit();
		console.log(
			`Redis cache invalidated: ${deleted} mcp:registry:system-servers:* key(s)`,
		);
	} catch (e) {
		console.log(
			"Redis cache invalidation failed (non-fatal):",
			e instanceof Error ? e.message : String(e),
		);
	}
}

/**
 * Main seed function
 */
async function seedMcpRegistry() {
	console.log("\n=== Seeding MCP Servers from Official Registry ===\n");

	// First, remove previously imported non-official servers
	await cleanupNonOfficialServers();

	const registryServers = await fetchAllServers();
	console.log(`\nTotal servers fetched: ${registryServers.length}`);

	// Filter to only officially verified servers
	const officialServers = registryServers.filter(
		(entry) => entry._meta?.["io.modelcontextprotocol.registry/official"],
	);
	console.log(
		`Official servers (verified by MCP registry): ${officialServers.length}\n`,
	);

	let created = 0;
	let updated = 0;
	let skipped = 0;

	for (const entry of officialServers) {
		const server = entry.server;

		// Skip servers without proper name
		if (!server.name) {
			skipped++;
			continue;
		}

		const key = generateKey(server.name);

		if (!CURATED_SYSTEM_MCP_SERVER_KEY_SET.has(key)) {
			skipped++;
			continue;
		}

		const { category, tags } = categorize(server.name, server.description);

		// Check if it conflicts with our manually curated servers
		const existingManual = await db.mCPServer.findFirst({
			where: {
				key,
				isSystemProvided: true,
			},
		});

		// If we have a manually curated version, skip the registry version
		// but keep registry-specific metadata and sync isImplemented flag
		if (existingManual) {
			const isImplemented = IMPLEMENTED_MCP_SERVER_KEYS.has(key);
			const updateData: Record<string, unknown> = { isImplemented };
			if (!existingManual.repositoryUrl && server.repository?.url) {
				updateData.repositoryUrl = server.repository.url;
			}
			await db.mCPServer.update({
				where: { id: existingManual.id },
				data: updateData,
			});
			updated++;
			continue;
		}

		const transport = mapTransport(server);
		const authMethods = mapAuthMethods(server);
		const defaultUrl = getDefaultUrl(server);
		const command = getCommand(server);
		const iconUrl = getIconUrl(server);

		// Create or update the server
		const existingRegistry = await db.mCPServer.findFirst({
			where: {
				key,
				isSystemProvided: true,
			},
		});

		const serverData = {
			key,
			name: server.title || server.name.split("/").pop() || server.name,
			description: server.description || null,
			defaultUrl,
			command,
			docsUrl: server.websiteUrl || server.repository?.url || null,
			transport,
			authMethods,
			iconUrl,
			author: server.name.split("/")[0]?.replace(/^ai\./, "") || null,
			repositoryUrl: server.repository?.url || null,
			category,
			tags,
			isSystemProvided: true,
			isImplemented: IMPLEMENTED_MCP_SERVER_KEYS.has(key),
		};

		if (existingRegistry) {
			await db.mCPServer.update({
				where: { id: existingRegistry.id },
				data: serverData,
			});
			updated++;
		} else {
			await db.mCPServer.create({
				data: serverData,
			});
			created++;
		}
	}

	// Sync isImplemented flag for ALL system servers (including manually curated ones
	// that may not appear in the registry fetch, e.g. github-remote, slack-remote)
	await db.mCPServer.updateMany({
		where: {
			isSystemProvided: true,
			key: { in: [...IMPLEMENTED_MCP_SERVER_KEYS] },
		},
		data: { isImplemented: true },
	});
	await db.mCPServer.updateMany({
		where: {
			isSystemProvided: true,
			key: { notIn: [...IMPLEMENTED_MCP_SERVER_KEYS] },
		},
		data: { isImplemented: false },
	});

	console.log("\n=== Seed Summary ===");
	console.log(`Created: ${created}`);
	console.log(`Updated: ${updated}`);
	console.log(`Skipped: ${skipped}`);
	console.log(`Total processed: ${registryServers.length}\n`);

	// Invalidate the Redis cache so the API serves fresh data on next request
	await invalidateRegistryCache();
}

// Run the seed
seedMcpRegistry()
	.catch((error) => {
		console.error("Seed failed:", error);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
