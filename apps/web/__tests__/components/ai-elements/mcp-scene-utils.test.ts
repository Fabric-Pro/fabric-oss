/**
 * Unit tests for the pure MCP-app parsing helpers.
 *
 * These helpers sit on the chat render path for Excalidraw diagrams.
 * The shapes asserted here are load-bearing across adapters:
 *
 *  - `create_view`'s tool schema declares `elements` as a JSON-encoded
 *    string (matching the upstream MCP server), so the string form MUST
 *    parse — the "Diagram has no elements." bug class came from the
 *    renderer accepting only real arrays.
 *  - Chat render paths hand `extractCheckpointId` a JSON *string*
 *    (`CopilotAssistantMessage` passes `JSON.stringify({checkpointId})`,
 *    the CopilotKit action renders pass the stringified handler result),
 *    while Nexus passes objects — both must resolve.
 */
import { describe, expect, it } from "vitest";
import {
	extractCheckpointId,
	normalizeToolArgs,
	parseExcalidrawAppState,
	parseExcalidrawElements,
} from "../../../components/ai-elements/mcp-scene-utils";

const ELEMENT = { id: "e1", type: "rectangle", x: 0, y: 0 };

describe("parseExcalidrawElements", () => {
	it("passes a non-empty array through", () => {
		expect(parseExcalidrawElements([ELEMENT])).toEqual([ELEMENT]);
	});

	it("parses a JSON-encoded string of a non-empty array (the tool-schema shape)", () => {
		expect(parseExcalidrawElements(JSON.stringify([ELEMENT]))).toEqual([
			ELEMENT,
		]);
	});

	it("rejects empty scenes in both forms", () => {
		expect(parseExcalidrawElements([])).toBeNull();
		expect(parseExcalidrawElements("[]")).toBeNull();
	});

	it("rejects non-array and unparseable input", () => {
		expect(parseExcalidrawElements("{}")).toBeNull();
		expect(parseExcalidrawElements('{"elements":[]}')).toBeNull();
		expect(parseExcalidrawElements("not json")).toBeNull();
		expect(parseExcalidrawElements(undefined)).toBeNull();
		expect(parseExcalidrawElements(null)).toBeNull();
		expect(parseExcalidrawElements(42)).toBeNull();
	});

	it("has no size cap — large legitimate diagrams pass", () => {
		const large = Array.from({ length: 500 }, (_, i) => ({
			...ELEMENT,
			id: `e${i}`,
		}));
		expect(parseExcalidrawElements(large)).toHaveLength(500);
		expect(parseExcalidrawElements(JSON.stringify(large))).toHaveLength(
			500,
		);
	});
});

describe("parseExcalidrawAppState", () => {
	it("passes an object through and parses a JSON string", () => {
		expect(
			parseExcalidrawAppState({ viewBackgroundColor: "#fff" }),
		).toEqual({ viewBackgroundColor: "#fff" });
		expect(
			parseExcalidrawAppState('{"viewBackgroundColor":"#fff"}'),
		).toEqual({ viewBackgroundColor: "#fff" });
	});

	it("returns undefined for arrays, garbage, and nullish input", () => {
		expect(parseExcalidrawAppState([1, 2])).toBeUndefined();
		expect(parseExcalidrawAppState("not json")).toBeUndefined();
		expect(parseExcalidrawAppState(null)).toBeUndefined();
		expect(parseExcalidrawAppState(undefined)).toBeUndefined();
	});
});

describe("normalizeToolArgs", () => {
	it("passes objects through and parses JSON-string wrappers", () => {
		expect(normalizeToolArgs({ a: 1 })).toEqual({ a: 1 });
		expect(normalizeToolArgs('{"a":1}')).toEqual({ a: 1 });
		// Double-encoded wrapper (seen on some adapter paths).
		expect(normalizeToolArgs(JSON.stringify('{"a":1}'))).toEqual({ a: 1 });
	});

	it("leaves nested JSON-string fields untouched (field-level parsing is the consumer's job)", () => {
		const args = { elements: JSON.stringify([ELEMENT]) };
		expect(normalizeToolArgs(args)).toEqual(args);
	});

	it("normalizes arrays, scalars, and nullish to undefined", () => {
		expect(normalizeToolArgs([1])).toBeUndefined();
		expect(normalizeToolArgs(7)).toBeUndefined();
		expect(normalizeToolArgs(null)).toBeUndefined();
		expect(normalizeToolArgs(undefined)).toBeUndefined();
		expect(normalizeToolArgs("not json")).toBeUndefined();
	});
});

describe("extractCheckpointId", () => {
	it("reads top-level ids from objects (both casings)", () => {
		expect(extractCheckpointId({ checkpointId: "cp-1" })).toBe("cp-1");
		expect(extractCheckpointId({ checkpoint_id: "cp-2" })).toBe("cp-2");
	});

	it("reads structuredContent ids", () => {
		expect(
			extractCheckpointId({
				structuredContent: { checkpointId: "cp-3" },
			}),
		).toBe("cp-3");
		expect(
			extractCheckpointId({
				structuredContent: { checkpoint_id: "cp-4" },
			}),
		).toBe("cp-4");
	});

	it("parses JSON-string input — the chat render-path shape", () => {
		// CopilotAssistantMessage passes exactly this.
		expect(
			extractCheckpointId(JSON.stringify({ checkpointId: "cp-5" })),
		).toBe("cp-5");
	});

	it("reads the __fabricMcpRender envelope id from the stringified invoke result", () => {
		// The named/wildcard useCopilotAction renders pass the handler's
		// stringified `/api/mcp-app/invoke` result; some results carry the
		// id only on the envelope the route stamps in.
		const invokeResult = JSON.stringify({
			content: [{ type: "text", text: "created view" }],
			__fabricMcpRender: {
				resourceUri: "ui://excalidraw/view",
				configId: "cfg-1",
				checkpointId: "cp-6",
				toolArgs: { elements: "[]" },
			},
		});
		expect(extractCheckpointId(invokeResult)).toBe("cp-6");
	});

	it("falls back to the content-block regex", () => {
		expect(
			extractCheckpointId({
				content: [{ type: "text", text: 'checkpoint_id: "cp-7"' }],
			}),
		).toBe("cp-7");
	});

	it("returns null for non-JSON strings and shapeless input", () => {
		expect(extractCheckpointId("not json")).toBeNull();
		expect(extractCheckpointId(null)).toBeNull();
		expect(extractCheckpointId(undefined)).toBeNull();
		expect(extractCheckpointId({ other: true })).toBeNull();
	});
});
