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
export type QaPlaywrightScriptStep = QaPlaywrightScript["steps"][number];
export type QaPlaywrightScriptLocator = z.infer<typeof locatorSchema>;

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

/** Short enough that a readable step label never grows into a value dump. */
const MAX_DESCRIBED_VALUE_LENGTH = 80;

function truncateForLabel(value: string): string {
	return value.length > MAX_DESCRIBED_VALUE_LENGTH
		? `${value.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}…`
		: value;
}

/**
 * A readable name for a step's target — the same vocabulary a person reads in
 * the run's evidence, e.g. `button "Sign in"` or `label "Email"`.
 */
function describeQaLocator(locator: QaPlaywrightScriptLocator): string {
	switch (locator.by) {
		case "role":
			return locator.name
				? `${locator.role} "${locator.name}"`
				: locator.role;
		case "label":
			return `label "${locator.value}"`;
		case "text":
			return `text "${locator.value}"`;
		case "placeholder":
			return `placeholder "${locator.value}"`;
		case "testId":
			return `testId "${locator.value}"`;
		default: {
			const never: never = locator;
			return String(never);
		}
	}
}

/**
 * A human-readable label for one plan action, e.g. `Go to /docs/features` or
 * `Click button "Sign in"`. Used to name a scripted run's per-step evidence
 * row, since the plan itself never carries a title for a step.
 *
 * A `fill` value is never echoed — it is authored plan data rather than a
 * runtime secret, but a long value would swamp the row for no benefit an
 * operator can't already get by opening the saved script.
 */
export function describeQaScriptStep(step: QaPlaywrightScriptStep): string {
	switch (step.action) {
		case "goto":
			return `Go to ${step.path}`;
		case "click":
			return `Click ${describeQaLocator(step.locator)}`;
		case "fill":
			return `Fill ${describeQaLocator(step.locator)}`;
		case "press":
			return `Press "${step.key}" on ${describeQaLocator(step.locator)}`;
		case "selectOption":
			return `Select an option in ${describeQaLocator(step.locator)}`;
		case "check":
			return `Check ${describeQaLocator(step.locator)}`;
		case "uncheck":
			return `Uncheck ${describeQaLocator(step.locator)}`;
		case "assertVisible":
			return `Assert ${describeQaLocator(step.locator)} is visible`;
		case "assertText":
			return `Assert text "${truncateForLabel(step.value)}" in ${describeQaLocator(step.locator)}`;
		case "assertUrl":
			return `Assert URL is ${step.path}`;
		default: {
			const never: never = step;
			return String(never);
		}
	}
}

/**
 * What a step's row should show under "expected" — the assertion itself for
 * an assert step, since that IS the expectation; a plain completion sentence
 * for an action step, since an action has no assertion of its own.
 */
export function expectedForQaScriptStep(step: QaPlaywrightScriptStep): string {
	switch (step.action) {
		case "assertVisible":
			return `${describeQaLocator(step.locator)} is visible`;
		case "assertText":
			return `${describeQaLocator(step.locator)} contains "${truncateForLabel(step.value)}"`;
		case "assertUrl":
			return `The page URL is ${step.path}`;
		case "goto":
		case "click":
		case "fill":
		case "press":
		case "selectOption":
		case "check":
		case "uncheck":
			return "Completes without error";
		default: {
			const never: never = step;
			return String(never);
		}
	}
}
