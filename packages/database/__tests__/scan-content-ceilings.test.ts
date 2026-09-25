import { describe, expect, it } from "vitest";
import {
	applyScanItemCeilings,
	type ScanContentItem,
} from "../prisma/queries/projects/scan";

/** Temporal's per-payload error limit (TMPRL1103). */
const TEMPORAL_PAYLOAD_LIMIT = 2_097_152;

function items(count: number, textChars: number): ScanContentItem[] {
	return Array.from({ length: count }, (_, i) => ({
		key: `F-${i + 1}`,
		label: `Feature F-${i + 1} (FEATURE): Item ${i + 1}`,
		text: "x".repeat(textChars),
	}));
}

function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe("applyScanItemCeilings", () => {
	it("keeps a project like the one whose prod scan failed under Temporal's payload limit", () => {
		// Fizzy #2502: 458 items of ~11.7 KB; the 200 kept by the item ceiling
		// alone serialized to 2,341,768 bytes and every gather retry was rejected.
		const gathered = items(458, 11_600);
		expect(serializedBytes(gathered.slice(0, 200))).toBeGreaterThan(
			TEMPORAL_PAYLOAD_LIMIT,
		);

		const { items: kept, truncatedItemCount } =
			applyScanItemCeilings(gathered);

		expect(serializedBytes({ projectName: "P", items: kept })).toBeLessThan(
			TEMPORAL_PAYLOAD_LIMIT,
		);
		// Both scanner inputs carry the items and go out in one workflow task.
		expect(serializedBytes([kept, kept])).toBeLessThan(4 * 1024 * 1024);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept[0].key).toBe("F-1");
		expect(kept.length + truncatedItemCount).toBe(458);
	});

	it("still applies the item-count ceiling to many small items", () => {
		const { items: kept, truncatedItemCount } = applyScanItemCeilings(
			items(250, 100),
		);
		expect(kept).toHaveLength(200);
		expect(truncatedItemCount).toBe(50);
	});

	it("keeps everything when both ceilings are clear", () => {
		const gathered = items(30, 2_000);
		const result = applyScanItemCeilings(gathered);
		expect(result.items).toEqual(gathered);
		expect(result.truncatedItemCount).toBe(0);
	});

	it("counts multi-byte text by its encoded size, not its length", () => {
		const { items: kept } = applyScanItemCeilings(items(200, 3_900));
		const multiByte = applyScanItemCeilings(
			items(200, 3_900).map((item) => ({
				...item,
				text: "€".repeat(item.text.length),
			})),
		);
		expect(multiByte.items.length).toBeLessThan(kept.length);
		expect(serializedBytes(multiByte.items)).toBeLessThan(
			TEMPORAL_PAYLOAD_LIMIT,
		);
	});
});
