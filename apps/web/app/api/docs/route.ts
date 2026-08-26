import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { router } from "@repo/api/orpc/router";
import { config } from "@repo/config";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";

const app = new Hono();
const openApiGenerator = new OpenAPIGenerator({
	schemaConverters: [new ZodToJsonSchemaConverter()],
});

// Get OpenAPI schema
const getOpenAPISchema = async () => {
	return await openApiGenerator.generate(router, {
		info: {
			title: `${config.appName} API Documentation`,
			version: "1.0.0",
			description:
				"Complete API documentation for the Fabric platform, including MCP (Model Context Protocol) integration.",
		},
		servers: [
			{
				url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001",
				description: "Application Server",
			},
		],
	});
};

// Scalar API Reference UI
app.get("/", Scalar({ theme: "purple", url: "/api/docs/openapi.json" }));

// OpenAPI JSON endpoint
app.get("/openapi.json", async (c) => {
	const schema = await getOpenAPISchema();
	return c.json(schema);
});

// Export for Next.js App Router
export const GET = app.fetch;
