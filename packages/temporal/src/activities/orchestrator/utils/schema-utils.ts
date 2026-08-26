/**
 * Schema Utilities
 *
 * Utilities for converting between JSON Schema and Zod schemas.
 * Used to create AI SDK compatible tool definitions from JSON Schema definitions.
 */

import { z } from "zod";

/**
 * Convert a single JSON Schema type to a Zod type.
 * Handles primitive types, arrays, objects, enums, and nullable types.
 */
function jsonSchemaTypeToZod(propSchema: Record<string, unknown>): z.ZodType {
	const propType = propSchema.type as string | string[] | undefined;
	const enumValues = propSchema.enum as unknown[] | undefined;

	// Handle enum values first (can appear with or without type)
	if (enumValues && enumValues.length > 0) {
		if (enumValues.every((v) => typeof v === "string")) {
			return z.enum(enumValues as [string, ...string[]]);
		}
		if (enumValues.every((v) => typeof v === "number")) {
			const desc = `One of: ${enumValues.join(", ")}`;
			return z.number().describe(desc);
		}
		// Mixed types - fall through to type-based handling with description
	}

	// Handle nullable types: type: ["string", "null"]
	if (Array.isArray(propType)) {
		const nonNullTypes = propType.filter((t) => t !== "null");
		const isNullable = propType.includes("null");
		if (nonNullTypes.length === 1) {
			const inner = jsonSchemaTypeToZod({
				...propSchema,
				type: nonNullTypes[0],
			});
			return isNullable ? inner.nullable() : inner;
		}
		// Multiple non-null types - use unknown
		return isNullable ? z.unknown().nullable() : z.unknown();
	}

	switch (propType) {
		case "string":
			return z.string();
		case "number":
		case "integer":
			return z.number();
		case "boolean":
			return z.boolean();
		case "null":
			return z.null();
		case "array":
			return convertArraySchema(propSchema);
		case "object":
			return convertObjectSchema(propSchema);
		default:
			return z.unknown();
	}
}

/**
 * Convert a JSON Schema array type to a Zod array type.
 * Recursively handles nested item schemas.
 */
function convertArraySchema(propSchema: Record<string, unknown>): z.ZodType {
	const itemSchema = propSchema.items as Record<string, unknown> | undefined;
	if (!itemSchema) {
		return z.array(z.unknown());
	}
	return z.array(jsonSchemaTypeToZod(itemSchema));
}

/**
 * Convert a JSON Schema object type to a Zod object type.
 * Recursively handles nested property schemas.
 */
function convertObjectSchema(propSchema: Record<string, unknown>): z.ZodType {
	const properties = propSchema.properties as
		| Record<string, Record<string, unknown>>
		| undefined;

	if (!properties || Object.keys(properties).length === 0) {
		// No properties defined - accept any object
		return z.object({}).passthrough();
	}

	const required = propSchema.required as string[] | undefined;
	const zodProps: Record<string, z.ZodType> = {};

	for (const [name, nestedSchema] of Object.entries(properties)) {
		let zodType = jsonSchemaTypeToZod(nestedSchema);
		const description = nestedSchema.description as string | undefined;

		if (description) {
			zodType = zodType.describe(description);
		}

		if (!required?.includes(name)) {
			zodType = zodType.optional();
		}

		zodProps[name] = zodType;
	}

	return z.object(zodProps);
}

/**
 * Convert a JSON Schema to a Zod schema.
 * Handles common property types found in MCP tool schemas.
 *
 * This is the main entry point - it expects a top-level object schema
 * (optionally wrapped in a `jsonSchema` property by the MCP protocol).
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
	// Unwrap the jsonSchema wrapper if present (MCP protocol wraps schemas)
	const unwrapped =
		schema.jsonSchema && typeof schema.jsonSchema === "object"
			? (schema.jsonSchema as Record<string, unknown>)
			: schema;

	return convertObjectSchema(unwrapped);
}
