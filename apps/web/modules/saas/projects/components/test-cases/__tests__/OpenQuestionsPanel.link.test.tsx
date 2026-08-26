/**
 * The open-questions composer can attach a feature.
 *
 * `createQaOpenQuestion` has always accepted `userStoryId`; the composer never
 * sent one, so a question could only be linked to a feature by something other
 * than the person asking it. The same "procedure accepts it, UI never sends it"
 * shape as the manual-reorder register.
 *
 * The link is **optional** — a question about testing in general is a legitimate
 * question — and it must not persist to the next question, which is the failure
 * mode a sticky picker creates: a wrong link nobody typed.
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const createMutate = vi.fn();
let createOptions: { onSuccess?: () => void } = {};

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		setQueryData: vi.fn(),
	}),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/**
 * The real picker is a searchable popover backed by its own coverage query and
 * is exercised in its own suite. Stubbed to a button that selects a known
 * feature, so this suite tests the CONTRACT the composer has with it — what it
 * passes down and what it does with what comes back.
 */
vi.mock("../FeaturePicker", () => ({
	FeaturePicker: ({
		value,
		onChange,
		placeholder,
	}: {
		value: readonly string[];
		onChange: (s: { id: string; identifier: string }[]) => void;
		placeholder?: string;
	}) => (
		<button
			type="button"
			data-testid="feature-picker"
			data-value={value.join(",")}
			onClick={() => onChange([{ id: "s1", identifier: "F-007" }])}
		>
			{placeholder}
		</button>
	),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			qaOpenQuestions: {
				list: {
					queryOptions: (opts: unknown) => opts,
					key: () => ["questions"],
				},
				create: {
					mutationOptions: (opts: unknown) => {
						createOptions = opts as { onSuccess?: () => void };
						return { ...(opts as object), __key: "create" };
					},
				},
				update: {
					mutationOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "update",
					}),
				},
			},
		},
	},
}));

import { OpenQuestionsPanel } from "../OpenQuestionsPanel";

const props = {
	projectId: "p1",
	organizationId: "org1" as string | null,
	canEdit: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue({
		data: [],
		isLoading: false,
		isError: false,
	});
	useMutationMock.mockImplementation((opts: { __key?: string }) => ({
		mutate: opts?.__key === "create" ? createMutate : vi.fn(),
		isPending: false,
	}));
});

async function compose(text: string) {
	await userEvent.type(screen.getByLabelText("New open question"), text);
}

describe("OpenQuestionsPanel — attaching a feature", () => {
	it("sends no userStoryId when nothing is picked", async () => {
		// A question about testing in general is legitimate, so the link must
		// never be required.
		render(<OpenQuestionsPanel {...props} />);
		await compose("Which browsers do we support?");
		await userEvent.click(screen.getByRole("button", { name: /add/i }));

		expect(createMutate).toHaveBeenCalledWith({
			projectId: "p1",
			question: "Which browsers do we support?",
		});
		expect(createMutate.mock.calls[0][0]).not.toHaveProperty("userStoryId");
	});

	it("sends the picked feature's id", async () => {
		render(<OpenQuestionsPanel {...props} />);
		await compose("Is the reset flow in scope?");
		await userEvent.click(screen.getByTestId("feature-picker"));
		await userEvent.click(screen.getByRole("button", { name: /add/i }));

		expect(createMutate).toHaveBeenCalledWith(
			expect.objectContaining({ userStoryId: "s1" }),
		);
	});

	it("shows the chosen feature as a removable chip, not a still-open picker", async () => {
		// FeaturePicker in single-select never toggles off on re-click, so
		// leaving it rendered would make a mis-pick undoable only by submitting
		// or discarding the draft.
		render(<OpenQuestionsPanel {...props} />);
		await userEvent.click(screen.getByTestId("feature-picker"));

		expect(screen.getByText("F-007")).toBeInTheDocument();
		expect(screen.queryByTestId("feature-picker")).toBeNull();
	});

	it("lets a mis-picked feature be removed before submitting", async () => {
		render(<OpenQuestionsPanel {...props} />);
		await userEvent.click(screen.getByTestId("feature-picker"));
		await userEvent.click(
			screen.getByRole("button", { name: /Remove feature F-007/ }),
		);

		// Back to the picker, and the link is gone from the payload.
		expect(screen.getByTestId("feature-picker")).toBeInTheDocument();
		await compose("Still unclear");
		await userEvent.click(screen.getByRole("button", { name: /add/i }));
		expect(createMutate.mock.calls[0][0]).not.toHaveProperty("userStoryId");
	});

	it("clears the link with the draft, so it cannot follow the next question", () => {
		// The failure mode a sticky picker creates: question two silently
		// inherits question one's feature — a wrong link nobody typed.
		render(<OpenQuestionsPanel {...props} />);

		createOptions.onSuccess?.();

		expect(screen.getByTestId("feature-picker")).toBeInTheDocument();
	});

	it("offers no composer at all to someone who cannot edit", () => {
		render(<OpenQuestionsPanel {...props} canEdit={false} />);

		expect(screen.queryByTestId("feature-picker")).toBeNull();
		expect(screen.queryByLabelText("New open question")).toBeNull();
	});
});
