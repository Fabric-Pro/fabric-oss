import { describe, expect, it } from "vitest";
import { sidekickDisplayText } from "../sidekick-display-text";

describe("Sidekick assistant display projection", () => {
	it.each(["instructions", "metadata", "tools"])(
		"hides complete and streaming %s payloads",
		(tag) => {
			const opening = `<sidekick_apply_${tag}>`;
			expect(
				sidekickDisplayText(
					`Before${opening}\npayload\n</sidekick_apply_${tag}>After`,
				),
			).toBe("BeforeAfter");
			expect(
				sidekickDisplayText(`Before${opening}\npartial payload`),
			).toBe("Before");
			for (let end = "<sidekick_".length; end < opening.length; end++) {
				expect(
					sidekickDisplayText(`Before${opening.slice(0, end)}`),
				).toBe("Before");
			}
		},
	);
	it("keeps prose and suggestion directives while removing several execution blocks", () => {
		const directive = ":agent_suggestion[]{sId=example kind=tools}";
		expect(
			sidekickDisplayText(
				`${directive}<sidekick_apply_metadata>one</sidekick_apply_metadata> explanation <sidekick_apply_tools>two</sidekick_apply_tools>`,
			),
		).toBe(`${directive} explanation `);
	});
	it("preserves unknown tags and ordinary angle brackets", () => {
		const text =
			"1 < 2 <sidekick_apply_unknown>example</sidekick_apply_unknown>";
		expect(sidekickDisplayText(text)).toBe(text);
	});
});
