import { z } from "zod";

const schemaKeywords = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"title",
	"description",
]);
const schemaTypes = new Set([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
/** Shared browser/server policy; runtime output validation stays on the server. */
export function responseSchemaProblem(
	schema: Record<string, unknown>,
): string | undefined {
	if (schema.type !== "object") {
		return "The response schema must describe an object.";
	}
	const stack: Array<{ value: unknown; depth: number }> = [
		{ value: schema, depth: 0 },
	];
	let nodes = 0;
	while (stack.length) {
		const next = stack.pop();
		if (!next) {
			break;
		}
		const { value, depth } = next;
		if (++nodes > 100 || depth > 8) {
			return "Use at most 100 schema nodes and 8 levels.";
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return "Every schema node must be an object.";
		}
		const node = value as Record<string, unknown>;
		for (const key of Object.keys(node)) {
			if (!schemaKeywords.has(key)) {
				return `Unsupported response schema keyword: ${key.slice(0, 100)}.`;
			}
		}
		if (
			node.type !== undefined &&
			(typeof node.type !== "string" || !schemaTypes.has(node.type))
		) {
			return "Choose a supported field type.";
		}
		for (const key of ["title", "description"]) {
			if (node[key] !== undefined && typeof node[key] !== "string") {
				return "Schema titles and descriptions must be text.";
			}
		}
		const supports = (types: string[]) =>
			node.type === undefined || types.includes(String(node.type));
		if (node.properties !== undefined) {
			if (
				!supports(["object"]) ||
				!node.properties ||
				typeof node.properties !== "object" ||
				Array.isArray(node.properties) ||
				Object.keys(node.properties).length > 50
			) {
				return "Use at most 50 fields in each object schema.";
			}
			for (const child of Object.values(node.properties)) {
				stack.push({ value: child, depth: depth + 1 });
			}
		}
		if (
			node.required !== undefined &&
			(!supports(["object"]) ||
				!Array.isArray(node.required) ||
				node.required.some((x) => typeof x !== "string") ||
				new Set(node.required).size !== node.required.length)
		) {
			return "Required fields must be a list of unique field names.";
		}
		if (node.additionalProperties !== undefined) {
			if (!supports(["object"])) {
				return "Additional fields apply only to objects.";
			}
			if (typeof node.additionalProperties !== "boolean") {
				stack.push({
					value: node.additionalProperties,
					depth: depth + 1,
				});
			}
		}
		if (node.items !== undefined) {
			if (!supports(["array"])) {
				return "Items apply only to arrays.";
			}
			stack.push({ value: node.items, depth: depth + 1 });
		}
		if (node.type === "array" && node.items === undefined) {
			return "Array fields need an items schema.";
		}
		for (const key of [
			"minimum",
			"maximum",
			"minLength",
			"maxLength",
			"minItems",
			"maxItems",
		]) {
			if (node[key] === undefined) {
				continue;
			}
			const numeric = key === "minimum" || key === "maximum";
			if (
				!supports(
					numeric
						? ["number", "integer"]
						: key.endsWith("Length")
							? ["string"]
							: ["array"],
				) ||
				typeof node[key] !== "number" ||
				!Number.isFinite(node[key]) ||
				(!numeric &&
					(!Number.isInteger(node[key]) || (node[key] as number) < 0))
			) {
				return "Use valid bounds for the field type.";
			}
		}
		if (
			node.enum !== undefined &&
			(!Array.isArray(node.enum) ||
				!node.enum.length ||
				node.enum.length > 50 ||
				node.enum.some((x) => x !== null && typeof x === "object") ||
				new Set(node.enum.map((x) => JSON.stringify(x))).size !==
					node.enum.length)
		) {
			return "Enums support at most 50 unique primitive values.";
		}
	}
	return undefined;
}

const responseSchema = z
	.record(z.string(), z.unknown())
	.superRefine((schema, context) => {
		const pending: Array<{ value: unknown; depth: number }> = [
			{ value: schema, depth: 0 },
		];
		let nodes = 0;
		while (pending.length) {
			const next = pending.pop();
			if (!next) {
				break;
			}
			if (++nodes > 1000 || next.depth > 16) {
				context.addIssue({
					code: "custom",
					message: "The response schema is too complex.",
				});
				return;
			}
			if (next.value && typeof next.value === "object") {
				for (const value of Object.values(next.value)) {
					pending.push({ value, depth: next.depth + 1 });
				}
			}
		}
		if (new TextEncoder().encode(JSON.stringify(schema)).length > 32768) {
			context.addIssue({
				code: "custom",
				message: "The response schema exceeds 32 KiB.",
			});
		}
		const problem = responseSchemaProblem(schema);
		if (problem) {
			context.addIssue({ code: "custom", message: problem });
		}
	})
	.pipe(z.record(z.string(), z.json()));

/** Versioned expectations, separate from the prompt's input template engine. */
export const promptResponseContract = z
	.strictObject({
		format: z.enum(["AUTO", "TEXT", "MARKDOWN", "JSON", "XML"]),
		schema: responseSchema.optional(),
	})
	.superRefine((contract, context) => {
		if (contract.format === "JSON" && !contract.schema) {
			context.addIssue({
				code: "custom",
				path: ["schema"],
				message: "JSON responses need an expected object schema.",
			});
		}
		if (contract.format !== "JSON" && contract.schema !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["schema"],
				message: "Schemas apply only to JSON responses.",
			});
		}
	});
export type PromptResponseContract = z.infer<typeof promptResponseContract>;
export const DEFAULT_PROMPT_RESPONSE: PromptResponseContract = {
	format: "AUTO",
};
export const promptResponseValidation = z.object({
	status: z.enum(["not_requested", "passed", "failed"]),
	issues: z
		.array(
			z.object({
				path: z.string().max(500),
				message: z.string().max(500),
			}),
		)
		.max(20),
});
export type PromptResponseValidation = z.infer<typeof promptResponseValidation>;
