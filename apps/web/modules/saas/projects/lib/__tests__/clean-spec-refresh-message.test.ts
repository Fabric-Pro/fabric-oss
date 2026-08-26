import { describe, expect, it } from "vitest";
import { buildCleanSpecRefreshMessage } from "../clean-spec-refresh-message";

describe("buildCleanSpecRefreshMessage (#1794, #1864)", () => {
	const PROMPT = "PROMPT_BODY_HERE";

	it("includes the instruction and the bound prompt content", () => {
		const msg = buildCleanSpecRefreshMessage("feature", PROMPT);
		expect(msg).toContain("Refresh the Full Spec for this feature");
		expect(msg).toContain("write_document_local");
		expect(msg).toContain(PROMPT);
	});

	it("reflects the work-item kind word", () => {
		expect(buildCleanSpecRefreshMessage("bug", PROMPT)).toContain(
			"Refresh the Full Spec for this bug",
		);
	});

	// #1864: connected context is delivered to the model via the `rag context`
	// readable, never inlined into the visible chat message — so no raw
	// transcript is ever posted for the product owner to see.
	it("never embeds a raw context block in the message", () => {
		const msg = buildCleanSpecRefreshMessage("feature", PROMPT);
		expect(msg).not.toContain("--- Context 1 ---");
		expect(msg).not.toContain("has been retrieved for you below");
	});

	it("tells the agent the context was provided out-of-band", () => {
		const msg = buildCleanSpecRefreshMessage("feature", PROMPT);
		expect(msg).toContain("connected project context");
	});
});
