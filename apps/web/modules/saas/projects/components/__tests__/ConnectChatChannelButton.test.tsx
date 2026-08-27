/**
 * The route from "select a chat channel" to "link a chat channel".
 *
 * WHY THIS EXISTS. Three project-settings pickers let a project tick which
 * linked Teams/Slack channels receive something; none of them can link one.
 * Each carried its own copy of a "Connect a channel" button rendered ONLY in
 * its empty-state branch — the branch a project with channels never renders —
 * so linking a first channel removed every route to a second.
 *
 * The last case here is a source-level pin rather than a render. Mounting
 * `ProjectSettings` means standing up orpc, next/navigation, next-intl and a
 * dozen child cards for two attributes, and the wiring it guards fails
 * SILENTLY: `scrollToChatMonitors` is deliberately forgiving of a missing
 * anchor, so dropping the id degrades to a no-op that no render test would
 * notice. `get-started/drift.test.ts` pins its anchors the same way.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CHAT_MONITORS_SECTION_ID,
	ConnectChatChannelButton,
	scrollToChatMonitors,
} from "../ConnectChatChannelButton";

afterEach(() => {
	document.body.replaceChildren();
	// jsdom has no matchMedia; cases that need one install it themselves and
	// must not leak it into the next case's default-motion assumption.
	Reflect.deleteProperty(window, "matchMedia");
});

/** Returns the stub so a case can assert the options it was handed. */
function anchorWithScrollSpy(id = CHAT_MONITORS_SECTION_ID) {
	const el = document.createElement("div");
	el.id = id;
	const spy = vi.fn();
	el.scrollIntoView = spy;
	document.body.append(el);
	return spy;
}

describe("ConnectChatChannelButton", () => {
	it("renders nothing when the host cannot navigate", () => {
		const { container } = render(<ConnectChatChannelButton />);
		expect(container).toBeEmptyDOMElement();
	});

	it("calls the host's navigation when clicked", async () => {
		const onNavigate = vi.fn();
		render(<ConnectChatChannelButton onNavigate={onNavigate} />);

		await userEvent.click(
			screen.getByRole("button", { name: /connect a channel/i }),
		);
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});
});

describe("scrollToChatMonitors", () => {
	it("brings the anchored section into view", () => {
		const spy = anchorWithScrollSpy();

		scrollToChatMonitors();

		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ behavior: "smooth", block: "start" }),
		);
	});

	it("does nothing when the anchor is absent", () => {
		// The Knowledge tab may not be mounted, and a settings page that throws
		// on a scroll is a worse outcome than one that does not scroll.
		expect(() => scrollToChatMonitors()).not.toThrow();
	});

	it("does not animate for a reader who asked for reduced motion", () => {
		// WCAG 2.1 AA — persistent and triggered motion both respect the
		// preference. `behavior: "auto"` still moves the viewport; it just
		// stops smooth-scrolling there.
		window.matchMedia = vi.fn().mockReturnValue({ matches: true });
		const spy = anchorWithScrollSpy();

		scrollToChatMonitors();

		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ behavior: "auto" }),
		);
	});
});

describe("ProjectSettings wiring", () => {
	const source = readFileSync(
		resolve(__dirname, "../ProjectSettings.tsx"),
		"utf8",
	);

	it("puts the scroll anchor on the chat-monitor section", () => {
		expect(source).toContain("id={CHAT_MONITORS_SECTION_ID}");
	});

	it("keeps the onboarding target as a SEPARATE attribute", () => {
		// One element, two attributes, two owners. Collapsing them would make a
		// Get Started rename break this navigation while its own drift test
		// stayed green — the rename is only checked against the registry.
		expect(source).toContain(
			'data-onboarding-target="settings-chat-monitors"',
		);
	});

	it("hands both channel-selecting cards a way to reach setup", () => {
		// Two: the newsletter card (release notes + review alerts) and the
		// publishing card (topic suggestions). One would mean a half-fix.
		const wired = source.match(
			/onNavigateToChatChannels=\{navigateToChatChannels\}/g,
		);
		expect(wired).toHaveLength(2);
	});
});
