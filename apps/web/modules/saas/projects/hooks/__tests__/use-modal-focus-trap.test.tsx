/**
 * The modal focus trap, on a minimal panel: focus moves in on open — onto
 * the panel's first control, or onto the initial target a caller names, and
 * back there when something outside takes it — Tab wraps inside, Escape
 * closes, and on close focus goes back to the opener — or, when the opener
 * can no longer take it, to the fallback rather than the page body.
 *
 * The editor's regenerate confirmation pins the same behaviour against the
 * real editor (`DocumentEditor.web-research.test.tsx`); this covers the one
 * case jsdom cannot reach there: an opener still on the page and enabled
 * that refuses focus, the way a control hidden with `display:none` does.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalFocusTrap } from "../use-modal-focus-trap";

/**
 * Which element the caller names as the initial target: none (the hook's
 * default), the panel's Start button, nothing at all, or the opener outside
 * the panel.
 */
type InitialTarget = "default" | "start" | "missing" | "outside";

function Harness({ initial = "default" }: { initial?: InitialTarget }) {
	const [open, setOpen] = useState(false);
	const [openerDisabled, setOpenerDisabled] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const fallbackRef = useRef<HTMLDivElement>(null);
	const openerRef = useRef<HTMLButtonElement>(null);
	const startRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => setOpen(false), []);
	const initialFocus = {
		default: undefined,
		start: () => startRef.current,
		missing: () => null,
		outside: () => openerRef.current,
	}[initial];
	const { onKeyDown, rememberOpener } = useModalFocusTrap({
		open,
		panelRef,
		onEscape: close,
		fallbackFocus: () => fallbackRef.current,
		initialFocus,
	});
	return (
		<div ref={fallbackRef} tabIndex={-1} data-testid="fallback">
			<button
				ref={openerRef}
				type="button"
				disabled={openerDisabled}
				onClick={() => {
					rememberOpener();
					setOpen(true);
				}}
			>
				Open
			</button>
			{open && (
				<div
					ref={panelRef}
					role="dialog"
					aria-label="Panel"
					tabIndex={-1}
					onKeyDown={onKeyDown}
				>
					<button type="button">First</button>
					{/* Starts something that disables the opener, as a
					    confirmed Regenerate does. */}
					<button
						ref={startRef}
						type="button"
						onClick={() => {
							setOpen(false);
							setOpenerDisabled(true);
						}}
					>
						Start
					</button>
				</div>
			)}
		</div>
	);
}

function opener() {
	return screen.getByRole("button", { name: "Open" });
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
	await user.click(opener());
	return screen.getByRole("dialog", { name: "Panel" });
}

describe("useModalFocusTrap", () => {
	it("moves focus in on open, wraps Tab both ways, closes on Escape, and gives focus back to the opener", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await openPanel(user);
		const first = screen.getByRole("button", { name: "First" });
		const start = screen.getByRole("button", { name: "Start" });
		expect(first).toHaveFocus();

		await user.tab();
		expect(start).toHaveFocus();
		await user.tab();
		expect(first).toHaveFocus();
		await user.tab({ shift: true });
		expect(start).toHaveFocus();

		await user.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(opener()).toHaveFocus();
	});

	it("moves focus onto the initial target the caller names, back onto it when something outside takes it, and still wraps Tab", async () => {
		const user = userEvent.setup();
		render(<Harness initial="start" />);
		await openPanel(user);
		const first = screen.getByRole("button", { name: "First" });
		const start = screen.getByRole("button", { name: "Start" });
		expect(start).toHaveFocus();

		// Something outside takes focus, as a closing menu does.
		act(() => {
			opener().focus();
		});
		expect(start).toHaveFocus();

		await user.tab();
		expect(first).toHaveFocus();
		await user.tab({ shift: true });
		expect(start).toHaveFocus();

		await user.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(opener()).toHaveFocus();
	});

	it.each([
		["names nothing", "missing"],
		["names an element outside the panel", "outside"],
	] as const)(
		"moves focus onto the first control when the initial target %s",
		async (_label, initial) => {
			const user = userEvent.setup();
			render(<Harness initial={initial} />);
			await openPanel(user);

			expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
		},
	);

	it("gives focus to the fallback when what the panel started disabled the opener", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await openPanel(user);

		await user.click(screen.getByRole("button", { name: "Start" }));

		expect(opener()).toBeDisabled();
		expect(screen.getByTestId("fallback")).toHaveFocus();
	});

	it("gives focus to the fallback when the opener refuses it, as a hidden control does", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await openPanel(user);
		// jsdom has no layout, so a `display:none` opener is modelled by
		// what the browser does with it: focus() leaves focus where it was.
		vi.spyOn(opener(), "focus").mockImplementation(() => {});

		await user.keyboard("{Escape}");

		expect(screen.getByTestId("fallback")).toHaveFocus();
	});
});
