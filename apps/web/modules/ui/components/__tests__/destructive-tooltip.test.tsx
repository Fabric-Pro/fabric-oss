import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { Button } from "../button";
import {
	DestructiveTooltip,
	type DestructiveTooltipCopy,
} from "../destructive-tooltip";

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

const defaultCopy: DestructiveTooltipCopy = {
	label: "Discard the current pipeline and regenerate from scratch.",
	warning: "Warning: this cannot be undone.",
};

// Radix v1.2.8 duplicates the tooltip content inside a VisuallyHidden sibling
// (with its own role="tooltip") for a11y. We own a visible <div role={...}> as
// the direct child of [data-slot="destructive-tooltip-content"]; query it by
// direct-child selector so the VisuallyHidden clone never matches.
function getVisibleContent(): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		'[data-slot="destructive-tooltip-content"]',
	);
}

function getVisibleRoleElement(): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		'[data-slot="destructive-tooltip-content"] > [role]',
	);
}

function expectVisibleRole(role: "tooltip" | "alert") {
	const roleEl = getVisibleRoleElement();
	expect(roleEl).not.toBeNull();
	expect(roleEl).toHaveAttribute("role", role);
	return roleEl as HTMLElement;
}

function renderTooltip(
	overrides: Partial<React.ComponentProps<typeof DestructiveTooltip>> = {},
) {
	return render(
		<DestructiveTooltip copy={defaultCopy} {...overrides}>
			<Button type="button">Start Fresh</Button>
		</DestructiveTooltip>,
	);
}

describe("DestructiveTooltip", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not open on mount", () => {
		renderTooltip();

		expect(getVisibleContent()).toBeNull();
	});

	it("opens on hover after 500ms with role=tooltip (not alert)", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderTooltip();

		await user.hover(screen.getByRole("button", { name: /start fresh/i }));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});

		expectVisibleRole("tooltip");
	});

	it("opens on keyboard focus after 500ms with role=alert", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderTooltip();

		await user.tab();

		expect(
			screen.getByRole("button", { name: /start fresh/i }),
		).toHaveFocus();

		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});

		expectVisibleRole("alert");
	});

	it("resets role after blur so a subsequent hover-open uses tooltip not alert", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(
			<>
				<DestructiveTooltip copy={defaultCopy}>
					<Button type="button">Start Fresh</Button>
				</DestructiveTooltip>
				<Button type="button">Other</Button>
			</>,
		);

		await user.tab();
		const trigger = screen.getByRole("button", { name: /start fresh/i });
		expect(trigger).toHaveFocus();

		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});
		expectVisibleRole("alert");

		await user.tab();
		await waitFor(() => {
			expect(getVisibleContent()).toBeNull();
		});

		await user.hover(trigger);

		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});
		expectVisibleRole("tooltip");
	});

	it("renders the AlertTriangle icon with aria-hidden=true", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderTooltip();

		await user.hover(screen.getByRole("button", { name: /start fresh/i }));
		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});

		const visible = expectVisibleRole("tooltip");
		const icon = visible.querySelector("svg");
		expect(icon).not.toBeNull();
		expect(icon).toHaveAttribute("aria-hidden", "true");
	});

	it("renders label and warning copy from props", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderTooltip();

		await user.hover(screen.getByRole("button", { name: /start fresh/i }));
		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});

		const visible = expectVisibleRole("tooltip");
		expect(
			within(visible).getByText(defaultCopy.label),
		).toBeInTheDocument();
		expect(
			within(visible).getByText(defaultCopy.warning),
		).toBeInTheDocument();
	});

	// The "Warning:" prefix is a copy contract enforced by the i18n sanity test
	// in Task 2.4. The component itself should render whatever warning string it's
	// given, so a non-prefixed string still renders correctly.
	it("renders a warning string that does not start with 'Warning:' verbatim", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const nonStandard: DestructiveTooltipCopy = {
			label: "Do the thing.",
			warning: "Heads up: consequences follow.",
		};
		render(
			<DestructiveTooltip copy={nonStandard}>
				<Button type="button">Action</Button>
			</DestructiveTooltip>,
		);

		await user.hover(screen.getByRole("button", { name: /action/i }));
		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});

		const visible = expectVisibleRole("tooltip");
		expect(
			within(visible).getByText(nonStandard.warning),
		).toBeInTheDocument();
	});

	it("honors a delayDuration prop override", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderTooltip({ delayDuration: 1000 });

		await user.hover(screen.getByRole("button", { name: /start fresh/i }));

		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(getVisibleContent()).toBeNull();

		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(getVisibleContent()).not.toBeNull();
		});
		expectVisibleRole("tooltip");
	});
});
