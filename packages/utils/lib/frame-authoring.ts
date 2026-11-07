import { type DefaultTreeAdapterMap, Parser, type Token } from "parse5";
import { z } from "zod";
import {
	FRAME_REVIEW_MAX_BYTES,
	frameReviewBlockSchema,
} from "./frame-review-contracts";

const name = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
	.refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
export const frameAuthoringDocumentSchema = z.strictObject({
	title: z.string().trim().min(1).max(300),
	description: z.string().max(20000).optional(),
	kind: z.enum(["frame", "slideshow"]).default("frame"),
	presentation: z.enum(["DOCUMENT", "INTERFACE"]).optional(),
	blocks: z.array(frameReviewBlockSchema).min(1).max(100),
	theme: z
		.strictObject({
			mode: z.enum(["light", "dark", "system"]).optional(),
			accentColor: z.string().max(100).optional(),
		})
		.optional(),
});
export const frameCreateSchema = frameAuthoringDocumentSchema.extend({
	requestId: z.string().uuid(),
	projectId: z.string().min(1).max(200).optional(),
	conversationId: z.string().min(1).max(200).optional(),
});
export const frameTemplateVariableSchema = z
	.strictObject({
		type: z.enum(["string", "number", "boolean", "select"]),
		default: z
			.union([z.string().max(10000), z.number().finite(), z.boolean()])
			.optional(),
		label: z.string().min(1).max(200),
		options: z.array(z.string().max(200)).min(1).max(50).optional(),
		required: z.boolean().optional(),
	})
	.refine((v) => v.type !== "select" || !!v.options?.length, {
		message: "Select variables need choices.",
	});
export const frameTemplateCreateSchema = z.strictObject({
	requestId: z.string().uuid(),
	name: z.string().trim().min(1).max(200),
	description: z.string().max(20000).optional(),
	category: z.string().trim().min(1).max(100),
	content: frameAuthoringDocumentSchema,
	variables: z
		.record(name, frameTemplateVariableSchema)
		.refine((v) => Object.keys(v).length <= 50)
		.default({}),
	confirmOrganizationAudience: z.literal(true),
});
export const frameFromTemplateSchema = z.strictObject({
	requestId: z.string().uuid(),
	templateId: z.string().min(1).max(200),
	variables: z
		.record(
			name,
			z.union([z.string().max(10000), z.number().finite(), z.boolean()]),
		)
		.refine((v) => Object.keys(v).length <= 50)
		.default({}),
	title: z.string().min(1).max(300).optional(),
	description: z.string().max(20000).optional(),
	projectId: z.string().min(1).max(200).optional(),
	conversationId: z.string().min(1).max(200).optional(),
});
export type FrameAuthoringDocument = z.infer<
	typeof frameAuthoringDocumentSchema
>;
export type FrameTemplateVariables = z.infer<
	typeof frameTemplateCreateSchema
>["variables"];
export function normalizeFrameTemplateValues(
	definitions: FrameTemplateVariables,
	values: Record<string, string | number | boolean>,
) {
	for (const key of Object.keys(values)) {
		if (!Object.hasOwn(definitions, key)) {
			throw new Error(`Unknown template input: ${key}`);
		}
	}
	const result: Record<string, string | number | boolean> =
		Object.create(null);
	for (const [key, field] of Object.entries(definitions)) {
		const raw = values[key] ?? field.default;
		if (raw === undefined || raw === "") {
			if (field.required) {
				throw new Error(`Provide ${field.label}.`);
			}
			result[key] = "";
			continue;
		}
		if (field.type === "number") {
			const value =
				typeof raw === "number"
					? raw
					: typeof raw === "string" && raw.trim()
						? Number(raw)
						: Number.NaN;
			if (!Number.isFinite(value)) {
				throw new Error(`${field.label} must be a number.`);
			}
			result[key] = value;
		} else if (field.type === "boolean") {
			if (raw === true || raw === "true") {
				result[key] = true;
			} else if (raw === false || raw === "false") {
				result[key] = false;
			} else {
				throw new Error(`${field.label} must be true or false.`);
			}
		} else {
			const value = String(raw);
			if (field.type === "select" && !field.options?.includes(value)) {
				throw new Error(
					`Choose an available value for ${field.label}.`,
				);
			}
			result[key] = value;
		}
	}
	return result;
}
const escapeHtml = (v: string) =>
	v.replace(
		/[&<>"']/g,
		(c) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[c]!,
	);
const escapeMarkdown = (v: string) =>
	v.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");

/** Interpolate only actual HTML text nodes, never attributes or raw script/style text.
 * Source offsets come from the HTML parser, including browser error recovery for malformed tags. */
function assertHtmlTextInputs(html: string) {
	const positions = [
		...html.matchAll(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/g),
	].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
	if (!positions.length) return;
	let malformed = false;
	const options = {
		sourceCodeLocationInfo: true,
		onParseError: (error: { code: string }) => {
			if (error.code !== "missing-doctype") malformed = true;
		},
	};
	// The tree can merge or discard tags (for example a second body tag).
	// Capture every tokenizer span before tree recovery changes its provenance.
	const tokenSpans: Array<{ start: number; end: number }> = [];
	const capture = (token: {
		location: { startOffset: number; endOffset: number } | null;
	}) => {
		if (token.location)
			tokenSpans.push({
				start: token.location.startOffset,
				end: token.location.endOffset,
			});
	};
	class InputContextParser extends Parser<DefaultTreeAdapterMap> {
		override onStartTag(token: Token.TagToken) {
			capture(token);
			super.onStartTag(token);
		}
		override onEndTag(token: Token.TagToken) {
			capture(token);
			super.onEndTag(token);
		}
		override onComment(token: Token.CommentToken) {
			capture(token);
			super.onComment(token);
		}
		override onDoctype(token: Token.DoctypeToken) {
			capture(token);
			super.onDoctype(token);
		}
	}
	let root: DefaultTreeAdapterMap["node"];
	if (/^\s*(?:<!doctype\s|<html(?:\s|>))/i.test(html))
		root = InputContextParser.parse<DefaultTreeAdapterMap>(html, options);
	else {
		const parser =
			InputContextParser.getFragmentParser<DefaultTreeAdapterMap>(
				null,
				options,
			);
		parser.tokenizer.write(html, true);
		root = parser.getFragment();
	}
	const ranges: Array<{ start: number; end: number }> = [];
	const forbidden: Array<{ start: number; end: number }> = [...tokenSpans];
	const stack: Array<{ node: DefaultTreeAdapterMap["node"]; raw: boolean }> =
		[{ node: root, raw: false }];
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		const node = item.node;
		const raw =
			item.raw ||
			("tagName" in node &&
				(node.tagName === "script" || node.tagName === "style"));
		const location = node.sourceCodeLocation;
		if (
			"attrs" in node &&
			node.attrs.some((attribute) =>
				/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/.test(
					attribute.name + attribute.value,
				),
			)
		)
			throw new Error(
				"Template inputs belong in HTML text, not attributes.",
			);
		if (node.nodeName === "#text" && !raw && location)
			ranges.push({
				start: location.startOffset,
				end: location.endOffset,
			});
		if (
			location &&
			(raw ||
				node.nodeName === "#comment" ||
				node.nodeName === "#documentType")
		)
			forbidden.push({
				start: location.startOffset,
				end: location.endOffset,
			});
		if ("tagName" in node && node.sourceCodeLocation) {
			const { startTag, endTag } = node.sourceCodeLocation;
			for (const tag of [startTag, endTag])
				if (tag)
					forbidden.push({
						start: tag.startOffset,
						end: tag.endOffset,
					});
		}
		if ("childNodes" in node)
			for (const child of node.childNodes)
				stack.push({ node: child, raw });
		if ("content" in node) stack.push({ node: node.content, raw });
	}
	// Text may be foster-parented or merged by HTML error recovery. Exclude actual
	// tag/comment/raw-text source spans even when a merged text location spans them.
	forbidden.sort((a, b) => a.start - b.start);
	const excluded: typeof forbidden = [];
	for (const span of forbidden) {
		const previous = excluded.at(-1);
		if (previous && span.start <= previous.end)
			previous.end = Math.max(previous.end, span.end);
		else excluded.push({ ...span });
	}
	ranges.sort((a, b) => a.start - b.start);
	let range = 0;
	let exclusion = 0;
	for (const position of positions) {
		while (range < ranges.length && ranges[range].end < position.end)
			range++;
		while (
			exclusion < excluded.length &&
			excluded[exclusion].end <= position.start
		)
			exclusion++;
		const text = ranges[range];
		const denied = excluded[exclusion];
		if (
			!text ||
			position.start < text.start ||
			position.end > text.end ||
			(denied && denied.start < position.end)
		)
			throw new Error(
				"Template inputs belong in HTML text, not attributes, comments, scripts or styles.",
			);
	}
	if (malformed)
		throw new Error("Repair malformed HTML before using template inputs.");
}
/** Reserve the exact authoring metadata plus the maximum encoded conversation identifier.
 * Stored JSON is pretty-printed, so compact input size is not an admission boundary. */
export function frameAuthoringStoredBytes(
	document: FrameAuthoringDocument,
): number {
	return new TextEncoder().encode(
		JSON.stringify(
			{
				version: 1,
				...document,
				metadata: {
					generatedByTool: "fabric_create_frame",
					conversationId: "\u0000".repeat(200),
					providerKeys: [],
					sourceRunType: "FRAME_AUTHORING",
				},
			},
			null,
			2,
		),
	).byteLength;
}
/** Substitute the parsed tree once. JSON inputs keep their types; values cannot create JSON syntax. */
export function renderFrameTemplate(
	content: FrameAuthoringDocument,
	definitions: FrameTemplateVariables,
	values: Record<string, string | number | boolean>,
): FrameAuthoringDocument {
	if (
		new TextEncoder().encode(JSON.stringify(content)).byteLength >
		FRAME_REVIEW_MAX_BYTES
	)
		throw new Error("Template content exceeds 1 MB.");
	const supplied = normalizeFrameTemplateValues(definitions, values);
	let substitutedBytes = 0;
	const charge = (value: string) => {
		substitutedBytes += new TextEncoder().encode(value).byteLength;
		if (substitutedBytes > FRAME_REVIEW_MAX_BYTES)
			throw new Error("Rendered template exceeds 1 MB.");
		return value;
	};
	const fill = (
		text: string,
		mode: "text" | "html" | "markdown" = "text",
	) => {
		if (mode === "html") assertHtmlTextInputs(text);
		return text.replace(
			/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
			(_match, key: string) => {
				if (!Object.hasOwn(supplied, key)) {
					throw new Error(`Unknown template variable: ${key}`);
				}
				const value = String(supplied[key]);
				return charge(
					mode === "html"
						? escapeHtml(value)
						: mode === "markdown"
							? escapeMarkdown(value)
							: value,
				);
			},
		);
	};
	const tree = (value: unknown): unknown => {
		if (typeof value === "string") {
			const full = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(value);
			if (full && Object.hasOwn(supplied, full[1])) {
				charge(String(supplied[full[1]]));
				return supplied[full[1]];
			}
			return fill(value);
		}
		if (Array.isArray(value)) {
			return value.map(tree);
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, tree(item)]),
			);
		}
		return value;
	};
	const result = {
		...content,
		title: fill(content.title),
		description:
			content.description === undefined
				? undefined
				: fill(content.description),
		blocks: content.blocks.map((block) => {
			const rendered =
				block.type === "json"
					? JSON.stringify(tree(JSON.parse(block.content)), null, 2)
					: fill(
							block.content,
							block.type === "html"
								? "html"
								: block.type === "markdown"
									? "markdown"
									: "text",
						);
			return {
				...block,
				title:
					block.title === undefined ? undefined : fill(block.title),
				content: rendered,
			};
		}),
	};
	if (frameAuthoringStoredBytes(result) > FRAME_REVIEW_MAX_BYTES) {
		throw new Error("Rendered template exceeds 1 MB.");
	}
	return frameAuthoringDocumentSchema.parse(result);
}
export function validateFrameAuthoringDocument(raw: unknown) {
	const parsed = frameAuthoringDocumentSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			valid: false,
			canSave: false,
			checks: [
				{
					status: "FAILED" as const,
					message:
						"Provide a title and valid, uniquely identified content blocks.",
				},
			],
		};
	}
	const doc = parsed.data;
	const checks: Array<{
		blockId?: string;
		status: "PASSED" | "FAILED" | "NOT_ASSESSED";
		message: string;
	}> = [];
	if (new Set(doc.blocks.map((b) => b.id)).size !== doc.blocks.length) {
		checks.push({
			status: "FAILED",
			message: "Block identifiers must be unique.",
		});
	}
	if (frameAuthoringStoredBytes(doc) > FRAME_REVIEW_MAX_BYTES) {
		checks.push({
			status: "FAILED",
			message: "Page content exceeds 1 MB.",
		});
	}
	for (const block of doc.blocks) {
		if (block.type === "json") {
			try {
				JSON.parse(block.content);
				checks.push({
					blockId: block.id,
					status: "PASSED",
					message: "JSON syntax is valid.",
				});
			} catch {
				checks.push({
					blockId: block.id,
					status: "FAILED",
					message: "JSON syntax is invalid.",
				});
			}
		} else {
			checks.push({
				blockId: block.id,
				status: "NOT_ASSESSED",
				message:
					"Preview this block to review its layout and content. Structural validation does not verify factual accuracy or script behavior.",
			});
		}
	}
	const valid = !checks.some((c) => c.status === "FAILED");
	return { valid, canSave: valid, checks };
}

/** JSONB storage changes object key order; stable receipts compare semantics, retaining array order. */
export function stableFrameInput(value: unknown): string {
	const normalize = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(normalize)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.entries(v)
							.filter(([, item]) => item !== undefined)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, item]) => [k, normalize(item)]),
					)
				: v;
	return JSON.stringify(normalize(value));
}
