import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CURRENT_DRAFT_CHAR_CAP } from "../lib/publishing-refinement";
import {
	BaseWebinarScriptSchema,
	composeWebinarScriptExport,
	composeWebinarScriptWorkingDraftBody,
	PublishingWebinarScriptSchema,
	WEBINAR_SCRIPT_BODY_MAX,
	type WebinarScriptDocument,
} from "../lib/publishing-webinar-script-body";

const minimalDocument = {
	title: "Attachment retention, end to end",
	sessionPurpose: "What changed and why it matters.",
	recommendedAudience: "Product users",
	suggestedLength: "[length TBD]",
	openingTalkTrack: "Here is the problem.",
	keyMessage: "Retention is configurable per project.",
	closingTalkTrack: "Next steps.",
	suggestedCta: "[CTA TBD]",
};

describe("PublishingWebinarScriptSchema", () => {
	it("parses a document with every omissible field omitted", () => {
		// The degrade-not-refuse rule. Four fields have no section in the PO
		// prompt, so their only instruction is text an org can delete; if
		// omitting them refused, an org edit would brick the content type.
		const parsed = PublishingWebinarScriptSchema.safeParse({
			...minimalDocument,
		});
		expect(parsed.success).toBe(true);
	});

	it("derives isScaffold from an empty demo flow and seeds inputsNeeded", () => {
		// isScaffold is NOT a model field. The PO prompt defines a scaffold as
		// exactly "the demo flow is not supported by available context", so
		// deriving it makes the flag incapable of disagreeing with the data.
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			demoFlow: [],
			inputsNeeded: [],
		});
		expect(parsed.isScaffold).toBe(true);
		expect(parsed.inputsNeeded).toHaveLength(1);
		expect(parsed.inputsNeeded[0]).toMatch(/not available/i);
	});

	it("derives isScaffold false when a demo step is present", () => {
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			demoFlow: [
				{
					name: "Open the settings page",
					whatToShow: "The retention field.",
					talkTrack: "Here is where you set it.",
					audienceTakeaway: "It is per project.",
				},
			],
		});
		expect(parsed.isScaffold).toBe(false);
		expect(parsed.inputsNeeded).toEqual([]);
	});

	it("rejects a whitespace-only title", () => {
		// trim() BEFORE min(1). The weak form was measured in 2C: the run
		// SUCCEEDS, seeds a working draft with an empty heading, and every
		// downstream reader then narrows the stored document to null.
		const parsed = PublishingWebinarScriptSchema.safeParse({
			...minimalDocument,
			title: "   ",
		});
		expect(parsed.success).toBe(false);
	});
});

describe("composeWebinarScriptExport", () => {
	// Not exercised by the composed-maximum guard below, which only calls the
	// working draft composer — so this is this function's only coverage.
	// Minimal on purpose: the export's exact prose is not pinned by spec, only
	// that it carries the advice the working draft deliberately omits.

	it("states isScaffold explicitly, even when false", () => {
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			demoFlow: [
				{
					name: "Open the settings page",
					whatToShow: "The retention field.",
					talkTrack: "Here is where you set it.",
					audienceTakeaway: "It is per project.",
				},
			],
		});
		const exported = composeWebinarScriptExport(parsed, {});
		expect(exported).toContain("Scaffold");
		expect(exported).toMatch(/Scaffold:\*\*\s*No/);
		// Humanized, not the raw enum literal — a presenter reading this file
		// standalone should read a claim made from the source material, not a
		// bare label that reads as Fabric's own finding. Pinned against the
		// default UNCONFIRMED value, matching the sibling convention this
		// mirrors (StakeholderEmailPanel.tsx's RELEASE_STATUS_LABELS).
		expect(exported).not.toContain("**Release status:** UNCONFIRMED");
		expect(exported).toMatch(
			/didn't say whether this has shipped, so the draft asserts no release state/i,
		);
	});

	it("carries the advice fields the working draft omits", () => {
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			demoFlow: [],
			suggestedAssets: {
				confirmed: ["Product screenshot"],
				needsConfirmation: ["Customer logo"],
			},
			safetyNote: "Generalized the customer's industry.",
		});
		const draft = composeWebinarScriptWorkingDraftBody(parsed);
		const exported = composeWebinarScriptExport(parsed, {});

		// isScaffold, releaseStatus, both asset lists, inputsNeeded and
		// safetyNote are advice the working draft excludes (spec §5.5) — the
		// export is what adds them back.
		expect(draft).not.toContain("Scaffold");
		expect(draft).not.toContain("Product screenshot");
		expect(exported).toMatch(/Scaffold:\*\*\s*Yes/);
		expect(exported).toContain("Product screenshot");
		expect(exported).toContain("Customer logo");
		expect(exported).toContain(parsed.inputsNeeded[0]);
		expect(exported).toContain("Generalized the customer's industry.");

		// The working draft's own content still has to survive intact inside
		// the export — this is an addition, not a rewrite.
		expect(exported).toContain(draft.split("\n\n")[0]);
		expect(exported).toContain(parsed.sessionPurpose);
	});

	it("attributes an asset move to Fabric, distinct from the model's own caution", () => {
		// The spec's field table requires both suggestedAssets lists PLUS the
		// clamp attribution. Without it a reader cannot tell an asset moved
		// out of "confirmed" by the clamp apart from one never claimed at all.
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			suggestedAssets: {
				confirmed: ["Product screenshot"],
				needsConfirmation: ["Recorded walkthrough"],
			},
		});
		const exported = composeWebinarScriptExport(parsed, {
			assets: ["Recorded walkthrough"],
			assetKinds: { "Recorded walkthrough": "ASSET_APPROVAL" },
		});
		expect(exported).toMatch(/Moved out of the confirmed list by Fabric/i);
		expect(exported).toContain("Recorded walkthrough");
	});

	it("says 'naming them' when the clamp moved more than one asset", () => {
		// Both other attribution tests clamp exactly one asset, so the shared
		// note's singular/plural was unpinned. The precedent it mirrors,
		// CaseStudyPanel's ASSET_CLAMP_NOTE, reads "naming them:", and the list
		// this sentence introduces is comma-joined, so it can hold several.
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			suggestedAssets: {
				confirmed: ["Product screenshot"],
				needsConfirmation: ["Recorded walkthrough", "Latency chart"],
			},
		});
		const exported = composeWebinarScriptExport(parsed, {
			assets: ["Recorded walkthrough", "Latency chart"],
			assetKinds: {
				"Recorded walkthrough": "ASSET_APPROVAL",
				"Latency chart": "ASSET_APPROVAL",
			},
		});
		expect(exported).toContain("naming them:");
		expect(exported).toContain("Recorded walkthrough");
		expect(exported).toContain("Latency chart");
	});

	it("omits the clamp attribution entirely when nothing was clamped", () => {
		// An empty record must not emit a bare heading or an empty bullet.
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			suggestedAssets: {
				confirmed: ["Product screenshot"],
				needsConfirmation: [],
			},
		});
		const exported = composeWebinarScriptExport(parsed, {});
		expect(exported).not.toContain("Moved out of");
	});

	it("renders every list's empty-state fallback text", () => {
		// Both other export tests use non-empty lists. With the clamp
		// attribution added, the all-empty case is the one most worth
		// pinning: no attribution, no confirmed/needsConfirmation entries,
		// no inputsNeeded — every fallback fires, and no bare heading or
		// empty bullet appears in its place.
		//
		// A demo step is supplied so isScaffold is false — an empty demoFlow
		// would seed inputsNeeded with SCAFFOLD_WITHOUT_INPUTS and defeat the
		// "Nothing outstanding" assertion below.
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			demoFlow: [
				{
					name: "Open the settings page",
					whatToShow: "The retention field.",
					talkTrack: "Here is where you set it.",
					audienceTakeaway: "It is per project.",
				},
			],
		});
		const exported = composeWebinarScriptExport(parsed, {});
		expect(exported).toContain("_None confirmed_");
		expect(exported).toContain("_None_");
		expect(exported).toContain("_Nothing outstanding_");
	});

	it("builds the heading from the title directly, even when the title spans multiple lines", () => {
		// Regression: the export used to recover its heading by splitting the
		// composed working draft on "\n\n", assuming the first block was
		// exactly the title. `title` has no single-line constraint, so a
		// title containing a blank line made that split capture only part of
		// it, silently splicing the remainder in among the scaffold and
		// release-status lines instead of failing loudly.
		const multiLineTitle = "Retention, end to end\n\nA deeper look";
		const parsed = PublishingWebinarScriptSchema.parse({
			...minimalDocument,
			title: multiLineTitle,
		});
		const exported = composeWebinarScriptExport(parsed, {});
		expect(
			exported.startsWith(`# ${multiLineTitle}\n\n**Scaffold:**`),
		).toBe(true);
	});
});

// =============================================================================
// The composed-maximum guard's bound-reading walker
// =============================================================================
//
// Reads zod 4.4.3's own internal check representation directly, rather than
// the v3-shaped `_def.checks[].kind` accessor: that accessor exists on a zod 4
// node too, but resolves to three EMPTY objects and does not throw — a walker
// written against it silently finds no `max` anywhere, fills every string
// field with `""`, produces a zero-length document, and passes every
// assertion below green. THROWING on a node this walker cannot read is the
// guard against exactly that failure mode; returning `{}` or a default would
// recreate it.

/** A zod 4 internal node, read structurally rather than through the public API. */
type InternalNode = {
	_zod?: {
		def?: {
			type?: string;
			innerType?: InternalNode;
			element?: InternalNode;
			checks?: unknown[];
			entries?: Record<string, string>;
			shape?: Record<string, InternalNode>;
		};
	};
	shape?: Record<string, InternalNode>;
};

/** Unwrap ZodDefault / ZodNullable / ZodOptional down to the node they wrap. */
function unwrap(node: InternalNode): InternalNode {
	let current = node;
	while (current?._zod?.def?.innerType) {
		current = current._zod.def.innerType;
	}
	return current;
}

/** The node's zod-internal type tag ("string", "array", "object", "enum", …). */
function nodeType(node: InternalNode, path: string): string {
	const type = node?._zod?.def?.type;
	if (!type) {
		throw new Error(`walker: cannot read node type at "${path}"`);
	}
	return type;
}

/** The node's shape, for an object — checked via the public accessor first. */
function nodeShape(
	node: InternalNode,
	path: string,
): Record<string, InternalNode> {
	const shape = node.shape ?? node._zod?.def?.shape;
	if (!shape) {
		throw new Error(`walker: no shape readable on object at "${path}"`);
	}
	return shape;
}

/**
 * The `max_length` bound on a string or array node — the LENGTH cap for a
 * string, the ITEM-COUNT cap for an array. Throws rather than returning
 * `undefined` when no such check is present, per the module's own rule: a
 * silent miss here is indistinguishable from "this field has no maximum" and
 * would make every assertion below trivially true.
 */
function maxLength(node: InternalNode, path: string): number {
	const checks = node._zod?.def?.checks ?? [];
	for (const raw of checks) {
		const check = raw as {
			_zod?: { def?: { check?: string; maximum?: number } };
			def?: { check?: string; maximum?: number };
		};
		const def = check._zod?.def ?? check.def;
		if (def?.check === "max_length" && typeof def.maximum === "number") {
			return def.maximum;
		}
	}
	throw new Error(`walker: no max_length check found at "${path}"`);
}

/** Walk `schema` along `path`, descending through arrays via their element. */
function walkToNode(
	schema: z.ZodTypeAny,
	path: readonly string[],
): InternalNode {
	let node: InternalNode = schema as unknown as InternalNode;
	for (let i = 0; i < path.length; i++) {
		const key = path[i] as string;
		const shape = nodeShape(node, path.slice(0, i).join(".") || "$");
		if (!(key in shape)) {
			throw new Error(
				`walker: no field "${key}" at "${path.slice(0, i).join(".")}"`,
			);
		}
		node = unwrap(shape[key] as InternalNode);
		const isLast = i === path.length - 1;
		if (!isLast) {
			const type = nodeType(node, path.slice(0, i + 1).join("."));
			if (type === "array") {
				const element = node._zod?.def?.element;
				if (!element) {
					throw new Error(
						`walker: array at "${path.slice(0, i + 1).join(".")}" has no element schema`,
					);
				}
				node = unwrap(element);
			}
		}
	}
	return node;
}

/** The declared `max()` bound at `path` — a string length or an array item count. */
function declaredMaxAt(schema: z.ZodTypeAny, path: readonly string[]): number {
	const node = walkToNode(schema, path);
	const type = nodeType(node, path.join("."));
	if (type !== "string" && type !== "array") {
		throw new Error(
			`walker: node at "${path.join(".")}" is a "${type}", not a string or array`,
		);
	}
	return maxLength(node, path.join("."));
}

/**
 * Read the value the maximal-document builder placed at `path`. Descends
 * through an array by reading its first element — every element the builder
 * produces is identically maximal, so any index tells the same story.
 */
function valueAt(doc: unknown, path: readonly string[]): unknown {
	let node = doc;
	for (const key of path) {
		if (node === null || node === undefined) {
			throw new Error(`valueAt: nothing to read "${key}" from`);
		}
		if (Array.isArray(node)) {
			if (node.length === 0) {
				throw new Error(
					`valueAt: array is empty, cannot read "${key}"`,
				);
			}
			node = (node[0] as Record<string, unknown>)[key];
		} else {
			node = (node as Record<string, unknown>)[key];
		}
	}
	return node;
}

/** Build a single maximally-sized value for one schema node. */
function buildMaximalValue(rawNode: InternalNode, path: string): unknown {
	const node = unwrap(rawNode);
	const type = nodeType(node, path);
	switch (type) {
		case "string":
			return "x".repeat(maxLength(node, path));
		case "enum": {
			const entries = node._zod?.def?.entries;
			if (!entries) {
				throw new Error(`walker: enum at "${path}" has no entries`);
			}
			const values = Object.values(entries);
			if (values.length === 0) {
				throw new Error(`walker: enum at "${path}" has no values`);
			}
			return values[0];
		}
		case "array": {
			const element = node._zod?.def?.element;
			if (!element) {
				throw new Error(
					`walker: array at "${path}" has no element schema`,
				);
			}
			const count = maxLength(node, path);
			return Array.from({ length: count }, (_, i) =>
				buildMaximalValue(element, `${path}[${i}]`),
			);
		}
		case "object": {
			const shape = nodeShape(node, path);
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(shape)) {
				result[key] = buildMaximalValue(
					shape[key] as InternalNode,
					`${path}.${key}`,
				);
			}
			return result;
		}
		default:
			throw new Error(
				`walker: unhandled node type "${type}" at "${path}"`,
			);
	}
}

/** Build a document with every leaf filled to its declared maximum. */
function buildMaximalDocumentFromSchema(
	schema: z.ZodTypeAny,
): Record<string, unknown> {
	return buildMaximalValue(schema as unknown as InternalNode, "$") as Record<
		string,
		unknown
	>;
}

/** Every scalar string leaf the walker must visit, schema field order. */
const EXPECTED_STRING_LEAVES: readonly (readonly string[])[] = [
	["title"],
	["sessionPurpose"],
	["recommendedAudience"],
	["suggestedLength"],
	["presenterNotes"],
	["openingTalkTrack"],
	["keyMessage"],
	["closingTalkTrack"],
	["suggestedCta"],
	["safetyNote"],
	["supportingDetails", "problem"],
	["supportingDetails", "solution"],
	["supportingDetails", "whatMakesItInteresting"],
	["supportingDetails", "evidence"],
	["supportingDetails", "caveats"],
	["demoFlow", "name"],
	["demoFlow", "whatToShow"],
	["demoFlow", "talkTrack"],
	["demoFlow", "audienceTakeaway"],
];

/** Every array leaf the walker must visit, as [path, declared maxItems]. */
const EXPECTED_ARRAY_LEAVES: readonly (readonly [readonly string[], number])[] =
	[
		[["agenda"], 10],
		[["demoFlow"], 8],
		[["suggestedAssets", "confirmed"], 8],
		[["suggestedAssets", "needsConfirmation"], 8],
		[["inputsNeeded"], 8],
	];

describe("the composed working draft fits the caps it will meet", () => {
	// Derived from the schema, never hand-written: a fixture does not grow when
	// someone raises a bound, so a hand-written one stays green while the real
	// maximum moves past the cap.
	// Walk the BASE object, not the exported schema. `.transform()` in zod 4
	// (this repo is on 4.x across utils/temporal/database) returns a ZodPipe,
	// which has no `.shape` — so handing the walker
	// `PublishingWebinarScriptSchema` gives it nothing to traverse. The base is
	// also what the model actually sees: generateObject builds its JSON schema
	// with `io: "input"`, so the transform is invisible there too. This is why
	// Step 3 exports `BaseWebinarScriptSchema`.
	const maximal = buildMaximalDocumentFromSchema(BaseWebinarScriptSchema);

	it("reads a bound it can be checked against", () => {
		// Self-test the reader before trusting it anywhere else. A
		// declaredMaxAt that always returns 0 makes every assertion below
		// trivially true.
		expect(declaredMaxAt(BaseWebinarScriptSchema, ["title"])).toBe(200);
		expect(
			declaredMaxAt(BaseWebinarScriptSchema, ["demoFlow", "talkTrack"]),
		).toBe(1000);
	});

	it("visits every leaf the walker should have visited", () => {
		// Asserted over the SCHEMA's key set, not the generated object: a
		// walker that stops seeing `demoFlow` emits nothing for it, so
		// iterating the OUTPUT would find nothing to check and pass green
		// while the fixture silently shrank.
		for (const path of EXPECTED_STRING_LEAVES) {
			expect(valueAt(maximal, path)).toHaveLength(
				declaredMaxAt(BaseWebinarScriptSchema, path),
			);
		}
		for (const [path, maxItems] of EXPECTED_ARRAY_LEAVES) {
			// Arrays get their own assertion: `String(agenda)` is a
			// comma-joined 2,009-character value matching neither the element
			// bound (200) nor the array bound (10).
			expect(valueAt(maximal, path)).toHaveLength(maxItems);
		}
	});

	it("is a genuinely maximal document, not a shrunken one", () => {
		// Spec 11.5's total-length floor, and the ONLY assertion that binds in
		// the "schema grew, constant did not" direction. Without it, a walker
		// that returns {} yields an empty leaf set, a zero-length body, and two
		// green cases.
		expect(JSON.stringify(maximal).length).toBeGreaterThan(30_000);
	});

	it("stays under both caps with real headroom", () => {
		const body = composeWebinarScriptWorkingDraftBody(
			maximal as unknown as WebinarScriptDocument,
		);
		expect(body.length).toBeLessThan(CURRENT_DRAFT_CHAR_CAP - 2000);
		// The named constant, not a literal 40000 — the two are equal today,
		// and a hardcoded copy could not notice if they ever diverged.
		expect(body.length).toBeLessThan(WEBINAR_SCRIPT_BODY_MAX - 2000);
	});
});
