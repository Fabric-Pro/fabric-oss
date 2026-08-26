/**
 * Settings ▸ Testing — the CI setup snippet.
 *
 * `buildCiConfigTemplate` shipped with no caller, so the answer
 * to "why is my QA tab empty" lived only in our docs. What matters here is not
 * that a code block renders, but that the panel keeps the promise the whole
 * feature rests on: **Fabric hands over text and never writes to a repository.**
 * A user who reads this and goes looking for an "apply for me" button has been
 * misled by the copy.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const writeText = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				ciConfigTemplate: {
					queryOptions: (opts: unknown) => opts,
				},
			},
		},
	},
}));

import { QaCiSetupSection } from "../QaCiSetupSection";

const TEMPLATE = {
	path: ".github/workflows/fabric-qa.yml",
	content: "name: fabric-qa\non:\n  push:\n    branches: [main]",
	notes: ["Commit this file yourself.", "Fabric never pushes to your repo."],
};

/** The input the template query was constructed with. */
function queryInput() {
	const call = useQueryMock.mock.calls.at(-1);
	return (call?.[0] as { input?: Record<string, unknown> })?.input;
}

beforeEach(() => {
	vi.clearAllMocks();
	writeText.mockResolvedValue(undefined);
	Object.assign(navigator, { clipboard: { writeText } });
	useQueryMock.mockReturnValue({
		data: TEMPLATE,
		isLoading: false,
		isError: false,
	});
});

describe("QaCiSetupSection", () => {
	it("says plainly that Fabric will not commit this for you", () => {
		// The load-bearing copy. The hard constraint on this whole spec is that
		// Fabric never writes CI config into a customer repository; a panel that
		// hands over a workflow file without saying so invites the opposite
		// assumption.
		render(<QaCiSetupSection projectId="p1" />);

		expect(
			screen.getByText(/never writes to your repository/i),
		).toBeInTheDocument();
	});

	it("shows where the file goes, not just what is in it", () => {
		render(<QaCiSetupSection projectId="p1" />);

		expect(
			screen.getByText(".github/workflows/fabric-qa.yml"),
		).toBeInTheDocument();
		expect(screen.getByText(/name: fabric-qa/)).toBeInTheDocument();
	});

	it("renders the generator's leftover work rather than dropping it", () => {
		// `notes` is the honest half of the payload — what the snippet does NOT
		// do for you. Rendering the file and swallowing the caveats would make
		// the feature look more complete than it is.
		render(<QaCiSetupSection projectId="p1" />);

		expect(
			screen.getByText("Fabric never pushes to your repo."),
		).toBeInTheDocument();
	});

	it("asks for a different provider when one is chosen", async () => {
		render(<QaCiSetupSection projectId="p1" />);

		await userEvent.click(
			screen.getByRole("button", { name: /GitLab CI/ }),
		);

		expect(queryInput()).toMatchObject({
			projectId: "p1",
			provider: "GITLAB",
		});
	});

	it("omits a blank field instead of overriding the default with nothing", async () => {
		// The generator substitutes its own documented defaults for a missing
		// branch / command / path. Sending "" would defeat that and put an empty
		// value into the snippet.
		render(<QaCiSetupSection projectId="p1" />);

		expect(queryInput()).not.toHaveProperty("branch");
		expect(queryInput()).not.toHaveProperty("testCommand");

		await userEvent.type(screen.getByLabelText("Branch"), "develop");

		expect(queryInput()).toMatchObject({ branch: "develop" });
	});

	it("announces the copy, since a button relabelling itself is not an announcement", async () => {
		render(<QaCiSetupSection projectId="p1" />);

		await userEvent.click(screen.getByRole("button", { name: /Copy/ }));

		expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
	});

	it("titles the section as a heading, not as a label for nothing", () => {
		// A <Label> with no associated control is invisible to heading
		// navigation, so a screen-reader user would not find this section.
		expect(
			render(<QaCiSetupSection projectId="p1" />).container.querySelector(
				"h4",
			),
		).toHaveTextContent("Make your pipeline report to Fabric");
	});

	it("copies the file contents, not the path", async () => {
		render(<QaCiSetupSection projectId="p1" />);

		await userEvent.click(screen.getByRole("button", { name: /Copy/ }));

		expect(writeText).toHaveBeenCalledWith(TEMPLATE.content);
	});

	it("survives a clipboard the browser refuses", async () => {
		// A denied clipboard permission must not take the panel down — the
		// snippet is on screen and selectable, so the user can still get it.
		writeText.mockRejectedValue(new Error("NotAllowedError"));
		render(<QaCiSetupSection projectId="p1" />);

		await userEvent.click(screen.getByRole("button", { name: /Copy/ }));

		expect(screen.getByText(/name: fabric-qa/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Copy/ }),
		).toBeInTheDocument();
	});

	it("reports a failure to build the snippet instead of an empty box", () => {
		useQueryMock.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});
		render(<QaCiSetupSection projectId="p1" />);

		expect(
			screen.getByText(/Couldn't build the configuration snippet/i),
		).toBeInTheDocument();
	});

	it("does not hide the tail of a long file behind a vertical scroll cap", () => {
		// A height-capped scroll container is only operable by mouse wheel unless
		// it is made focusable — and a focusable non-interactive element is an
		// unlabelled tab stop. Neither is needed: the page already scrolls.
		render(<QaCiSetupSection projectId="p1" />);

		const block = screen.getByText(/name: fabric-qa/);
		expect(block.className).not.toMatch(/max-h-/);
		expect(block).not.toHaveAttribute("tabindex");
	});
});
