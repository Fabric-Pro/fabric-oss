import { describe, expect, it } from "vitest";
import { decideForcedToolChoice } from "../../activities/direct-chat/decide-forced-tool-choice";
import { detectRequestedFrameOutput } from "../frame-output-request";

const availableTools = {
	fabric_create_frame: {},
	fabric_create_slideshow: {},
	fabric_get_frame: {},
	fabric_edit_frame_block: {},
};
function choice(message: string, engine: "direct" | "advisor") {
	const output = detectRequestedFrameOutput(message, engine);
	return decideForcedToolChoice({
		forcedToolName:
			output === "frame"
				? "fabric_create_frame"
				: output === "slideshow"
					? "fabric_create_slideshow"
					: undefined,
		availableTools,
		thinkingEnabled: false,
	});
}
describe.each(["direct", "advisor"] as const)(
	"%s Frame output request",
	(engine) => {
		it.each([
			"Change this Frame presentation to INTERFACE.",
			"Make this dashboard match the reference.",
			"Update the wireframe from this screenshot.",
			"Fix the spacing in the current slideshow.",
			"Please revise the presentation.",
			"Do not create a new Frame; change this dashboard to match the reference.",
		])(
			"does not force a creation before reading an existing target: %s",
			(message) => {
				expect(detectRequestedFrameOutput(message, engine)).toBeNull();
				expect(choice(message, engine)).toBe("auto");
			},
		);
		it.each([
			"Create a new dashboard matching the reference.",
			"Build a new frame with the same navigation.",
			"Create a new dashboard, then update its labels.",
		])("retains explicit new interface creation: %s", (message) => {
			expect(choice(message, engine)).toEqual({
				type: "tool",
				toolName: "fabric_create_frame",
			});
		});

		it("honors the explicit Frame target when the design request includes a presentation mode", () => {
			const message =
				'Create a new Fabric Frame titled "Example generated interface" as a private project artifact. Use presentation INTERFACE. Copy the supplied source HTML into a single HTML block, preserving its structure, labels, spacing, Georgia typeface, color values and responsive rules. Do not add report typography or cover. No runtime tools, scripts, remote assets, publication or exports. The source is a design reference, not a rendered screenshot; do not claim a verified visual match or working navigation. After creation state the saved Frame ID and "Visual verification: not performed."';
			expect(detectRequestedFrameOutput(message, engine)).toBe("frame");
			expect(choice(message, engine)).toEqual({
				type: "tool",
				toolName: "fabric_create_frame",
			});
		});
		it("does not mistake a presentation setting for a slideshow request", () => {
			expect(
				detectRequestedFrameOutput(
					"Use presentation INTERFACE for the current output.",
					engine,
				),
			).toBeNull();
			expect(
				detectRequestedFrameOutput(
					"Create a Fabric Frame. Use presentation: DOCUMENT.",
					engine,
				),
			).toBe("frame");
		});
		it("retains new presentation creation", () => {
			expect(
				choice("Make a new presentation for the launch.", engine),
			).toEqual({ type: "tool", toolName: "fabric_create_slideshow" });
		});
		it("retains ordinary interactive dashboard creation", () => {
			expect(
				choice(
					"Build me an interactive dashboard for team metrics.",
					engine,
				),
			).toEqual({ type: "tool", toolName: "fabric_create_frame" });
		});
		it("keeps plain diagrams inline", () => {
			expect(
				choice(
					"Create a data visualization diagram of our delivery process.",
					engine,
				),
			).toBe("auto");
		});
	},
);
