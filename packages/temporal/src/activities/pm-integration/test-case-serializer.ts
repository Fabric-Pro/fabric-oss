/**
 * Test-case PM serializer (the cross-provider step contract).
 *
 * PURE module: it imports NOTHING at runtime except a structural capability
 * type. That is deliberate — both the deterministic `testCaseSyncWorkflow`
 * (which cannot import `@repo/database` / any non-deterministic code) AND the
 * `test-case-sync.ts` activity share these helpers, so the description + step
 * serialization has ONE source of truth instead of the workflow/activity
 * duplication the story sync grew (see `buildDescription` in
 * `story-sync-workflow.ts` vs `buildStoryDescription` in `story-sync.ts`).
 *
 * The contract:
 *  - `buildTestCaseDescription` is the GENERIC baseline that lands the ordered
 *    steps in the issue BODY for EVERY PM tool (existing + future) — no per-tool
 *    fork needed.
 *  - `formatTestCaseStepsForProvider` is the ONLY place provider branching
 *    lives: Azure DevOps additionally gets a native
 *    `Microsoft.VSTS.TCM.Steps` field; every other tool gets nothing extra
 *    (the steps are already in the description). A new tool plugs in here
 *    without touching the workflow.
 *  - `parseTestCaseStepsFromBody` is the inverse used on pull/import.
 *  - `buildTestCaseCreateArgs` / `buildTestCaseUpdateArgs` assemble the MCP tool
 *    args from discovered capabilities so the workflow's bulk and single-case
 *    (retry) pushes produce byte-identical payloads.
 */

import type { PMToolCapabilities } from "./tool-analyzer";

/** Minimal structural step shape the serializer needs (action + expected). */
export interface SerializableTestCaseStep {
	action: string;
	expected: string;
}

/** Minimal structural case shape — accepts `TestCaseForSync` and plain objects. */
export interface SerializableTestCase {
	description?: string | null;
	steps?: SerializableTestCaseStep[] | null;
}

/** ADO work-item field that stores native, structured test steps. */
export const ADO_STEPS_FIELD = "Microsoft.VSTS.TCM.Steps";

function hasContent(step: SerializableTestCaseStep): boolean {
	return (
		(step.action ?? "").trim() !== "" || (step.expected ?? "").trim() !== ""
	);
}

/**
 * Build the human-readable issue body for a test case.
 *
 * Mirrors `buildStoryDescription`: the case's preconditions (its `description`)
 * followed by an ordered, plain-text Steps section (`1. <action> — <expected>`).
 * This is the GENERIC baseline that satisfies "steps land in the body for every
 * tool" — it uses no markdown emphasis so it renders cleanly in plain-text,
 * markdown, and HTML-rendering PM tools alike. The title is NOT included (PM
 * tools carry it in a separate field).
 */
export function buildTestCaseDescription(
	testCase: SerializableTestCase,
): string {
	const parts: string[] = [];

	const preconditions = (testCase.description ?? "").trim();
	if (preconditions) {
		parts.push(preconditions);
	}

	const steps = (testCase.steps ?? []).filter(hasContent);
	if (steps.length > 0) {
		const lines = steps.map((step, index) => {
			const action = (step.action ?? "").trim();
			const expected = (step.expected ?? "").trim();
			return expected
				? `${index + 1}. ${action} — ${expected}`
				: `${index + 1}. ${action}`;
		});
		parts.push(["Steps:", ...lines].join("\n"));
	}

	return parts.join("\n\n");
}

function htmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Wrap a step field in ADO's `parameterizedString` HTML envelope and XML-escape
 * it. ADO renders the content as HTML, but it is stored inside the Steps XML —
 * so the `<DIV><P>…</P></DIV>` markup is XML-escaped (`&lt;DIV&gt;…`) and the
 * user's text is HTML-escaped first so special characters survive both layers.
 */
function wrapAdoParam(value: string | null | undefined): string {
	const text = (value ?? "").trim();
	return xmlEscape(`<DIV><P>${htmlEscape(text)}</P></DIV>`);
}

/**
 * Serialize ordered steps into the Azure DevOps `Microsoft.VSTS.TCM.Steps` XML
 * shape (`<steps><step type="ValidateStep">…</step>…</steps>`). ADO step ids
 * conventionally start at 2; `last` is the id of the final step. Returns `""`
 * when there are no usable steps so the caller can skip emitting the field.
 */
export function buildAdoStepsXml(steps: SerializableTestCaseStep[]): string {
	const usable = (steps ?? []).filter(hasContent);
	if (usable.length === 0) {
		return "";
	}
	const stepXml = usable
		.map((step, index) => {
			const id = index + 2;
			// ADO convention: a step with an expected result is a ValidateStep;
			// an action-only step is an ActionStep.
			const stepType = (step.expected ?? "").trim()
				? "ValidateStep"
				: "ActionStep";
			return (
				`<step id="${id}" type="${stepType}">` +
				`<parameterizedString isformatted="true">${wrapAdoParam(step.action)}</parameterizedString>` +
				`<parameterizedString isformatted="true">${wrapAdoParam(step.expected)}</parameterizedString>` +
				"<description/></step>"
			);
		})
		.join("");
	const last = usable.length + 1;
	return `<steps id="0" last="${last}">${stepXml}</steps>`;
}

/** A provider-specific extra field to push alongside title/description. */
export interface ProviderStepsField {
	fieldName: string;
	value: string;
}

/**
 * The ONLY provider branch for step serialization. Azure DevOps gets a
 * native `Microsoft.VSTS.TCM.Steps` field (structured, renders in the Steps
 * grid); every other tool gets `null` — its steps are already serialized into
 * the description by {@link buildTestCaseDescription}. The caller pushes the
 * returned field onto the ADO create `fieldsArray` / update JSON-Patch exactly
 * where the Bug `Microsoft.VSTS.TCM.ReproSteps` mirror is done for stories.
 */
export function formatTestCaseStepsForProvider(
	testCase: SerializableTestCase,
	toolKey: string | null | undefined,
): ProviderStepsField | null {
	if ((toolKey ?? "").toLowerCase() !== "azure-devops") {
		return null;
	}
	const xml = buildAdoStepsXml(testCase.steps ?? []);
	if (!xml) {
		return null;
	}
	return { fieldName: ADO_STEPS_FIELD, value: xml };
}

function xmlUnescape(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Strip the `<DIV><P>…</P></DIV>` wrappers ADO adds inside a parameterizedString. */
function stripInnerHtml(value: string): string {
	return value
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/(?:p|div)>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.trim();
}

function parseAdoStepsXml(xml: string): SerializableTestCaseStep[] {
	const steps: SerializableTestCaseStep[] = [];
	const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
	let stepMatch: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
	while ((stepMatch = stepRe.exec(xml)) !== null) {
		const inner = stepMatch[1];
		const paramRe =
			/<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
		const values: string[] = [];
		let paramMatch: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
		while ((paramMatch = paramRe.exec(inner)) !== null) {
			// ADO double-encodes: XML-unescape to recover the HTML, strip the
			// HTML wrappers, then XML-unescape the inner text once more so the
			// user's own <, >, & survive the round-trip.
			values.push(
				xmlUnescape(stripInnerHtml(xmlUnescape(paramMatch[1]))),
			);
		}
		const action = (values[0] ?? "").trim();
		const expected = (values[1] ?? "").trim();
		if (action || expected) {
			steps.push({ action, expected });
		}
	}
	return steps;
}

/**
 * Parse steps back out of a PM payload on pull/import (the inverse of the
 * serializer). Two best-effort strategies:
 *  1. Azure DevOps native `Microsoft.VSTS.TCM.Steps` XML, when a payload carries
 *     it inline.
 *  2. The numbered `N. <action> — <expected>` block that
 *     {@link buildTestCaseDescription} writes — this round-trips Fabric-authored
 *     cases for EVERY tool. Externally-authored bodies with no recognizable step
 *     block simply yield no steps (the body is kept as the case description).
 */
export function parseTestCaseStepsFromBody(
	body: string | null | undefined,
	_toolKey?: string | null,
): { steps: SerializableTestCaseStep[] } {
	const text = body ?? "";
	if (!text.trim()) {
		return { steps: [] };
	}

	if (/<steps[\s>]/i.test(text) && /<\/steps>/i.test(text)) {
		const xmlSteps = parseAdoStepsXml(text);
		if (xmlSteps.length > 0) {
			return { steps: xmlSteps };
		}
	}

	const steps: SerializableTestCaseStep[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		const numbered = line.match(/^\d+[.)]\s*(.+)$/);
		if (!numbered) {
			continue;
		}
		const rest = numbered[1];
		// Match exactly what we write: an em-dash separates action and expected.
		const emDash = rest.indexOf("—");
		const action = (emDash >= 0 ? rest.slice(0, emDash) : rest).trim();
		const expected = emDash >= 0 ? rest.slice(emDash + 1).trim() : "";
		if (action) {
			steps.push({ action, expected });
		}
	}
	return { steps };
}

// =============================================================================
// MCP create / update arg assembly (shared by the workflow + single-item retry)
// =============================================================================

/** ADO test cases are the "Test Case" work-item type. */
const ADO_TEST_CASE_WORK_ITEM_TYPE = "Test Case";

/**
 * Fizzy's create/update tools require an `account_slug` param. It lives on the
 * project's `additionalContext` (as `account_slug`, or legacy `slug`) — the same
 * value the pull path already resolves — but, unlike the ADO area/iteration
 * fields, it was never threaded into the FLAT create/update args, so a Fizzy push
 * failed with "Account slug is required" the moment the capability gate started
 * allowing non-ADO tools. Merge it in for Fizzy tools; a no-op for every other
 * provider (whose flat args carry no such param). When the slug is absent from
 * `additionalContext` the args are returned unchanged — the tool then surfaces
 * its own clear "account_slug is required" error, same as before.
 */
function applyFizzyAccountSlug(
	args: Record<string, unknown>,
	toolName: string | undefined,
	additionalContext: Record<string, string> | undefined,
): Record<string, unknown> {
	if (!toolName || !/fizzy/i.test(toolName)) {
		return args;
	}
	const slug = additionalContext?.account_slug ?? additionalContext?.slug;
	if (slug) {
		args.account_slug = slug;
	}
	return args;
}

/**
 * Assemble the MCP `create` args for a test case from the discovered
 * capabilities. Azure DevOps (`fieldsBased`) gets a `fields` array with
 * Title + Description (Markdown) + the native Steps field; flat tools get
 * `{ container, title, description }`. Keeping this here means the workflow's
 * bulk and single-case (retry) pushes build identical payloads.
 */
export function buildTestCaseCreateArgs(opts: {
	capabilities: PMToolCapabilities;
	containerValue: string;
	title: string;
	description: string;
	stepsField: ProviderStepsField | null;
	/** Project PM context (ADO area/iteration path, etc.). */
	additionalContext?: Record<string, string>;
}): Record<string, unknown> {
	const {
		capabilities,
		containerValue,
		title,
		description,
		stepsField,
		additionalContext,
	} = opts;
	const createTool = capabilities.taskCreation;
	if (!createTool) {
		throw new Error("PM tool does not support task creation");
	}

	if (createTool.fieldsBased) {
		const fieldsArray: Array<{
			name: string;
			value: string;
			format?: string;
		}> = [
			{ name: createTool.fieldsBased.titleKey, value: title },
			{
				name: createTool.fieldsBased.descriptionKey,
				value: description,
				format: "Markdown",
			},
		];
		// ADO native steps — pushed onto the create fields array exactly where the
		// Bug `Microsoft.VSTS.TCM.ReproSteps` mirror is done for stories.
		if (stepsField) {
			fieldsArray.push({
				name: stepsField.fieldName,
				value: stepsField.value,
			});
		}
		// Area/Iteration path (mirrors the story create): ADO wants backslashes
		// (TF401347); skip a URL value (a common misconfiguration).
		if (
			additionalContext?.areaPath &&
			!additionalContext.areaPath.trim().startsWith("http")
		) {
			fieldsArray.push({
				name: "System.AreaPath",
				value: additionalContext.areaPath.trim().replace(/\//g, "\\"),
			});
		}
		if (
			additionalContext?.iterationPath &&
			!additionalContext.iterationPath.trim().startsWith("http")
		) {
			fieldsArray.push({
				name: "System.IterationPath",
				value: additionalContext.iterationPath
					.trim()
					.replace(/\//g, "\\"),
			});
		}
		return {
			[createTool.containerParam]: containerValue,
			[createTool.fieldsBased.workItemTypeParam]:
				ADO_TEST_CASE_WORK_ITEM_TYPE,
			[createTool.fieldsBased.fieldsParam]: fieldsArray,
		};
	}

	const args: Record<string, unknown> = {
		[createTool.containerParam]: containerValue,
		[createTool.titleParam]: title,
	};
	if (createTool.descriptionParam) {
		args[createTool.descriptionParam] = description;
	}
	return applyFizzyAccountSlug(args, createTool.toolName, additionalContext);
}

/**
 * Assemble the MCP `update` args for a test case. Azure DevOps (`updatesBased`)
 * gets a JSON-Patch array (Title + Description + native Steps); flat tools get
 * `{ id, title?, description? }`.
 */
export function buildTestCaseUpdateArgs(opts: {
	capabilities: PMToolCapabilities;
	externalId: string;
	title: string;
	description: string;
	stepsField: ProviderStepsField | null;
	/** Project PM context (Fizzy `account_slug`, etc.). */
	additionalContext?: Record<string, string>;
}): Record<string, unknown> {
	const {
		capabilities,
		externalId,
		title,
		description,
		stepsField,
		additionalContext,
	} = opts;
	const updateTool = capabilities.taskUpdate;
	if (!updateTool) {
		throw new Error("PM tool does not support task update");
	}

	if (updateTool.updatesBased) {
		const updates: Array<{ op: string; path: string; value: string }> = [
			{ op: "add", path: "/fields/System.Title", value: title },
			{
				op: "add",
				path: "/fields/System.Description",
				value: description,
			},
		];
		// ADO native steps — mirrored onto the JSON-Patch exactly where the Bug
		// ReproSteps mirror lives, so an edited case's steps update on the form.
		if (stepsField) {
			updates.push({
				op: "add",
				path: `/fields/${stepsField.fieldName}`,
				value: stepsField.value,
			});
		}
		return {
			[updateTool.idParam]: externalId,
			[updateTool.updatesBased.updatesParam]: updates,
		};
	}

	const args: Record<string, unknown> = { [updateTool.idParam]: externalId };
	if (updateTool.titleParam) {
		args[updateTool.titleParam] = title;
	}
	if (updateTool.descriptionParam) {
		args[updateTool.descriptionParam] = description;
	}
	return applyFizzyAccountSlug(args, updateTool.toolName, additionalContext);
}

/**
 * Extract the created item's external id + URL from a parsed MCP create
 * response (mirrors the inline extraction in the story sync workflow).
 */
export function extractCreatedTestCaseRefs(parsed: unknown): {
	externalId: string;
	externalUrl: string;
} {
	const record = (
		parsed && typeof parsed === "object" ? parsed : {}
	) as Record<string, unknown>;
	// Prefer the DISPLAY identifier a tool fetches/updates by, ahead of an
	// internal row id. Some providers (Fizzy `card_number`, GitLab `iid`, Jira
	// `key`) list/store a human number that their get/update tools key off — the
	// same id `importFromPm` persists — while their create response ALSO carries a
	// separate internal `id`. Storing the internal id would break the later
	// update/pull. Azure DevOps has no `card_number`/`number`/`iid`/`key`, so it
	// still falls through to `id` (the numeric work-item id), unchanged.
	const externalId = String(
		record.card_number ||
			record.number ||
			record.iid ||
			record.key ||
			record.id ||
			record.card_id ||
			record.issue_id ||
			record.task_id ||
			record.work_item_id ||
			"",
	);
	const links = record._links as { web?: { href?: string } } | undefined;
	const externalUrl = String(
		links?.web?.href ||
			record.url ||
			record.link ||
			record.webUrl ||
			record.web_url ||
			"",
	);
	return { externalId, externalUrl };
}
