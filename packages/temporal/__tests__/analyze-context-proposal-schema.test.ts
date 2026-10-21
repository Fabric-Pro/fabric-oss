/**
 * `ChangeProposalSchema` is the analyzer's GENERATION schema — the shape
 * `generateObject` forces the model into. A field that is required here is a
 * field the whole run dies on.
 *
 * Found on staging 18 Aug 2026 (Fizzy #2170 acceptance run): 3 of 9 live AI
 * Update executions died with
 *
 *   ZodError: expected "string", code "invalid_type",
 *             path ["changes", 0, "reasoning"]
 *
 * `reasoning` and `sourceContext` are narrative annotations. Every consumer
 * already guards them — `change.reasoning ? … : ""` in `structurePreserveUpdates`
 * and `applyBacklogChanges`, and `routing.reasoning` is already
 * `.nullable().optional()`. Only the generation schema treated them as
 * load-bearing, so one omitted sentence discarded every other valid change in
 * the same response.
 *
 * These tests pin the asymmetry shut: the schema must accept a change that
 * carries no annotation, and must still reject a change missing something the
 * apply path genuinely cannot work without.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/analyze-context-proposal-schema.test.ts
 */

import {
	countAnthropicSchemaParameters,
	createAnthropicStructuredOutputLimitsMiddleware,
} from "@repo/ai/lib/prompt-steered-structured-output-middleware";
import { logger } from "@repo/logs";
import { asSchema, zodSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	annotateProposalResolutions,
	backlogChangeItemSchema,
	ChangeProposalSchema,
	createChangeProposalSchema,
	fillMissingUpdateTitles,
} from "../src/activities/backlog-context/analyze-context";

import changeProposalJsonSchema from "./fixtures/change-proposal-json-schema.json";

/** Drop keys without binding an unused name for each one. */
function omit(source: Record<string, unknown>, ...keys: string[]) {
	const copy = { ...source };
	for (const key of keys) {
		delete copy[key];
	}
	return copy;
}

/** A change carrying only what the apply path actually requires. */
function minimalChange(overrides: Record<string, unknown> = {}) {
	return {
		type: "feature",
		action: "create",
		title: "Add a retry to the ingest worker",
		reasoning: "The meeting called out repeated ingest timeouts.",
		sourceContext: "meeting_transcript",
		...overrides,
	};
}

type TitleCase = {
	name: string;
	input: Record<string, unknown>;
	changed?: { from?: string | null; to: string };
	fallback?: { from: string; to: string };
	invalid?: boolean;
	noReference?: boolean;
	snapshotHasOld?: boolean;
};

describe("ChangeProposalSchema", () => {
	it.each<TitleCase>([
		{ name: "missing", input: {}, changed: undefined, fallback: undefined },
		{
			name: "undefined",
			input: { title: undefined },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: "null",
			input: { title: null },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '""',
			input: { title: "" },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '"  "',
			input: { title: "  " },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '"New"',
			input: { title: "New" },
			changed: { to: "New" },
			fallback: undefined,
		},
		{
			name: "{}",
			input: { title: {} },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: "{to:null}",
			input: { title: { to: null } },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '{to:""}',
			input: { title: { to: "" } },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '{to:"  "}',
			input: { title: { to: "  " } },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '{to:"New"}',
			input: { title: { to: "New" } },
			changed: { to: "New" },
			fallback: undefined,
		},
		{
			name: '{from:"Old"}',
			input: { title: { from: "Old" } },
			changed: undefined,
			fallback: { from: "Old", to: "Old" },
		},
		{
			name: '{from:"Old",to:null}',
			input: { title: { from: "Old", to: null } },
			changed: undefined,
			fallback: { from: "Old", to: "Old" },
		},
		{
			name: '{from:"Old",to:""}',
			input: { title: { from: "Old", to: "" } },
			changed: undefined,
			fallback: { from: "Old", to: "Old" },
		},
		{
			name: '{from:"Old",to:"  "}',
			input: { title: { from: "Old", to: "  " } },
			changed: undefined,
			fallback: { from: "Old", to: "Old" },
		},
		{
			name: '{from:"",to:null}',
			input: { title: { from: "", to: null } },
			changed: undefined,
			fallback: undefined,
		},
		{
			name: '{from:"Old",to:"New"}',
			input: { title: { from: "Old", to: "New" } },
			changed: { from: "Old", to: "New" },
			fallback: undefined,
		},
		{ name: "42", input: { title: 42 }, invalid: true },
		{ name: "true", input: { title: true }, invalid: true },
		{ name: "[]", input: { title: [] }, invalid: true },
		{ name: "{to:42}", input: { title: { to: 42 } }, invalid: true },
		{
			name: '{from:null,to:"New"}',
			input: { title: { from: null, to: "New" } },
			changed: { from: null, to: "New" },
			fallback: undefined,
		},
		{
			name: '{from:42,to:"New"}',
			input: { title: { from: 42, to: "New" } },
			invalid: true,
		},
		{
			name: '{from:"Old",to:42}',
			input: { title: { from: "Old", to: 42 } },
			invalid: true,
		},
		{
			name: '{from:"  ",to:null}',
			input: { title: { from: "  ", to: null } },
			changed: undefined,
			fallback: undefined,
		},
		...[true, false].flatMap((snapshotHasOld) => [
			{
				name: `title-only missing to, match=${snapshotHasOld}`,
				input: { title: { from: "Old" } },
				changed: undefined,
				fallback: { from: "Old", to: "Old" },
				noReference: true,
				snapshotHasOld,
			},
			{
				name: `title-only blank to, match=${snapshotHasOld}`,
				input: { title: { from: "Old", to: "" } },
				changed: undefined,
				fallback: { from: "Old", to: "Old" },
				noReference: true,
				snapshotHasOld,
			},
			{
				name: `title-only null to, match=${snapshotHasOld}`,
				input: { title: { from: "Old", to: null } },
				changed: undefined,
				fallback: { from: "Old", to: "Old" },
				noReference: true,
				snapshotHasOld,
			},
		]),
	])("classifies title $name across validators and actions", (row) => {
		for (const action of ["create", "update"] as const) {
			const change = {
				...omit(minimalChange(), "title"),
				action,
				...(row.noReference ? {} : { existingIdentifier: "F-12" }),
				...row.input,
			};
			const input = { changes: [change] };
			const onDiscarded = vi.fn();
			const schema = createChangeProposalSchema({ onDiscarded });
			const parsed = schema["~standard"].validate(input);
			expect(parsed).toHaveProperty("value");
			if (!("value" in parsed)) {
				throw new Error("Expected element-wise salvage");
			}
			const deferred =
				action === "update" && !row.invalid && !row.changed;
			const expectedTitle =
				row.changed ?? (action === "create" ? row.fallback : undefined);
			const kept = deferred || expectedTitle !== undefined;
			const label = `${row.name} ${action}`;
			expect
				.soft(parsed.value.changes.length, `${label} activity kept`)
				.toBe(kept ? 1 : 0);
			expect
				.soft(
					parsed.value.changes.some(
						(item) => item.title === undefined,
					),
					`${label} deferred`,
				)
				.toBe(deferred);
			const stories = [
				{
					id: "example-story",
					identifier: "F-12",
					title: row.snapshotHasOld ? "Old" : "Snapshot title",
				},
			];
			const filled = fillMissingUpdateTitles(
				parsed.value,
				stories,
				onDiscarded.mock.calls[0][0],
			);
			expect
				.soft(
					filled.changes.map((item) => item.title),
					`${label} final title`,
				)
				.toEqual(
					deferred
						? row.noReference
							? [{ from: "Old", to: "Old" }]
							: [{ from: "Snapshot title", to: "Snapshot title" }]
						: expectedTitle
							? [expectedTitle]
							: [],
				);
			if (row.noReference && action === "update") {
				const annotated = annotateProposalResolutions(
					filled.changes,
					stories,
				);
				expect
					.soft(annotated[0]?.action, `${label} annotated action`)
					.toBe(row.snapshotHasOld ? "update" : "create");
				expect
					.soft(annotated[0]?.targetResolution, `${label} resolution`)
					.toMatchObject(
						row.snapshotHasOld
							? { status: "resolved", resolvedBy: "title" }
							: { status: "unresolved", demotedFromUpdate: true },
					);
				expect
					.soft(annotated[0]?.title, `${label} annotated title`)
					.toEqual({ from: "Old", to: "Old" });
			}
			const shared = ChangeProposalSchema.parse(input);
			expect
				.soft(
					shared.changes.map((item) => item.title),
					`${label} shared kept and final title`,
				)
				.toEqual(row.changed ? [row.changed] : []);
			expect
				.soft(
					shared.changes.some((item) => item.title === undefined),
					`${label} shared deferred`,
				)
				.toBe(false);
		}
	});

	it.each(
		["description", "acceptanceCriteria", "priority", "size"].flatMap(
			(field) =>
				[
					null,
					{ from: "Existing", to: null },
					{ from: "Existing" },
				].map((value) => ({ field, value })),
		),
	)(
		"omits unchanged $field diff $value while keeping the update",
		({ field, value }) => {
			const parsed = ChangeProposalSchema.parse({
				changes: [minimalChange({ action: "update", [field]: value })],
			});
			expect(parsed.changes).toHaveLength(1);
			expect(parsed.changes[0]).not.toHaveProperty(field);
		},
	);

	it("preserves string coercion, ordinary diffs and a complete create", () => {
		const create = minimalChange({
			title: { to: "New" },
			description: { to: "Body" },
			acceptanceCriteria: { to: "Criteria" },
			priority: { to: "P2_MEDIUM" },
			size: { to: "M" },
		});
		const update = minimalChange({
			action: "update",
			title: { from: "Old", to: "New" },
			description: "Body",
		});
		const parsed = ChangeProposalSchema.parse({
			summary: "Summary",
			changes: [create, update],
		});
		expect(parsed.changes[0]).toEqual(create);
		expect(parsed.changes[1]).toEqual({
			...update,
			description: { to: "Body" },
		});
		expect(parsed.summary).toBe("Summary");
	});

	it.each([{ priority: [] }, { priority: { from: "Existing", to: 42 } }])(
		"still discards malformed optional diffs $priority",
		({ priority }) => {
			const parsed = ChangeProposalSchema.parse({
				changes: [minimalChange({ action: "update", priority })],
			});
			expect(parsed.changes).toEqual([]);
		},
	);

	it("logs bounded discard diagnostics without customer text or invalid enum values", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const secret = "DISTINCTIVE_CUSTOMER_CONTENT";
			ChangeProposalSchema.parse({
				changes: [
					minimalChange(),
					...Array.from({ length: 12 }, () =>
						minimalChange({
							action: "update",
							title: { to: null },
							reasoning: secret,
						}),
					),
					minimalChange({ action: secret, type: secret }),
				],
			});
			expect(warn).toHaveBeenCalledOnce();
			const payload = warn.mock.calls[0]?.[1];
			expect(payload).toMatchObject({
				discarded: 13,
				kept: 1,
				details: [
					{
						index: 1,
						action: "update",
						type: "feature",
						issues: "title.to:invalid_type:null",
					},
					...Array.from({ length: 9 }, (_, i) =>
						expect.objectContaining({ index: i + 2 }),
					),
				],
			});
			expect(JSON.stringify(payload)).not.toContain(secret);
			warn.mockClear();
			ChangeProposalSchema.parse({
				changes: [
					minimalChange({
						title: null,
						description: 42,
						acceptanceCriteria: 42,
						priority: 42,
						size: 42,
						labels: 42,
						sourceRef: 42,
					}),
				],
			});
			expect(warn.mock.calls[0]?.[1]).toMatchObject({
				details: [{ issues: expect.any(String) }],
			});
			const capped = warn.mock.calls[0]?.[1] as {
				details: { issues: string }[];
			};
			expect(capped.details[0]?.issues.split(", ")).toHaveLength(5);
			warn.mockClear();
			ChangeProposalSchema.parse({
				changes: [minimalChange({ action: secret, type: secret })],
			});
			expect(warn.mock.calls[0]?.[1]).toMatchObject({
				details: [
					{
						index: 0,
						action: null,
						type: null,
						issues: expect.any(String),
					},
				],
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("logs recovery counts once per response without values", () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		try {
			const schema = createChangeProposalSchema({
				onDiscarded: () => {},
			});
			schema["~standard"].validate({
				changes: [
					minimalChange({
						action: "update",
						title: { from: "Old", to: null },
						priority: null,
						size: { from: "M" },
					}),
					minimalChange({
						action: "update",
						priority: { from: "P2_MEDIUM", to: null },
					}),
					minimalChange({
						action: "update",
						title: { from: "Old", to: null },
						priority: 42,
					}),
				],
			});
			expect(info).toHaveBeenCalledExactlyOnceWith(
				"[Backlog Analysis] Normalized unchanged diff fields from the model response",
				{ title: 1, priority: 2, size: 1 },
			);
			info.mockClear();
			schema["~standard"].validate({ changes: [minimalChange()] });
			expect(info).not.toHaveBeenCalled();
		} finally {
			info.mockRestore();
		}
	});

	it("leaves summaries unchanged when reusing the shared schema", () => {
		const discarded = ChangeProposalSchema.parse({
			summary: "Scope",
			changes: [null, null],
		});
		const clean = ChangeProposalSchema.parse({
			summary: "Clean",
			changes: [minimalChange()],
		});
		expect(discarded.summary).toBe("Scope");
		expect(clean.summary).toBe("Clean");
		expect(ChangeProposalSchema.parse({ changes: [] }).summary).toBe("");
	});

	it("accepts a change whose reasoning the model omitted", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [omit(minimalChange(), "reasoning")],
		});

		expect(result.success).toBe(true);
	});

	it("accepts a change whose reasoning the model returned as null", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange({ reasoning: null })],
		});

		expect(result.success).toBe(true);
	});

	it("accepts a change whose sourceContext the model omitted", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [omit(minimalChange(), "sourceContext")],
		});

		expect(result.success).toBe(true);
	});

	it("keeps every other change when one of them carries no reasoning", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [
				minimalChange(),
				omit(minimalChange({ title: "Second item" }), "reasoning"),
			],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(2);
	});

	// This asserted a REJECTED parse when it was written. The contract changed
	// deliberately: a change the apply path cannot use is now dropped rather
	// than rejecting the whole response with it. The intent is unchanged — such
	// a change must never reach the apply path — so the assertion moved from
	// "the parse fails" to "the change is not in the result".
	it("does not let a change with no title through to the apply path", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [omit(minimalChange(), "title")],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(0);
	});
});

/**
 * One malformed element must not cost the whole response.
 *
 * The 18 Aug fix made `reasoning` and `sourceContext` optional, which removed
 * ONE instance of a class: `generateObject` validates the entire response, so
 * anything the model gets wrong anywhere in `changes` rejects the lot — every
 * valid change in the same response included.
 *
 * The regression run that evening proved the class was still open, with a
 * different shape entirely:
 *
 *   ZodError: expected "object", code "invalid_type", path ["changes", 1]
 *
 * No amount of per-field relaxation can enumerate every way a model might
 * malform an element. So the array drops what it cannot use and keeps the rest.
 *
 * The array ITSELF stays strict on purpose: a response carrying no `changes` at
 * all is a wholesale generation failure, and quietly reporting "0 proposed"
 * would hide it. Only individual elements are salvageable.
 */
describe("ChangeProposalSchema — salvaging a partly malformed response", () => {
	it("keeps the valid changes when one element is not an object at all", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange(), null, minimalChange({ title: "Third" })],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(2);
	});

	it("keeps the valid changes when one element is a bare string", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange(), "just some prose the model emitted"],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("drops an element whose own fields do not validate", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [
				minimalChange(),
				omit(minimalChange({ title: "No title here" }), "title"),
			],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("drops an element whose type is outside the supported set", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: [minimalChange(), minimalChange({ type: "saga" })],
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("returns an empty list rather than throwing when every element is unusable", () => {
		const result = ChangeProposalSchema.safeParse({ changes: [null, 42] });

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(0);
	});

	it("still rejects a response carrying no changes array at all", () => {
		expect(ChangeProposalSchema.safeParse({}).success).toBe(false);
		expect(
			ChangeProposalSchema.safeParse({ changes: "nope" }).success,
		).toBe(false);
	});
});

/**
 * Fizzy #2395: prod logged the array arriving double-encoded — `changes` as a
 * JSON string rather than a list. The content was fine; only the packaging was
 * wrong, and rejecting it cost the entire run.
 *
 * A missing `changes` stays a rejection. The distinction is the point: one is a
 * provider encoding the right answer twice, the other is the model failing to
 * answer at all, and defaulting the second to `[]` would report "0 proposed"
 * for a run that generated nothing.
 */
describe("ChangeProposalSchema — a double-encoded changes array", () => {
	it("parses a changes array the model returned as a JSON string", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: JSON.stringify([
				minimalChange(),
				minimalChange({ title: "Second item" }),
			]),
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(2);
		expect(result.data?.changes[0]?.title?.to).toBe(minimalChange().title);
	});

	it("still drops the unusable elements inside a JSON-string array", () => {
		const result = ChangeProposalSchema.safeParse({
			changes: JSON.stringify([minimalChange(), null, 42]),
		});

		expect(result.success).toBe(true);
		expect(result.data?.changes).toHaveLength(1);
	});

	it("rejects a string that is not JSON at all", () => {
		expect(
			ChangeProposalSchema.safeParse({
				changes: "I could not find anything to propose.",
			}).success,
		).toBe(false);
	});

	it("rejects a JSON string that does not hold an array", () => {
		expect(
			ChangeProposalSchema.safeParse({
				changes: JSON.stringify({ changes: [] }),
			}).success,
		).toBe(false);
		expect(ChangeProposalSchema.safeParse({ changes: "42" }).success).toBe(
			false,
		);
	});

	it("does not turn a missing changes into an empty proposal", () => {
		expect(ChangeProposalSchema.safeParse({}).success).toBe(false);
	});
});

/**
 * The salvage uses `z.preprocess`, and this schema is not only a
 * validator — the AI SDK converts it to JSON Schema to TELL the model what to
 * produce. A wrapper that flattened the element shape would still pass every
 * test above while quietly degrading generation, which is the failure mode that
 * produced the malformed elements in the first place.
 */
describe("the JSON Schema the model is handed", () => {
	it("matches the stored model schema for shared and activity validators", async () => {
		for (const schema of [
			ChangeProposalSchema,
			createChangeProposalSchema({ onDiscarded: () => {} }),
		]) {
			expect(await asSchema(schema).jsonSchema).toEqual(
				changeProposalJsonSchema,
			);
		}
	});

	it("still describes each change's fields through the preprocess wrapper", () => {
		const json = z.toJSONSchema(ChangeProposalSchema, {
			io: "input",
		}) as Record<string, any>;
		const changes = json.properties?.changes;

		expect(changes?.type).toBe("array");
		expect(changes?.items?.type).toBe("object");
		expect(json.required).toEqual(["changes"]);
		expect(changes?.items?.required).toEqual(["type", "action", "title"]);
		for (const field of [
			"title",
			"description",
			"acceptanceCriteria",
			"priority",
			"size",
		]) {
			expect(changes?.items?.properties[field].required).toEqual(["to"]);
		}
		expect(Object.keys(changes?.items?.properties ?? {})).toEqual(
			expect.arrayContaining([
				"type",
				"action",
				"title",
				"reasoning",
				"sourceContext",
			]),
		);
	});
});

describe("generation annotation boundary", () => {
	it("strips post-generation annotations while retaining usable changes", () => {
		const parsed = ChangeProposalSchema.parse({
			changes: [
				minimalChange({
					predrafted: true,
					kindOverride: "example",
					routing: { action: "create" },
					targetResolution: { status: "resolved" },
					bodyMergeFallback: true,
					bodyMergeDeferred: true,
					structurePreserved: true,
					needsMoreInfo: true,
				}),
				null,
			],
		});
		expect(parsed.changes).toHaveLength(1);
		expect(parsed.changes[0]?.title?.to).toBe(minimalChange().title);
		for (const field of [
			"predrafted",
			"kindOverride",
			"routing",
			"targetResolution",
			"bodyMergeFallback",
			"bodyMergeDeferred",
			"structurePreserved",
			"needsMoreInfo",
		]) {
			expect(parsed.changes[0]).not.toHaveProperty(field);
		}
	});

	it("strips valid model-emitted annotations from the generation schema", () => {
		const annotated = minimalChange({
			predrafted: true,
			kindOverride: "BUG",
			routing: { decision: "create", confidence: 1 },
			targetResolution: { status: "resolved" },
			bodyMergeFallback: true,
			bodyMergeDeferred: true,
			structurePreserved: true,
			needsMoreInfo: true,
		});
		const full = backlogChangeItemSchema.parse(annotated);
		expect(full).toMatchObject(omit(annotated, "title"));
		const parsed = ChangeProposalSchema.parse({ changes: [annotated] });
		expect(parsed.changes).toHaveLength(1);
		for (const field of [
			"predrafted",
			"kindOverride",
			"routing",
			"targetResolution",
			"bodyMergeFallback",
			"bodyMergeDeferred",
			"structurePreserved",
			"needsMoreInfo",
		]) {
			expect(parsed.changes[0]).not.toHaveProperty(field);
		}
	});

	it("prompt-steers the real generation schema even after annotations are omitted", async () => {
		const schema = await zodSchema(ChangeProposalSchema).jsonSchema;
		const counts = countAnthropicSchemaParameters(schema);
		expect(Number.isFinite(counts.optionalParameters)).toBe(true);
		expect(
			counts.optionalParameters > 24 || counts.unionParameters > 16,
		).toBe(true);
		const params = { prompt: [], responseFormat: { type: "json", schema } };
		const out =
			await createAnthropicStructuredOutputLimitsMiddleware().transformParams?.(
				{
					type: "generate",
					params: params as never,
					model: { modelId: "claude-sonnet-4-5" } as never,
				},
			);
		expect(out).not.toHaveProperty("responseFormat");
		expect(out?.prompt[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining(JSON.stringify(schema)),
		});
	});
});
