/**
 * The question a page raises before it changes something or offers a file. The
 * alert dialog is stood in for by plain elements that stay mounted, so what the
 * dialog keeps on screen while it closes can be seen.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ui/components/alert-dialog", () => {
	const Pass = ({ children }: { children?: ReactNode }) => (
		<div>{children}</div>
	);
	return {
		AlertDialog: Pass,
		AlertDialogContent: ({
			children,
			className,
		}: {
			children?: ReactNode;
			className?: string;
		}) => (
			<div role="alertdialog" className={className}>
				{children}
			</div>
		),
		AlertDialogHeader: Pass,
		AlertDialogFooter: Pass,
		AlertDialogTitle: ({
			children,
			className,
		}: {
			children?: ReactNode;
			className?: string;
		}) => <h2 className={className}>{children}</h2>,
		AlertDialogDescription: ({ children }: { children?: ReactNode }) => (
			<p>{children}</p>
		),
		AlertDialogCancel: ({
			children,
			onClick,
		}: {
			children?: ReactNode;
			onClick?: () => void;
		}) => (
			<button type="button" onClick={onClick}>
				{children}
			</button>
		),
		AlertDialogAction: ({
			children,
			onClick,
		}: {
			children?: ReactNode;
			onClick?: () => void;
		}) => (
			<button type="button" onClick={onClick}>
				{children}
			</button>
		),
	};
});

import type { PendingCall } from "@saas/frames/hooks/use-frame-runtime-bridge";
import { FrameRuntimeConfirmDialog } from "@saas/frames/components/FrameRuntimeConfirmDialog";

const ASK: PendingCall = {
	kind: "tool",
	toolName: "fabric_page_ask",
	args: { question: "Summarise the votes" },
};

const CONNECTED: PendingCall = {
	kind: "tool",
	toolName: "fabric_page_read_connected",
	args: { provider: "linear", tool: "list_issues" },
};

const DOWNLOAD: PendingCall = {
	kind: "download",
	download: {
		filename: `${"quarterly-report-".repeat(8)}final.csv`,
		mimeType: "text/csv",
		bytes: 2048,
		dataBase64: "AAAA",
	},
};

function renderDialog(call: PendingCall | null) {
	const onAnswer = vi.fn();
	const view = render(
		<FrameRuntimeConfirmDialog
			call={call}
			pageTitle="Delivery"
			onAnswer={onAnswer}
		/>,
	);
	const again = (next: PendingCall | null) =>
		view.rerender(
			<FrameRuntimeConfirmDialog
				call={next}
				pageTitle="Delivery"
				onAnswer={onAnswer}
			/>,
		);
	return { onAnswer, again };
}

describe("what the question says", () => {
	it("names the action as a phrase that reads in a sentence, with the AI capitalised, and what it costs", () => {
		renderDialog(ASK);

		expect(
			screen.getByRole("heading", {
				name: "Allow this page to ask the AI a question?",
			}),
		).toBeInTheDocument();
		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"asking to ask the AI a question as you, which spends your AI allowance.",
		);
	});

	it("says a connected read once, not twice", () => {
		renderDialog(CONNECTED);

		const description = screen.getByText(/is asking to/).textContent ?? "";
		expect(description).toContain(
			"asking to read from your connected account as you.",
		);
		expect(description).not.toMatch(/which reads from/);
		expect(description.match(/connected account/g)).toHaveLength(1);
	});

	it("says a change to data in Fabric for any other tool", () => {
		renderDialog({
			kind: "tool",
			toolName: "fabric_execute_workflow",
			args: { readOnlyHint: true },
		});

		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"asking to run workflow as you, which can change data in Fabric.",
		);
	});

	it.each([
		"fabric_list_project_pm_members",
		"fabric_get_project_work_item_counts",
	])(
		"describes trusted read-only %s without claiming it writes",
		(toolName) => {
			renderDialog({
				kind: "tool",
				toolName,
				args: { projectId: "project-1" },
				readOnly: true,
				because: "tainted",
			});
			const dialog = screen.getByRole("alertdialog");
			expect(dialog).toHaveTextContent("reads data without changing it");
			expect(dialog).toHaveTextContent("before every sensitive read");
			expect(dialog).not.toHaveTextContent("can change data in Fabric");
			expect(dialog).not.toHaveTextContent("change to shared data");
		},
	);

	it("keeps the shared-write warning after external reads", () => {
		renderDialog({
			kind: "tool",
			toolName: "fabric_page_data_set",
			args: { collection: "votes", records: [] },
			because: "tainted",
		});
		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"before every change to shared data",
		);
	});

	it("describes a repeated AI request and preserves its allowance cost", () => {
		renderDialog({ ...ASK, because: "tainted" });
		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toHaveTextContent("spends your AI allowance");
		expect(dialog).toHaveTextContent("before each AI request");
		expect(dialog).not.toHaveTextContent("change to shared data");
	});
});

describe("the dialog as a screen holds it", () => {
	it("scrolls inside the window, whatever the question carries", () => {
		renderDialog(ASK);

		expect(screen.getByRole("alertdialog").className).toContain(
			"max-h-[90dvh]",
		);
		expect(screen.getByRole("alertdialog").className).toContain(
			"overflow-y-auto",
		);
	});

	it("breaks a long file name in the title instead of running off the dialog", () => {
		renderDialog(DOWNLOAD);

		expect(
			screen.getByRole("heading", { name: /^Save quarterly-report-/ })
				.className,
		).toContain("break-words");
	});
});

describe("when the question is answered", () => {
	it("keeps showing it until the dialog has gone, not an empty box", () => {
		const { again } = renderDialog(ASK);

		again(null);

		expect(
			screen.getByRole("heading", {
				name: "Allow this page to ask the AI a question?",
			}),
		).toBeInTheDocument();
	});

	it("shows the new question once there is one, and the last one again after it", () => {
		const { again } = renderDialog(ASK);

		again(DOWNLOAD);
		expect(
			screen.getByRole("heading", { name: /^Save / }),
		).toBeInTheDocument();
		again(null);

		expect(
			screen.getByRole("heading", { name: /^Save / }),
		).toBeInTheDocument();
		expect(screen.queryByText(/ask the AI a question/)).toBeNull();
	});

	it("shows nothing before a first question", () => {
		renderDialog(null);

		expect(screen.queryByRole("heading")).toBeNull();
	});
});
