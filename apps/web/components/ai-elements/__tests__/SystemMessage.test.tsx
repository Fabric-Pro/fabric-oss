/**
 * Tests for `<SystemMessage>` — Fizzy #1412 PR1.
 *
 * The renderer for `role: "system"` operation-result messages. Editorial
 * style (uppercase SYSTEM label, vertical red bar, warm muted surface,
 * markdown body, deep-link as plain `<a>`).
 *
 * Critical contract:
 *   - NO `aria-live` attribute on the message itself. Historical loads
 *     would otherwise re-announce stale results when the SSE-driven
 *     query invalidates. A separate (mounted higher up in the tree)
 *     aria-live region — owned by `useConversationRealtime` — handles
 *     fresh arrival announcements.
 *   - Renders the deep link with `rel="noopener"` (no external nav
 *     hijacks) and `target="_blank"` (chats often open in narrow
 *     side-panels; opening artifacts inline would lose context).
 *   - Icon (✓ or ✕) reflects outcome — present in DOM regardless of
 *     theme.
 *   - I3 contract: the artifact link is rendered as a SEPARATE element,
 *     not inlined into the body markdown. Callers pass `content`
 *     containing only the header + summary; `artifact` is rendered
 *     after the body. A body that legitimately ends with its own
 *     markdown link MUST survive untouched (no over-stripping).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SystemMessage } from "../SystemMessage";

describe("<SystemMessage>", () => {
	it("renders the editorial SYSTEM label", () => {
		render(
			<SystemMessage
				outcome="success"
				content={"SYSTEM\n\nOperation completed."}
			/>,
		);
		expect(screen.getByText(/system/i)).toBeDefined();
	});

	it("renders the message content in the body region", () => {
		render(
			<SystemMessage
				outcome="success"
				content={"SYSTEM\n\nAll documents generated."}
			/>,
		);
		expect(screen.getByText(/All documents generated/i)).toBeDefined();
	});

	it("does NOT have aria-live on the root — historical loads must not re-announce", () => {
		const { container } = render(
			<SystemMessage outcome="success" content={"SYSTEM\n\nDone."} />,
		);
		const liveEls = container.querySelectorAll("[aria-live]");
		expect(liveEls.length).toBe(0);
	});

	it("renders an artifact link as a real <a> with rel=noopener, sourced from metadata only", () => {
		// Note: the content does NOT contain the link (I3 — formatter no
		// longer inlines artifact links into content). The link is
		// supplied structurally via the `artifact` prop.
		render(
			<SystemMessage
				outcome="success"
				content={"SYSTEM\n\nDone."}
				artifact={{
					label: "View PRD",
					url: "https://fabric.pro/app/acme/projects/p1/docs/d1",
				}}
			/>,
		);
		const link = screen.getByRole("link", { name: /View PRD/i });
		expect(link).toBeDefined();
		expect(link.getAttribute("href")).toBe(
			"https://fabric.pro/app/acme/projects/p1/docs/d1",
		);
		expect(link.getAttribute("rel") ?? "").toMatch(/noopener/);
	});

	it("omits the link region when no artifact provided", () => {
		render(<SystemMessage outcome="success" content={"SYSTEM\n\nDone."} />);
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("preserves a body that legitimately ends with a markdown link AND renders the artifact separately (I3 regression)", () => {
		// Prior revisions stripped any trailing `\n\n[Label](URL)` from
		// the body via regex when an artifact was supplied — that
		// over-matched any caller-supplied summary ending in a markdown
		// link. The fix: the formatter no longer inlines the artifact
		// link into content, so the component can render body markdown
		// untouched and place the artifact in its own block.
		const body =
			"Summary text — see [related docs](https://example.com/docs)";
		render(
			<SystemMessage
				outcome="success"
				content={`SYSTEM\n\n${body}`}
				artifact={{
					label: "Open primary artifact",
					url: "https://fabric.pro/app/projects/p1/docs/d1",
				}}
			/>,
		);
		// The body text — including its trailing markdown link source —
		// survives untouched. We render the body as plain text in PR1
		// (markdown rendering is a follow-up); a substring match is
		// sufficient.
		expect(
			screen.getByText(/Summary text — see \[related docs]/i),
		).toBeDefined();
		// The artifact link IS rendered, as a separate element.
		const artifactLink = screen.getByRole("link", {
			name: /Open primary artifact/i,
		});
		expect(artifactLink.getAttribute("href")).toBe(
			"https://fabric.pro/app/projects/p1/docs/d1",
		);
	});

	it("shows a success indicator for outcome='success'", () => {
		const { container } = render(
			<SystemMessage outcome="success" content={"SYSTEM\n\nDone."} />,
		);
		// The icon is data-marked so the test doesn't have to grep on
		// glyph identity (✓ might be swapped for an SVG later).
		const indicator = container.querySelector(
			'[data-outcome-indicator="success"]',
		);
		expect(indicator).not.toBeNull();
	});

	it("shows a failure indicator for outcome='failure'", () => {
		const { container } = render(
			<SystemMessage outcome="failure" content={"SYSTEM\n\nFailed."} />,
		);
		const indicator = container.querySelector(
			'[data-outcome-indicator="failure"]',
		);
		expect(indicator).not.toBeNull();
	});

	it("shows a distinct indicator for cancelled outcome", () => {
		const { container } = render(
			<SystemMessage
				outcome="cancelled"
				content={"SYSTEM\n\nCancelled."}
			/>,
		);
		const indicator = container.querySelector(
			'[data-outcome-indicator="cancelled"]',
		);
		expect(indicator).not.toBeNull();
	});

	it("tags the root with data-outcome so styling/tests key off outcome, not glyph", () => {
		const { container } = render(
			<SystemMessage outcome="failure" content={"SYSTEM\n\nFailed."} />,
		);
		const root = container.querySelector(
			'[data-message-kind="operation_result"]',
		);
		expect(root?.getAttribute("data-outcome")).toBe("failure");
	});
});
