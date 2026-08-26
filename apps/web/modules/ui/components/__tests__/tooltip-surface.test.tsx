import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { Button } from "../button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

// Radix Tooltip internals use ResizeObserver; jsdom does not provide one.
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.releasePointerCapture === "undefined") {
		Element.prototype.releasePointerCapture = () => {};
	}
	if (typeof Element.prototype.setPointerCapture === "undefined") {
		Element.prototype.setPointerCapture = () => {};
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => {};
	}
});

async function openTooltip(
	content: React.ReactNode,
	props: React.ComponentProps<typeof TooltipContent> = {},
) {
	const user = userEvent.setup({ delay: null });
	render(
		<Tooltip delayDuration={0}>
			<TooltipTrigger asChild>
				<Button>trigger</Button>
			</TooltipTrigger>
			<TooltipContent {...props}>{content}</TooltipContent>
		</Tooltip>,
	);

	await user.hover(screen.getByRole("button", { name: "trigger" }));
	await waitFor(() => {
		expect(
			document.querySelector('[data-slot="tooltip-content"]'),
		).not.toBeNull();
	});

	return document.querySelector(
		'[data-slot="tooltip-content"]',
	) as HTMLElement;
}

describe("TooltipContent width contract", () => {
	it("applies a default max-width so long copy cannot span the viewport", async () => {
		const el = await openTooltip(
			"Create a single test work item in the connected PM tool to verify the MCP connection, credentials, and board selection.",
		);

		expect(el.className).toContain("max-w-[min(90vw,20rem)]");
	});

	it("lets a call site override the default max-width via tailwind-merge", async () => {
		const el = await openTooltip("A deliberately wider tooltip", {
			className: "max-w-[min(90vw,640px)]",
		});

		// tailwind-merge must drop the base cap entirely, not stack both.
		expect(el.className).toContain("max-w-[min(90vw,640px)]");
		expect(el.className).not.toContain("max-w-[min(90vw,20rem)]");
	});

	it("fills each line rather than balancing to short ragged lines", async () => {
		const el = await openTooltip("Some reasonably long tooltip copy here");

		expect(el.className).toContain("text-pretty");
		expect(el.className).not.toContain("text-balance");
	});
});

describe("TooltipContent colour-token contract", () => {
	// The inverse surface paints --foreground as its background, so any child
	// carrying an ordinary theme token would resolve against the page palette
	// and fail WCAG AA. The primitive re-points Tailwind's --color-* namespace
	// so those children stay legible without changing their call sites.
	it("remaps theme colour tokens on the inverse surface", async () => {
		const el = await openTooltip(
			<span className="text-muted-foreground">muted child</span>,
		);

		expect(el.style.getPropertyValue("--color-foreground")).toBe(
			"var(--background)",
		);
		expect(el.style.getPropertyValue("--color-muted-foreground")).toBe(
			"color-mix(in srgb, var(--background) 72%, var(--foreground))",
		);
	});

	it("remaps accent tokens too, since they are equally unreadable inverted", async () => {
		const el = await openTooltip(
			<span className="text-highlight">warning child</span>,
		);

		for (const token of [
			"--color-primary",
			"--color-highlight",
			"--color-destructive",
			"--color-secondary",
			"--color-success",
		]) {
			expect(el.style.getPropertyValue(token)).toContain("color-mix");
		}
	});

	it("targets the --color-* namespace, never the raw theme variables", async () => {
		const el = await openTooltip("plain copy");

		// Tailwind v4 resolves `--color-muted-foreground: var(--muted-foreground)`
		// once at :root, so overriding the raw token here would be a silent no-op.
		expect(el.style.getPropertyValue("--muted-foreground")).toBe("");
		expect(el.style.getPropertyValue("--foreground")).toBe("");
	});

	it("leaves the popover surface on the native theme palette", async () => {
		const el = await openTooltip(
			<span className="text-muted-foreground">muted child</span>,
			{ surface: "popover" },
		);

		// The popover surface is already theme-native; remapping would invert it
		// a second time and undo the fix.
		expect(el.style.getPropertyValue("--color-muted-foreground")).toBe("");
		expect(el.className).toContain("bg-popover");
	});

	// These are structural assertions on purpose. jsdom does not resolve `var()`,
	// so a computed-colour test here would pass even when the surface is painting
	// itself invisible — that is exactly how the 1.00:1 regression this pins got
	// through the first time. Asserting *which namespace* the surface reads is the
	// strongest guard available in this environment; the real-browser equivalent
	// belongs in `apps/web/tests/contextual-tooltips.spec.ts`.
	it("paints the inverse surface outside the remapped --color-* namespace", async () => {
		const el = await openTooltip("plain copy");

		// `bg-foreground` compiles to `var(--color-foreground)`, which the overrides
		// re-point on this same element — the surface would repaint itself with its
		// own text colour.
		expect(el.className).toContain("bg-[var(--foreground)]");
		expect(el.className).toContain("text-[var(--background)]");
		expect(el.className).not.toMatch(/(^|\s)bg-foreground(\s|$)/);
		expect(el.className).not.toMatch(/(^|\s)text-background(\s|$)/);
	});

	it("paints the arrow outside the remapped namespace too", async () => {
		const el = await openTooltip("plain copy");
		const arrow = el.querySelector("svg");

		// The arrow is a descendant, so it inherits the remapped custom property.
		expect(arrow).not.toBeNull();
		expect(arrow?.getAttribute("class") ?? "").toContain(
			"fill-[var(--foreground)]",
		);
		expect(arrow?.getAttribute("class") ?? "").not.toMatch(
			/(^|\s)fill-foreground(\s|$)/,
		);
	});

	it("never remaps --color-background, which the surface reads for its text", async () => {
		const el = await openTooltip("plain copy");

		expect(el.style.getPropertyValue("--color-background")).toBe("");
	});

	it("lets a call-site style prop win over the remapped tokens", async () => {
		const el = await openTooltip("plain copy", {
			style: { "--color-foreground": "red" } as React.CSSProperties,
		});

		expect(el.style.getPropertyValue("--color-foreground")).toBe("red");
		// Unrelated overrides survive the merge.
		expect(el.style.getPropertyValue("--color-muted-foreground")).toContain(
			"color-mix",
		);
	});
});
