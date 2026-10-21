import { describe, expect, it } from "vitest";
import { changeItemSchema } from "../change-item-schema";

const update = {
	type: "feature",
	action: "update",
	title: { to: "Example update" },
};

describe("approval merge annotations", () => {
	it.each([true, false])(
		"forwards the deferred flag (%s) through the shared approval schema",
		(bodyMergeDeferred) => {
			expect(
				changeItemSchema.parse({ ...update, bodyMergeDeferred })
					.bodyMergeDeferred,
			).toBe(bodyMergeDeferred);
		},
	);
	it("keeps legacy approvals without a deferred annotation", () => {
		expect(changeItemSchema.parse(update)).not.toHaveProperty(
			"bodyMergeDeferred",
		);
	});
});
