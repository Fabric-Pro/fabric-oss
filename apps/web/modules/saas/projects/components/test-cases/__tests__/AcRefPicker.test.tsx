/**
 * AcRefPicker, rendered.
 *
 * The sibling `ac-ref-picker-wiring.test.ts` only greps the component's
 * source text — it can prove a string like `"criteria.length === 0"` is
 * present, but not that the menu it guards actually lists the parsed
 * criteria, that a stale ref renders as anything in particular, or that the
 * free-text fallback commits what was typed. These tests render the real
 * component and assert on what actually reaches the screen.
 *
 * next-intl is overridden locally rather than relying on the global key-only
 * echo (vitest.setup.ts): the whole point of "assert the criterion text
 * appears" is seeing the interpolated `text` value inside the option, not
 * just the translation key.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				get: {
					queryOptions: (opts: unknown) => opts,
				},
			},
		},
	},
}));

// Echoes interpolation values into the returned string (`key:v1,v2`) instead
// of the global mock's bare key, so an option's rendered text carries the
// real criterion index/text rather than just "links.acOption".
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values ? `${key}:${Object.values(values).join(",")}` : key;
		t.raw = (key: string) => key;
		return t;
	},
}));

import { AcRefPicker } from "../AcRefPicker";

const baseProps = {
	projectId: "p1",
	organizationId: null as string | null,
	storyId: "s1",
	identifier: "F-1",
};

function storyQuery(acceptanceCriteria: string | null) {
	return { data: { story: { acceptanceCriteria } }, isPending: false };
}

const CRITERIA_MD = "- First criterion\n- Second criterion\n- Third criterion";

/** The menu trigger. Not a combobox any more — checkboxes need a menu. */
function getTriggerButton(): HTMLElement {
	return screen.getByRole("button");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AcRefPicker — story query pending", () => {
	it("renders a disabled read-only input showing the current values, never a menu", () => {
		// Swapping an editable input for a menu mid-edit drops whatever the
		// person was typing, because only the input commits on blur — the
		// component's own doc comment calls this out as the reason "pending"
		// must never share a branch with "no criteria".
		useQueryMock.mockReturnValue({ data: undefined, isPending: true });
		render(
			<AcRefPicker {...baseProps} values={["AC 2"]} onChange={vi.fn()} />,
		);

		const input = screen.getByRole("textbox");
		expect(input).toHaveValue("AC 2");
		expect(input).toBeDisabled();
		expect(input).toHaveAttribute("readonly");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});
});

describe("AcRefPicker — no parseable criteria", () => {
	/**
	 * A stateful wrapper, not a bare `values={[]}` render: the input is
	 * controlled, so without feeding `onChange` back in as the real caller
	 * (WorkItemLinkControl) does, React reverts each keystroke and the test
	 * would exercise nothing but its own harness.
	 */
	function ControlledFreeText({
		onCommit,
	}: {
		onCommit: (refs: string[]) => void;
	}) {
		const [values, setValues] = useState<string[]>([]);
		return (
			<AcRefPicker
				{...baseProps}
				values={values}
				onChange={setValues}
				onCommit={onCommit}
			/>
		);
	}

	it("renders an editable free-text input; onChange fires on typing, onCommit on blur", async () => {
		useQueryMock.mockReturnValue(storyQuery(""));
		const onCommit = vi.fn();
		render(<ControlledFreeText onCommit={onCommit} />);

		const input = screen.getByRole("textbox");
		await userEvent.type(input, "AC 5");
		expect(input).toHaveValue("AC 5");

		await userEvent.tab();
		expect(onCommit).toHaveBeenCalledWith(["AC 5"]);
	});

	it("splits a comma-separated free-text entry into several refs", async () => {
		// The fallback exists for specs the parser cannot read, and those cases
		// can still genuinely cover more than one criterion. Committing the raw
		// string as ONE ref would store "AC 1, AC 3" as a single unresolvable
		// reference, which resolves to criterion 1 and silently loses 3.
		useQueryMock.mockReturnValue(storyQuery(""));
		const onCommit = vi.fn();
		render(<ControlledFreeText onCommit={onCommit} />);

		await userEvent.type(screen.getByRole("textbox"), "AC 1, AC 3");
		await userEvent.tab();

		expect(onCommit).toHaveBeenCalledWith(["AC 1", "AC 3"]);
	});
});

describe("AcRefPicker — parent has parsed criteria", () => {
	it("lists the parent's real criteria as checkbox items", async () => {
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		render(<AcRefPicker {...baseProps} values={[]} onChange={vi.fn()} />);

		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

		await userEvent.click(getTriggerButton());

		expect(
			await screen.findByRole("menuitemcheckbox", {
				name: /First criterion/,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitemcheckbox", { name: /Second criterion/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitemcheckbox", { name: /Third criterion/ }),
		).toBeInTheDocument();
	});

	it.each([
		["AC 3", "the picker's own format"],
		["3", "a bare number written by hand before the picker existed"],
		["criterion 3", "the 'criterion N' shape existing rows also carry"],
	])(
		"shows criterion 3 as checked for a stored ref of %s (%s)",
		async (ref) => {
			// Matches by the number the ref RESOLVES to, not by string equality —
			// every legacy shape must still land on the same criterion.
			useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
			render(
				<AcRefPicker
					{...baseProps}
					values={[ref]}
					onChange={vi.fn()}
				/>,
			);

			expect(getTriggerButton()).toHaveTextContent("AC 3");

			await userEvent.click(getTriggerButton());
			expect(
				await screen.findByRole("menuitemcheckbox", {
					name: /Third criterion/,
				}),
			).toBeChecked();
		},
	);

	it("shows every selected criterion in the trigger, in numeric order", async () => {
		// The whole point of the control: a case covering three criteria has to
		// say so at a glance, without opening the menu.
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		render(
			<AcRefPicker
				{...baseProps}
				values={["3", "1"]}
				onChange={vi.fn()}
			/>,
		);

		expect(getTriggerButton()).toHaveTextContent("AC 1, AC 3");
	});

	it("ticking a second criterion keeps the first", async () => {
		// The regression that matters. A single-select control replaced the
		// previous choice; storage has always held a list, so replacing rather
		// than adding is what made the matrix under-report coverage.
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(
			<AcRefPicker
				{...baseProps}
				values={["1"]}
				onChange={onChange}
				onCommit={onCommit}
			/>,
		);

		await userEvent.click(getTriggerButton());
		await userEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: /Third criterion/,
			}),
		);

		expect(onChange).toHaveBeenCalledWith(["1", "3"]);
		expect(onCommit).toHaveBeenCalledWith(["1", "3"]);
	});

	it("un-ticking a criterion removes only that one", async () => {
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		const onChange = vi.fn();
		render(
			<AcRefPicker
				{...baseProps}
				values={["1", "2"]}
				onChange={onChange}
				onCommit={vi.fn()}
			/>,
		);

		await userEvent.click(getTriggerButton());
		await userEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: /First criterion/,
			}),
		);

		expect(onChange).toHaveBeenCalledWith(["2"]);
	});

	it("writes bare numbers, never 'AC n'", async () => {
		// The RAG context formatter prefixes "Covers AC" ahead of whatever is
		// stored; writing "AC 2" here would render "Covers AC AC 2" everywhere
		// the case's context reaches an LLM.
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		const onChange = vi.fn();
		render(
			<AcRefPicker
				{...baseProps}
				values={[]}
				onChange={onChange}
				onCommit={vi.fn()}
			/>,
		);

		await userEvent.click(getTriggerButton());
		await userEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: /Second criterion/,
			}),
		);

		expect(onChange).toHaveBeenCalledWith(["2"]);
	});

	it("un-ticking the last criterion clears to an empty list", async () => {
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		const onChange = vi.fn();
		render(
			<AcRefPicker
				{...baseProps}
				values={["1"]}
				onChange={onChange}
				onCommit={vi.fn()}
			/>,
		);

		await userEvent.click(getTriggerButton());
		await userEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: /First criterion/,
			}),
		);

		expect(onChange).toHaveBeenCalledWith([]);
	});

	it("keeps a stale ref as a disabled entry rather than dropping it", async () => {
		// The regression this guards: collapsing a stale ref into "not linked"
		// reads exactly like a case nobody ever mapped, and the person reviewing
		// coverage cannot tell the two apart without this entry.
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		render(
			<AcRefPicker {...baseProps} values={["AC 9"]} onChange={vi.fn()} />,
		);

		await userEvent.click(getTriggerButton());

		const stale = await screen.findByRole("menuitemcheckbox", {
			name: /AC 9/,
		});
		expect(stale).toHaveAttribute("aria-disabled", "true");
	});

	it("carries a stale ref through an unrelated edit instead of silently dropping it", async () => {
		// Editing a case whose spec has since shrunk must not quietly discard the
		// evidence that it was mapped. The stale ref rides along on every write.
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		const onChange = vi.fn();
		render(
			<AcRefPicker
				{...baseProps}
				values={["AC 9"]}
				onChange={onChange}
				onCommit={vi.fn()}
			/>,
		);

		await userEvent.click(getTriggerButton());
		await userEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: /First criterion/,
			}),
		);

		expect(onChange).toHaveBeenCalledWith(["1", "AC 9"]);
	});

	it("shows no stale entry for a case that was simply never linked", async () => {
		// Contrast for the case above: a genuinely unmapped case (no ref at all)
		// must not grow a stale entry out of nowhere.
		useQueryMock.mockReturnValue(storyQuery(CRITERIA_MD));
		render(<AcRefPicker {...baseProps} values={[]} onChange={vi.fn()} />);

		await userEvent.click(getTriggerButton());

		expect(screen.queryByText(/links.acStale/)).not.toBeInTheDocument();
	});
});
