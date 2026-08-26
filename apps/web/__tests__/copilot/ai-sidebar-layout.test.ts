/**
 * Regression guard for the AI assistant sidebar overlap bug.
 *
 * The CopilotKit assistant panel docks as a fixed 28rem right rail at
 * `@media (min-width: 640px)` (Tailwind's `sm`). The host pages reserve editor
 * space for it by shifting their fixed page-chrome wrapper's right edge, and
 * that reservation MUST begin at the same 640px breakpoint. It previously used
 * `md:` (768px), so for every viewport in the 640–767px band the panel was
 * docked while the editor still spanned full width beneath it — a 448px
 * overlap. This test pins the breakpoint so a regression back to `md:`/`lg:`/
 * `xl:` fails loudly instead of silently reopening the overlap band.
 */

import { AI_SIDEBAR_CONTENT_SHIFT_CLASS } from "@saas/shared/components/copilot/ai-sidebar-layout";
import { describe, expect, it } from "vitest";

describe("AI_SIDEBAR_CONTENT_SHIFT_CLASS", () => {
	it("engages at the sm breakpoint, matching CopilotKit's 640px dock point", () => {
		expect(AI_SIDEBAR_CONTENT_SHIFT_CLASS).toBe("sm:right-[28rem]");
	});

	it("does not regress to a larger breakpoint (the cause of the 640–767px overlap)", () => {
		expect(AI_SIDEBAR_CONTENT_SHIFT_CLASS).not.toMatch(/^(md|lg|xl|2xl):/);
	});
});
