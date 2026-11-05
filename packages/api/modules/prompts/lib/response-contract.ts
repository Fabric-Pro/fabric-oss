import { ORPCError } from "@orpc/server";
import type {
	PromptResponseContract,
	PromptResponseValidation,
} from "@repo/ai/lib/prompt-response-contract";
import { responseSchemaProblem } from "@repo/ai/lib/prompt-response-contract";
import Ajv from "ajv";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/** A deliberately bounded JSON Schema subset: no references, programs or regexes. */
export function prepareResponseContract(contract?: PromptResponseContract) {
	if (!contract || contract.format !== "JSON") {
		return undefined;
	}
	const schema = contract.schema;
	const bad = (message: string): never => {
		throw new ORPCError("BAD_REQUEST", { message });
	};
	if (!schema || schema.type !== "object") {
		return bad("The response schema must describe an object.");
	}
	if (Buffer.byteLength(JSON.stringify(schema)) > 32768) {
		bad("The response schema exceeds 32 KiB.");
	}
	const problem = responseSchemaProblem(schema);
	if (problem) {
		bad(problem);
	}
	try {
		// A fresh compiler avoids retaining arbitrary tenant schemas in a global cache.
		return new Ajv({
			strict: true,
			allErrors: false,
			validateFormats: false,
			coerceTypes: false,
			useDefaults: false,
			removeAdditional: false,
			ownProperties: true,
		}).compile(schema);
	} catch {
		bad(
			"The response schema is invalid. Check field types, required fields and bounds.",
		);
	}
}
export function validateResponse(
	output: string,
	contract?: PromptResponseContract,
	validate?: ReturnType<typeof prepareResponseContract>,
): PromptResponseValidation {
	if (!contract || ["AUTO", "TEXT", "MARKDOWN"].includes(contract.format)) {
		return { status: "not_requested", issues: [] };
	}
	if (contract.format === "XML") {
		if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(output)) {
			return {
				status: "failed",
				issues: [
					{
						path: "/",
						message:
							"Document types and entity declarations are not supported.",
					},
				],
			};
		}
		const result = XMLValidator.validate(output);
		if (result === true) {
			try {
				const parsed = new XMLParser({
					preserveOrder: true,
					processEntities: false,
					ignoreDeclaration: true,
					ignorePiTags: true,
				}).parse(output) as Array<Record<string, unknown>>;
				const roots = parsed.filter((node) =>
					Object.keys(node).some(
						(key) => !key.startsWith("#") && key !== ":@",
					),
				);
				if (roots.length !== 1) {
					return {
						status: "failed",
						issues: [
							{
								path: "/",
								message: "Return exactly one XML root element.",
							},
						],
					};
				}
			} catch {
				return {
					status: "failed",
					issues: [
						{
							path: "/",
							message:
								"The response is not a well-formed XML document.",
						},
					],
				};
			}
		}
		return result === true
			? { status: "passed", issues: [] }
			: {
					status: "failed",
					issues: [
						{
							path: "/",
							message:
								"The response is not a well-formed XML document.",
						},
					],
				};
	}
	let data: unknown;
	try {
		data = JSON.parse(output);
	} catch {
		return {
			status: "failed",
			issues: [
				{
					path: "/",
					message:
						"The response is not valid JSON. Return one JSON object without Markdown fences or extra text.",
				},
			],
		};
	}
	if (!validate || !validate(data)) {
		return {
			status: "failed",
			issues: (
				validate?.errors ?? [
					{
						instancePath: "/",
						message:
							"The response did not match the expected schema.",
					},
				]
			)
				.slice(0, 20)
				.map((error) => ({
					path: (error.instancePath || "/").slice(0, 500),
					message: (
						error.message || "The field did not match the schema."
					).slice(0, 500),
				})),
		};
	}
	return { status: "passed", issues: [] };
}
