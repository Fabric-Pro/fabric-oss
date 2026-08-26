import { listSystemMcpServers } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

const mcpServerSchema = z.object({
	id: z.string(),
	key: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	heroEmojis: z.array(z.string()).default([]),
	heroImageUrl: z.string().nullable().optional(),
	defaultUrl: z.string().nullable(),
	command: z.string().nullable().optional(),
	docsUrl: z.string().nullable(),
	transport: z.enum(["SSE", "HTTP", "STDIO"]),
	authMethods: z.array(z.enum(["NONE", "API_KEY", "OAUTH2"])),
	isSystemProvided: z.boolean(),
	iconUrl: z.string().nullable().optional(),
	author: z.string().nullable().optional(),
	repositoryUrl: z.string().nullable().optional(),
	category: z.string().nullable().optional(),
	tags: z.array(z.string()).default([]),
});

/**
 * Public MCP Registry Procedures
 * These endpoints don't require authentication and return only system-provided MCP servers
 */
export const publicRegistryProcedures = {
	/**
	 * List all system-provided MCP servers
	 * Public endpoint - no authentication required
	 */
	list: publicProcedure
		.use(requirePermission(Permissions.MCP_READ))
		.route({
			method: "GET",
			path: "/mcp/public-registry",
			tags: ["MCP"],
			summary: "List public MCP servers",
			description:
				"List all system-provided MCP servers in the public registry. No authentication required.",
		})
		.output(z.array(mcpServerSchema))
		.handler(async () => {
			const servers = await listSystemMcpServers();
			return servers.map((server) => ({
				id: server.id,
				key: server.key,
				name: server.name,
				description: server.description,
				heroEmojis: server.heroEmojis ?? [],
				heroImageUrl: server.heroImageUrl ?? null,
				defaultUrl: server.defaultUrl,
				command: server.command ?? null,
				docsUrl: server.docsUrl,
				transport: server.transport,
				authMethods: server.authMethods,
				isSystemProvided: server.isSystemProvided,
				iconUrl: server.iconUrl ?? null,
				author: server.author ?? null,
				repositoryUrl: server.repositoryUrl ?? null,
				category: server.category ?? null,
				tags: server.tags ?? [],
			}));
		}),
};
