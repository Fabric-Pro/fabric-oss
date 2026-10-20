/**
 * The setup wizard's Review step behind the `PROPOSAL_ARTIFACT` gate
 * (Fizzy #2946).
 *
 * Where the Proposal artifact is on, a Proposal is written from the library's
 * Client proposal (Main) prompt, so its row offers no prompt selector (and so
 * no "Bind as Default" that would write the legacy slot) and says where the
 * prompt comes from instead; its custom instructions stay. "Apply First Prompt
 * to All" neither takes its prompt from the Proposal row nor writes one onto
 * it. With the gate off every row keeps its selector, as before.
 *
 * `next-intl` echoes keys (global mock), so copy is asserted by key.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { flags } = vi.hoisted(() => ({
	flags: { proposalArtifact: false },
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PROPOSAL_ARTIFACT" ? flags.proposalArtifact : false,
}));

// The real selector loads prompts over oRPC; this one names its document type
// and lets a test pick a prompt for it.
vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: ({
		documentType,
		onValueChange,
		showBindAction,
	}: {
		documentType?: string;
		onValueChange: (promptId: string | undefined) => void;
		showBindAction?: boolean;
	}) => (
		<div data-testid={`prompt-selector-${documentType}`}>
			<button
				type="button"
				onClick={() => onValueChange(`prompt-${documentType}`)}
			>
				{`pick ${documentType}`}
			</button>
			{showBindAction ? <span>Bind as Default</span> : null}
		</div>
	),
}));

import { ReviewPromptsStep } from "@saas/projects/components/wizard/ReviewPromptsStep";

type DocumentPrompts = Record<
	string,
	{ promptId?: string; customInstructions?: string }
>;

/** The step is controlled; this holds its state and records every change. */
function Harness({
	documents,
	initial = {},
	onChange,
}: {
	documents: string[];
	initial?: DocumentPrompts;
	onChange: (prompts: DocumentPrompts) => void;
}) {
	const [prompts, setPrompts] = useState<DocumentPrompts>(initial);
	return (
		<ReviewPromptsStep
			documents={documents}
			documentPrompts={prompts}
			onDocumentPromptsChange={(next) => {
				onChange(next);
				setPrompts(next);
			}}
		/>
	);
}

const libraryField = () => screen.queryByTestId("proposal-library-prompt");
const selector = (type: string) =>
	screen.queryByTestId(`prompt-selector-${type}`);
const applyButton = () =>
	screen.getByRole("button", { name: "Apply First Prompt to All" });

describe("ReviewPromptsStep — Proposal prompt behind the Proposal artifact gate", () => {
	beforeEach(() => {
		flags.proposalArtifact = false;
	});

	it("shows the library prompt for a Proposal and selectors for the rest with the gate on", () => {
		flags.proposalArtifact = true;
		render(
			<Harness
				documents={["PROPOSAL", "PRD", "ARCHITECTURE"]}
				onChange={vi.fn()}
			/>,
		);

		expect(selector("PROPOSAL")).not.toBeInTheDocument();
		const field = libraryField();
		expect(field).toHaveTextContent("AI Prompt Template");
		expect(field).toHaveTextContent("libraryPrompt");
		expect(field).toHaveTextContent("libraryPromptHint");
		expect(selector("PRD")).toBeInTheDocument();
		expect(selector("ARCHITECTURE")).toBeInTheDocument();
		// Only the two selectors offer "Bind as Default"; the Proposal row
		// cannot write the legacy slot.
		expect(screen.getAllByText("Bind as Default")).toHaveLength(2);
		// Custom instructions stay on every row, the Proposal's included.
		expect(screen.getAllByRole("textbox")).toHaveLength(3);
	});

	it("keeps a Proposal's custom instructions with the gate on", async () => {
		flags.proposalArtifact = true;
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(<Harness documents={["PROPOSAL", "PRD"]} onChange={onChange} />);

		await user.type(screen.getAllByRole("textbox")[0], "Lead");

		expect(onChange).toHaveBeenLastCalledWith({
			PROPOSAL: { customInstructions: "Lead" },
		});
	});

	it("applies the first non-Proposal row's prompt to the other non-Proposal rows only", async () => {
		flags.proposalArtifact = true;
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<Harness
				documents={["PROPOSAL", "PRD", "ARCHITECTURE"]}
				onChange={onChange}
			/>,
		);

		// PROPOSAL is listed first but chooses no prompt, so PRD is the
		// source; with nothing picked there the action is unavailable.
		expect(applyButton()).toBeDisabled();

		await user.click(
			within(selector("PRD") as HTMLElement).getByRole("button", {
				name: "pick PRD",
			}),
		);
		expect(applyButton()).toBeEnabled();

		await user.click(applyButton());

		const applied = onChange.mock.lastCall?.[0] as DocumentPrompts;
		expect(applied.PRD?.promptId).toBe("prompt-PRD");
		expect(applied.ARCHITECTURE?.promptId).toBe("prompt-PRD");
		expect(applied.PROPOSAL?.promptId).toBeUndefined();
	});

	it("leaves a Proposal's held prompt alone when applying with the gate on", async () => {
		// A prompt kept from before the gate flipped is neither the source
		// nor overwritten; the run ignores it either way.
		flags.proposalArtifact = true;
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<Harness
				documents={["PROPOSAL", "PRD", "ARCHITECTURE"]}
				initial={{
					PROPOSAL: { promptId: "prompt-legacy" },
					PRD: { promptId: "prompt-PRD" },
				}}
				onChange={onChange}
			/>,
		);

		await user.click(applyButton());

		const applied = onChange.mock.lastCall?.[0] as DocumentPrompts;
		expect(applied.ARCHITECTURE?.promptId).toBe("prompt-PRD");
		expect(applied.PROPOSAL?.promptId).toBe("prompt-legacy");
	});

	it("keeps three selectors and applies the first row's prompt to all with the gate off", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<Harness
				documents={["PROPOSAL", "PRD", "ARCHITECTURE"]}
				onChange={onChange}
			/>,
		);

		expect(libraryField()).not.toBeInTheDocument();
		expect(selector("PROPOSAL")).toBeInTheDocument();
		expect(selector("PRD")).toBeInTheDocument();
		expect(selector("ARCHITECTURE")).toBeInTheDocument();
		expect(screen.getAllByText("Bind as Default")).toHaveLength(3);

		// The source is documents[0], as before: a PRD pick does not enable it.
		await user.click(
			within(selector("PRD") as HTMLElement).getByRole("button", {
				name: "pick PRD",
			}),
		);
		expect(applyButton()).toBeDisabled();

		await user.click(
			within(selector("PROPOSAL") as HTMLElement).getByRole("button", {
				name: "pick PROPOSAL",
			}),
		);
		await user.click(applyButton());

		const applied = onChange.mock.lastCall?.[0] as DocumentPrompts;
		expect(applied.PROPOSAL?.promptId).toBe("prompt-PROPOSAL");
		expect(applied.PRD?.promptId).toBe("prompt-PROPOSAL");
		expect(applied.ARCHITECTURE?.promptId).toBe("prompt-PROPOSAL");
	});
});
