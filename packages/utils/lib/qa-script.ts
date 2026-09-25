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
 * Mask a same-origin path's query VALUES and any fragment, keeping the path
 * and the query's parameter NAMES.
 *
 * `goto` and `assertUrl` steps navigate to an author-supplied path, and an
 * OAuth/SSO callback routinely lands one right on `?code=…&state=…` — exactly
 * where a live token sits. This label is persisted and shown to every project
 * reader, so it follows the same rule a `fill` step's value already does
 * here (never echoed) and the rule the scripted runner's OWN `urlForAssertion`
 * applies to the runtime URL it reports back on a failed `assertUrl`
 * (`run-scripted-case.ts`): the AUTHORED label must never show more than the
 * runner ever echoes at runtime.
 *
 * `sameOriginPathSchema` already guarantees a leading `/`, but `URL` still
 * needs a base to resolve a relative path against — an inert one, since only
 * the path/query/fragment it parses out are ever used.
 */
function maskQueryAndFragment(path: string): string {
	try {
		const parsed = new URL(path, "https://example.invalid");
		const names = [...parsed.searchParams.keys()];
		const query = names.length
			? `?${names.map((name) => `${name}=…`).join("&")}`
			: "";
		return `${parsed.pathname}${query}${parsed.hash ? "#…" : ""}`;
	} catch {
		// Unreachable for a schema-validated path, but a masking helper must
		// fail closed rather than echo an unparseable value verbatim — cut at
		// the first `?` or `#` instead of showing whatever followed it.
		const cut = path.search(/[?#]/);
		return cut === -1 ? path : path.slice(0, cut);
	}
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
			return `Go to ${maskQueryAndFragment(step.path)}`;
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
			return `Assert URL is ${maskQueryAndFragment(step.path)}`;
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
			return `The page URL is ${maskQueryAndFragment(step.path)}`;
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
