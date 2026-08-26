import { z } from "zod";

const locatorSchema = z.discriminatedUnion("by", [
	z.object({
		by: z.literal("role"),
		role: z.string().trim().min(1).max(50),
		name: z.string().trim().min(1).max(500),
		exact: z.boolean().optional(),
	}),
	z.object({
		by: z.literal("label"),
		value: z.string().trim().min(1).max(500),
		exact: z.boolean().optional(),
	}),
	z.object({
		by: z.literal("text"),
		value: z.string().trim().min(1).max(500),
		exact: z.boolean().optional(),
	}),
	z.object({
		by: z.literal("placeholder"),
		value: z.string().trim().min(1).max(500),
		exact: z.boolean().optional(),
	}),
	z.object({
		by: z.literal("testId"),
		value: z.string().trim().min(1).max(500),
	}),
]);

const locatedStepFields = {
	locator: locatorSchema,
	timeoutMs: z.number().int().min(100).max(30_000).optional(),
};
const sameOriginPathSchema = z
	.string()
	.trim()
	.min(1)
	.max(2_000)
	.regex(/^\/(?!\/)/, "Navigation paths must be same-origin relative paths.");

const qaScriptStepSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("goto"),
		path: sameOriginPathSchema,
	}),
	z.object({ action: z.literal("click"), ...locatedStepFields }),
	z.object({
		action: z.literal("fill"),
		...locatedStepFields,
		value: z.string().max(10_000),
	}),
	z.object({
		action: z.literal("press"),
		...locatedStepFields,
		key: z.string().trim().min(1).max(50),
	}),
	z.object({
		action: z.literal("selectOption"),
		...locatedStepFields,
		value: z.string().max(1_000),
	}),
	z.object({ action: z.literal("check"), ...locatedStepFields }),
	z.object({ action: z.literal("uncheck"), ...locatedStepFields }),
	z.object({ action: z.literal("assertVisible"), ...locatedStepFields }),
	z.object({
		action: z.literal("assertText"),
		...locatedStepFields,
		value: z.string().max(10_000),
	}),
	z.object({
		action: z.literal("assertUrl"),
		path: sameOriginPathSchema,
	}),
]);

export const qaPlaywrightScriptSchema = z.object({
	version: z.literal(1),
	steps: z.array(qaScriptStepSchema).min(1).max(100),
});

export type QaPlaywrightScript = z.infer<typeof qaPlaywrightScriptSchema>;

export function parseQaPlaywrightScript(value: string): QaPlaywrightScript {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("The scripted test must be valid JSON.");
	}
	return qaPlaywrightScriptSchema.parse(parsed);
}

export function normalizeQaPlaywrightScript(value: string): string {
	return JSON.stringify(parseQaPlaywrightScript(value), null, 2);
}
