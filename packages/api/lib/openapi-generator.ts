import { unlazyRouter } from "@orpc/server";
import { router } from "../orpc/router";

type GenerateOptions = Parameters<
	InstanceType<typeof import("@orpc/openapi").OpenAPIGenerator>["generate"]
>[1];

/**
 * Generates the OpenAPI document for the oRPC router. The generator and the
 * zod converter are imported on demand so the docs endpoints do not weigh on
 * the cold start of every other request.
 */
export async function generateRouterOpenApiSchema(options: GenerateOptions) {
	const [{ OpenAPIGenerator }, { ZodToJsonSchemaConverter }, resolvedRouter] =
		await Promise.all([
			import("@orpc/openapi"),
			import("@orpc/zod/zod4"),
			unlazyRouter(router),
		]);

	return new OpenAPIGenerator({
		schemaConverters: [new ZodToJsonSchemaConverter()],
	}).generate(resolvedRouter, options);
}
