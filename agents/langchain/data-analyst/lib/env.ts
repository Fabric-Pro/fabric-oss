import { z } from "zod/v4";

const envSchema = z.object({
	// Fabric API (required for MCP tools via Fabric tool router)
	FABRIC_API_URL: z.string().url().default("http://localhost:3001"),
	AGENT_API_KEY: z.string().min(1),

	// Environment
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	console.error(
		"Invalid environment variables:",
		JSON.stringify(parsed.error.format(), null, 2),
	);
	throw new Error(
		"Invalid environment variables. Check the console for details.",
	);
}

export const env = parsed.data;
