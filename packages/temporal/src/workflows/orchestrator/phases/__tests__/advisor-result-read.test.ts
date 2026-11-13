import { describe, expect, it, vi } from "vitest";
import {
	advisorResultReadsEnabled,
	exactResultHead,
	extractMcpResultText,
	RESULT_READ_TOOL,
	readAdvisorResult,
	recordedResultForPresentation,
	resultReadPlaceholder,
	resultReadRecord,
	resultRef,
	resultRefCatalog,
} from "../../advisor-result-read";

const calls = (text: unknown, name = "example_read") => [
	{
		id: "duplicate",
		name,
		args: {},
		status: "success" as const,
		durationMs: 1,
		result: text,
	},
];
const unavailable = '{"v":1,"status":"unavailable"}';

describe("run-local result reads", () => {
	it.each([
		[{}, false, 0],
		[{ turnId: "" }, false, 0],
		[{ turnId: "turn-example" }, true, 1],
	] as const)("gates once with input %j", (input, enabled, count) => {
		const marker = vi.fn(() => true);
		expect(advisorResultReadsEnabled(input, marker)).toBe(enabled);
		expect(marker).toHaveBeenCalledTimes(count);
	});
	it("obeys an absent marker", () => {
		expect(advisorResultReadsEnabled({ turnId: "t" }, () => false)).toBe(
			false,
		);
	});
	it.each(["enabled", "other"])(
		"ignores obsolete workflow input %s",
		(value) => {
			const legacyInput = { turnId: "turn-example", resultReads: value };
			expect(advisorResultReadsEnabled(legacyInput, () => true)).toBe(
				true,
			);
			expect(advisorResultReadsEnabled(legacyInput, () => false)).toBe(
				false,
			);
		},
	);
	it("uses the original MCP text projection", () => {
		expect(
			extractMcpResultText({
				content: [
					{ type: "text", text: "a" },
					{ type: "image" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\nb");
		expect(extractMcpResultText({ content: [] })).toBe('{"content":[]}');
		expect(extractMcpResultText("plain")).toBe("plain");
	});
	it.each([
		"load_skill",
		"read_skill_file",
		"get_tool_schema",
		"advisor_result_read",
	])("does not expose %s", (name) => {
		expect(resultRef(calls("secret", name), 0)).toBeUndefined();
		expect(
			readAdvisorResult(calls("secret", name), { ref: "r1" }, 32_000),
		).toBe(unavailable);
	});
	it("uses ordinals even with duplicate provider ids", () => {
		const recorded = [...calls("first"), ...calls("second")];
		expect(resultRef(recorded, 1)).toBe("r2");
		expect(
			JSON.parse(readAdvisorResult(recorded, { ref: "r2" }, 32_000)).text,
		).toBe("second");
	});
	it.each([
		null,
		[],
		"r1",
		{},
		{ ref: 1 },
		{ ref: "r1", extra: true },
		{ ref: "r0" },
		{ ref: "r01" },
		{ ref: "r2" },
		{ ref: "r1x" },
		{ ref: "r9007199254740992" },
		{ ref: "r1", offset: -1 },
		{ ref: "r1", offset: 0.5 },
		{ ref: "r1", offset: "0" },
		{ ref: "r1", offset: Number.NaN },
		{ ref: "r1", offset: 100 },
		{ ref: "r1", limit: "1" },
		{ ref: "r1", limit: 1.5 },
		{ ref: "r1", limit: Number.POSITIVE_INFINITY },
	])("returns one content-free answer for %j", (args) => {
		expect(readAdvisorResult(calls("abc"), args, 32_000)).toBe(unavailable);
	});
	it("rejects arrays and callable objects even if they carry a valid ref", () => {
		for (const args of [
			Object.assign([], { ref: "r1" }),
			Object.assign(() => {}, { ref: "r1" }),
		]) {
			expect(readAdvisorResult(calls("abc"), args, 32_000)).toBe(
				unavailable,
			);
		}
	});
	it("refuses an envelope whose metadata alone exceeds the cap", () => {
		expect(
			readAdvisorResult(
				calls("abc", "x".repeat(40_000)),
				{ ref: "r1" },
				32_000,
			),
		).toBe(unavailable);
	});
	it.each(["a\udc00", "\ue000\udc00", "\ud800a", "\ud800\ue000"])(
		"keeps boundaries that are not surrogate pairs: %j",
		(text) => {
			const page = JSON.parse(
				readAdvisorResult(calls(text), { ref: "r1", limit: 1 }, 32_000),
			);
			expect(page.text).toBe(text.slice(0, 1));
			expect(page.nextOffset).toBe(1);
		},
	);

	it("rejects offsets inside a surrogate pair", () => {
		expect(
			readAdvisorResult(calls("a😀b"), { ref: "r1", offset: 2 }, 32_000),
		).toBe(unavailable);
	});
	it("moves head and page ends back when the requested end splits a pair", () => {
		const page = JSON.parse(
			readAdvisorResult(calls("😀b"), { ref: "r1", limit: 1 }, 32_000),
		);
		expect(page.text).toBe("");
		expect(page.nextOffset).toBe(0);
		for (const cap of [300, 301, 302, 303]) {
			const head = exactResultHead("😀".repeat(1000), "r1", cap);
			const text = head.slice(0, head.indexOf("\n\n[Host note:"));
			expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
			expect(text.length % 2).toBe(0);
		}
	});

	it("defaults and clamps integer limits, and ends without nextOffset", () => {
		const recorded = calls("x".repeat(40_000));
		for (const [limit, expected] of [
			[undefined, 16_000],
			[0, 1],
			[-3, 1],
			[99_999, 24_000],
		] as const) {
			const page = JSON.parse(
				readAdvisorResult(
					recorded,
					{ ref: "r1", ...(limit === undefined ? {} : { limit }) },
					32_000,
				),
			);
			expect(page).toEqual({
				v: 1,
				ref: "r1",
				tool: "example_read",
				offset: 0,
				nextOffset: expected,
				totalCharacters: 40_000,
				text: "x".repeat(expected),
			});
		}
		expect(
			JSON.parse(
				readAdvisorResult(
					calls("abc"),
					{ ref: "r1", offset: 3 },
					32_000,
				),
			),
		).toEqual({
			v: 1,
			ref: "r1",
			tool: "example_read",
			offset: 3,
			totalCharacters: 3,
			text: "",
		});
	});
	it.each(["abc😀".repeat(20_000), '\u0000"\\\n😀'.repeat(20_000)])(
		"reassembles exact heads and serialized pages without splitting pairs",
		(text) => {
			const head = exactResultHead(text, "r1", 31_000);
			const split = head.indexOf("\n\n[Host note:");
			let assembled = head.slice(0, split);
			expect(head).toContain(
				`up to character ${assembled.length} of ${text.length}`,
			);
			expect(head.length).toBeLessThanOrEqual(31_000);
			while (assembled.length < text.length) {
				const encoded = readAdvisorResult(
					calls(text),
					{ ref: "r1", offset: assembled.length, limit: 24_000 },
					32_000,
				);
				expect(encoded.length).toBeLessThanOrEqual(31_488);
				const page = JSON.parse(encoded);
				expect(page.offset).toBe(assembled.length);
				expect(page.text).toBe(
					text.slice(page.offset, page.offset + page.text.length),
				);
				expect(page.text.length).toBeGreaterThan(0);
				expect(page.text).not.toMatch(/[\uD800-\uDFFF]/u);
				assembled += page.text;
				expect(page.nextOffset).toBe(
					assembled.length < text.length
						? assembled.length
						: undefined,
				);
			}
			expect(assembled).toBe(text);
		},
	);
	it.each([false, undefined])(
		"preserves a same-named external result with decision %s",
		(enabled) => {
			const result = { rows: ["External evidence"] };
			expect(
				recordedResultForPresentation(
					RESULT_READ_TOOL,
					result,
					enabled,
				),
			).toBe(result);
		},
	);
	it.each([
		{ v: 1, status: "success", ref: "r1", offset: 0 },
		{ v: 1, status: "unavailable" },
	])(
		"keeps read receipts out of presentation while preserving other results: %j",
		(result) => {
			expect(
				recordedResultForPresentation(RESULT_READ_TOOL, result, true),
			).toBeUndefined();
			expect(
				recordedResultForPresentation("example_read", result, true),
			).toBe(result);
		},
	);

	it("records page position and status without its text, including final and unavailable pages", () => {
		const recorded = calls("abc");
		expect(
			resultReadRecord(
				readAdvisorResult(recorded, { ref: "r1", limit: 1 }, 32_000),
			),
		).toStrictEqual({
			v: 1,
			status: "success",
			ref: "r1",
			tool: "example_read",
			offset: 0,
			nextOffset: 1,
			returnedCharacters: 1,
			totalCharacters: 3,
		});
		expect(
			resultReadRecord(
				readAdvisorResult(recorded, { ref: "r1", offset: 2 }, 32_000),
			),
		).toStrictEqual({
			v: 1,
			status: "success",
			ref: "r1",
			tool: "example_read",
			offset: 2,
			returnedCharacters: 1,
			totalCharacters: 3,
		});
		expect(
			resultReadRecord(
				readAdvisorResult(recorded, { ref: "r99" }, 32_000),
			),
		).toStrictEqual({ v: 1, status: "unavailable" });
	});

	it("bounds reference placeholders and catalogs without copying result bodies", () => {
		const text = "result-body-".repeat(10_000);
		expect(
			resultReadPlaceholder("example_read", text, "r1").length,
		).toBeLessThanOrEqual(300);
		expect(
			resultReadPlaceholder("x".repeat(4000), text, "r1").length,
		).toBeLessThanOrEqual(300);
		expect(resultReadPlaceholder("example_read", text, "r1")).toContain(
			'advisor_result_read {"ref":"r1"}',
		);
		const recorded = Array.from({ length: 40 }, () => calls(text)[0]);
		const catalog = resultRefCatalog(recorded);
		expect(catalog).toContain('"ref":"r40"');
		expect(catalog).toContain('"ref":"r11"');
		expect(catalog).not.toContain('"ref":"r10"');
		expect(catalog).not.toContain("result-body");
		expect(catalog.length).toBeLessThan(7_000);
		expect(
			resultRefCatalog(
				Array.from(
					{ length: 30 },
					() => calls(text, "x".repeat(4000))[0],
				),
			).length,
		).toBeLessThan(7000);
	});
});
