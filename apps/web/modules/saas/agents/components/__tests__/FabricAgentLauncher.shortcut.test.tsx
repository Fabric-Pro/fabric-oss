/**
 * The Fabric Agent launcher shows a keyboard-shortcut label ("⌘J" on macOS,
 * "Ctrl+J" elsewhere). The label is derived from `navigator.platform`, which
 * only exists on the client — so it must NOT be read during the initial
 * render. The server has no `navigator` and renders "Ctrl+J"; if a macOS
 * client's first render produced "⌘J", the text would mismatch and React
 * throws hydration error #418 on every /app page (the launcher is global).
 *
 * Contract: SSR + first client render are always the neutral fallback, and
 * the platform-specific label appears only after mount.
 */

import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { useShortcutLabel } from "../FabricAgentLauncher";

const originalPlatform = Object.getOwnPropertyDescriptor(
	window.navigator,
	"platform",
);

function setPlatform(value: string) {
	Object.defineProperty(window.navigator, "platform", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(window.navigator, "platform", originalPlatform);
	}
});

function ShortcutProbe() {
	return <span data-testid="shortcut">{useShortcutLabel()}</span>;
}

describe("useShortcutLabel — hydration-safe keyboard shortcut", () => {
	it("renders the neutral label during SSR even on macOS (no #418 mismatch)", () => {
		setPlatform("MacIntel");
		// renderToStaticMarkup mirrors the server: no effects run, so the
		// markup must equal what a macOS client paints on its first render.
		const html = renderToStaticMarkup(<ShortcutProbe />);
		expect(html).toContain("Ctrl+J");
		expect(html).not.toContain("⌘J");
	});

	it("upgrades to the macOS label after mount", async () => {
		setPlatform("MacIntel");
		const { findByTestId } = render(<ShortcutProbe />);
		expect((await findByTestId("shortcut")).textContent).toBe("⌘J");
	});

	it("keeps Ctrl+J after mount on non-mac platforms", async () => {
		setPlatform("Win32");
		const { findByTestId } = render(<ShortcutProbe />);
		expect((await findByTestId("shortcut")).textContent).toBe("Ctrl+J");
	});
});
