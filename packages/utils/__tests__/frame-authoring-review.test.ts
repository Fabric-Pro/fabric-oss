import { describe, expect, it } from "vitest";
import {
	frameTemplateCreateSchema,
	renderFrameTemplate,
	validateFrameAuthoringDocument,
} from "../lib/frame-authoring";
import {
	frameProposeChangeSchema,
	summarizeFrameChange,
} from "../lib/frame-review-contracts";

const document = {
	title: "Example",
	kind: "frame" as const,
	blocks: [
		{
			id: "main",
			type: "json" as const,
			content:
				'{"name":"{{client}}","count":"{{count}}","enabled":"{{enabled}}"}',
		},
	],
};
const fields = {
	client: { type: "string" as const, label: "Client", required: true },
	count: { type: "number" as const, label: "Count", default: 0 },
	enabled: { type: "boolean" as const, label: "Enabled", default: false },
};
describe("reviewed artifact authoring", () => {
	it("preserves quotes, newlines, zero and false without injecting JSON", () => {
		const value = 'Example "Client"\n{{count}}';
		const rendered = renderFrameTemplate(document, fields, {
			client: value,
		});
		expect(JSON.parse(rendered.blocks[0].content)).toEqual({
			name: value,
			count: 0,
			enabled: false,
		});
	});
	it("rejects unknown variables and invalid typed inputs", () => {
		const inputs: Array<Record<string, string | number | boolean>> = [
			{ client: "Example", unknown: "x" },
			{ client: "Example", enabled: "yes" },
			{ client: "Example", count: "infinite" },
			{},
		];
		for (const input of inputs) {
			expect(() =>
				renderFrameTemplate(document, fields, input),
			).toThrow();
		}
	});
	it("renders HTML input as text and refuses dynamic attributes or scripts", () => {
		const html = (content: string) => ({
			...document,
			blocks: [{ id: "main", type: "html" as const, content }],
		});
		expect(
			renderFrameTemplate(html("<p>{{client}}</p>"), fields, {
				client: "<img src=x onerror=alert(1)>",
			}).blocks[0].content,
		).toContain("&lt;img");
		for (const content of [
			'<a href="{{client}}">link</a>',
			'<script>const x="{{client}}";</script>',
			"<style>.x{color:{{client}}}</style>",
		]) {
			expect(() =>
				renderFrameTemplate(html(content), fields, { client: "bad" }),
			).toThrow();
		}
	});
	it("escapes Markdown link and emphasis inputs", () => {
		const rendered = renderFrameTemplate(
			{
				...document,
				blocks: [
					{
						id: "main",
						type: "markdown",
						content: "Hello {{client}}",
					},
				],
			},
			fields,
			{ client: "[click](javascript:alert)" },
		);
		expect(rendered.blocks[0].content).toBe(
			"Hello \\[click\\]\\(javascript:alert\\)",
		);
	});
	it("requires explicit organization audience and disallows copied authority or branding", () => {
		const input = {
			requestId: "11111111-1111-4111-8111-111111111111",
			name: "Example",
			category: "General",
			content: document,
			variables: fields,
		};
		expect(frameTemplateCreateSchema.safeParse(input).success).toBe(false);
		expect(
			frameTemplateCreateSchema.safeParse({
				...input,
				confirmOrganizationAudience: true,
			}).success,
		).toBe(true);
		expect(
			frameTemplateCreateSchema.safeParse({
				...input,
				confirmOrganizationAudience: true,
				content: {
					...document,
					metadata: { authoritySessionId: "example-authority" },
				},
			}).success,
		).toBe(false);
	});
	it("only claims structural validation and checks JSON syntax/unique IDs", () => {
		expect(
			validateFrameAuthoringDocument({
				...document,
				blocks: [
					{
						id: "main",
						type: "html",
						content: "<script>example()</script>",
					},
				],
			}),
		).toMatchObject({
			canSave: true,
			checks: [{ status: "NOT_ASSESSED" }],
		});
		expect(
			validateFrameAuthoringDocument({
				...document,
				blocks: [{ id: "main", type: "json", content: "{" }],
			}).canSave,
		).toBe(false);
		expect(
			validateFrameAuthoringDocument({
				...document,
				blocks: [document.blocks[0], document.blocks[0]],
			}).canSave,
		).toBe(false);
	});
	it("proposals cannot change permissions, source authority or kind", () => {
		const input = {
			requestId: "11111111-1111-4111-8111-111111111111",
			expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
			edit: { title: "New" },
		};
		expect(frameProposeChangeSchema.safeParse(input).success).toBe(true);
		for (const edit of [
			{},
			{ isPublic: true },
			{ metadata: { runtime: { tools: ["example"] } } },
			{ kind: "slideshow" },
			{ theme: { branding: {} } },
		]) {
			expect(
				frameProposeChangeSchema.safeParse({ ...input, edit }).success,
			).toBe(false);
		}
	});
	it("summarizes added, removed and changed blocks", () => {
		const base = {
			title: "Old",
			blocks: [
				{ id: "same", type: "markdown" as const, content: "old" },
				{ id: "removed", type: "markdown" as const, content: "old" },
			],
		};
		expect(
			summarizeFrameChange(base, {
				title: "New",
				blocks: [
					{ id: "same", type: "markdown", content: "new" },
					{ id: "added", type: "markdown", content: "new" },
				],
			}),
		).toMatchObject({
			titleChanged: true,
			blocks: [
				{ id: "same", change: "updated" },
				{ id: "added", change: "added" },
				{ id: "removed", change: "removed" },
			],
		});
	});
});

it("refuses interpolation inside attributes even when a preceding quoted value contains >", () => {
	for (const html of [
		'<button title="a > b" onclick="{{client}}">Click</button>',
		"<button title='a > b' data-value='{{client}}'>Click</button>",
		'<script title="a > b">{{client}}</script>',
		"<!-- a > {{client}} -->",
	])
		expect(() =>
			renderFrameTemplate(
				{
					...document,
					blocks: [{ id: "main", type: "html", content: html }],
				},
				fields,
				{ client: "alert(1)" },
			),
		).toThrow();
	expect(
		renderFrameTemplate(
			{
				...document,
				blocks: [
					{
						id: "main",
						type: "html",
						content:
							"<script>const x = 1;</script><p>{{client}}</p>",
					},
				],
			},
			fields,
			{ client: "Example" },
		).blocks[0].content,
	).toContain("<p>Example</p>");
});
it("admits only content that remains reviewable after metadata and pretty printing", () => {
	const near = {
		...document,
		blocks: [
			{
				id: "main",
				type: "markdown" as const,
				content: "x".repeat(999800),
			},
		],
	};
	expect(
		new TextEncoder().encode(JSON.stringify(near)).byteLength,
	).toBeLessThan(1000000);
	expect(validateFrameAuthoringDocument(near).canSave).toBe(false);
});
it("bounds repeated input expansion before building an oversized template", () => {
	expect(() =>
		renderFrameTemplate(
			{
				...document,
				blocks: [
					{
						id: "main",
						type: "markdown",
						content: "{{client}}".repeat(10000),
					},
				],
			},
			fields,
			{ client: "x".repeat(10000) },
		),
	).toThrow(/exceeds 1 MB/);
});

it("uses browser HTML parsing for malformed end tags and malformed attribute names", () => {
	const unsafe = [
		'<!doctype html><html><head></head><body>a<body onclick="{{client}}">b</body></html>',
		'<!doctype html><html><head></head><body>a<html onclick="{{client}}">b</body></html>',
		'<!doctype html><html><head></head><body>a<body title="safe" data-discarded="{{client}}">b</body></html>',
		'<div>a<body onclick="{{client}}">b</div>',
		'<table>a<tr title="{{client}}"><td>b</td></tr></table>',
		"<script>// </ script>\n{{client}}\n</script>",
		'<button a" onclick="/* > */ {{client}}">Click</button>',
		"<button a' onclick='/* > */ {{client}}'>Click</button>",
	];
	for (const content of unsafe)
		expect(() =>
			renderFrameTemplate(
				{
					...document,
					blocks: [{ id: "main", type: "html", content }],
				},
				fields,
				{ client: "alert(1)" },
			),
		).toThrow();
});
