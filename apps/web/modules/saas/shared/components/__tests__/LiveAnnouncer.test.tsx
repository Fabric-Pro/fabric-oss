/**
 * Unit tests for the shared live-region pair behind every upload refusal.
 *
 * The mechanism under test is one line of `useLiveAnnouncer`:
 *
 *   setAnnouncement(prev => prev === message ? `${message} ` : message)
 *
 * Announcing the identical string twice is the common case, not an edge one —
 * a user who drags the wrong file in drags it in again — and React bails out of
 * a state update to an identical value, so without the toggle the text node is
 * never touched, no mutation reaches the accessibility tree, and the second
 * refusal is silent while staying perfectly visible on screen. The tests below
 * therefore assert on raw `textContent`: RTL's `toHaveTextContent` normalises
 * whitespace and would report the toggled and untoggled strings as equal,
 * passing against the exact regression this guards.
 */

import {
	LiveAnnouncerRegion,
	useLiveAnnouncer,
} from "@saas/shared/components/LiveAnnouncer";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

const TEST_ID = "test-announcer";
const REFUSAL = "archive.zip is not a supported file type (application/zip).";
const OTHER_REFUSAL = "deck.pptx is not a supported file type.";

/**
 * The shape every consumer uses: the region mounted unconditionally with the
 * surface, written to afterwards. Buttons stand in for the refusal paths.
 */
function AnnouncingSurface() {
	const { announcement, announce, clearAnnouncement } = useLiveAnnouncer();
	return (
		<div>
			<button type="button" onClick={() => announce(REFUSAL)}>
				refuse
			</button>
			<button type="button" onClick={() => announce(OTHER_REFUSAL)}>
				refuse other
			</button>
			<button type="button" onClick={clearAnnouncement}>
				reset
			</button>
			<LiveAnnouncerRegion
				announcement={announcement}
				data-testid={TEST_ID}
			/>
		</div>
	);
}

function regionText(): string {
	return screen.getByTestId(TEST_ID).textContent ?? "";
}

describe("useLiveAnnouncer", () => {
	it("mounts an empty polite region before anything is announced", () => {
		render(<AnnouncingSurface />);

		const region = screen.getByTestId(TEST_ID);
		expect(region).toHaveAttribute("aria-live", "polite");
		// Atomic, so the whole message is re-read rather than only the diff —
		// which for a repeat is a single space.
		expect(region).toHaveAttribute("aria-atomic", "true");
		expect(region.textContent).toBe("");
	});

	it("mutates the region text when the same message is announced twice", async () => {
		const user = userEvent.setup();
		render(<AnnouncingSurface />);

		const refuse = screen.getByRole("button", { name: "refuse" });

		await user.click(refuse);
		const first = regionText();
		expect(first).toBe(REFUSAL);

		await user.click(refuse);
		const second = regionText();

		// The assertion the mechanism exists for: identical words, different
		// DOM text. Without the toggle both reads return the same string and a
		// screen reader stays silent on the second refusal.
		expect(second).not.toBe(first);
		expect(second).toBe(`${REFUSAL} `);
		// What is spoken is unchanged — the difference is trailing whitespace,
		// which assistive technology collapses.
		expect(second.trim()).toBe(first);
	});

	it("keeps alternating so a third and fourth repeat also announce", async () => {
		const user = userEvent.setup();
		render(<AnnouncingSurface />);

		const refuse = screen.getByRole("button", { name: "refuse" });
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			await user.click(refuse);
			seen.push(regionText());
		}

		// Every announcement differs from the one before it — a toggle that
		// only fired once would leave the 2nd and 3rd reads identical.
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i]).not.toBe(seen[i - 1]);
		}
		// And every one of them says the same thing.
		for (const text of seen) {
			expect(text.trim()).toBe(REFUSAL);
		}
	});

	it("writes a different message verbatim, with no toggle applied", async () => {
		const user = userEvent.setup();
		render(<AnnouncingSurface />);

		await user.click(screen.getByRole("button", { name: "refuse" }));
		await user.click(screen.getByRole("button", { name: "refuse other" }));

		// A changed message already mutates the DOM on its own, so it must not
		// pick up padding.
		expect(regionText()).toBe(OTHER_REFUSAL);
	});

	it("empties the region on clear, and announces again afterwards", async () => {
		const user = userEvent.setup();
		render(<AnnouncingSurface />);

		const refuse = screen.getByRole("button", { name: "refuse" });

		await user.click(refuse);
		await user.click(screen.getByRole("button", { name: "reset" }));
		expect(regionText()).toBe("");

		// The region survives the reset — cleared, not unmounted — so the next
		// refusal is still an update to an existing node.
		expect(screen.getByTestId(TEST_ID)).toBeInTheDocument();

		await user.click(refuse);
		expect(regionText()).toBe(REFUSAL);
	});
});
