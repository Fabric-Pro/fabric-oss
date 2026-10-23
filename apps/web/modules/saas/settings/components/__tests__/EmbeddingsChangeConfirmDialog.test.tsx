import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";

vi.mock("next-intl", async () => vi.importActual("next-intl"));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import {
	EmbeddingsChangeConfirmDialog,
	useEmbeddingsChangeConfirmation,
} from "../EmbeddingsChangeConfirmDialog";

const impact = {
	companyContext: { indexedWithCurrentModel: 2, total: 5 },
	projectContent: { indexed: 7 },
};
it.each(["en", "de"])(
	"requires the translated word, ignoring case and surrounding whitespace (%s)",
	async (locale) => {
		const confirm = vi.fn();
		const messages = locale === "de" ? de : en;
		const copy = messages.settings.aiModelsRouting.models;
		render(
			<NextIntlClientProvider locale={locale} messages={messages}>
				<EmbeddingsChangeConfirmDialog
					open
					onOpenChange={() => {}}
					onConfirm={confirm}
					impact={impact}
				/>
			</NextIntlClientProvider>,
		);
		const input = screen.getByRole("textbox", {
			name: copy.embeddingsConfirmationLabel,
		});
		expect(input).toHaveAccessibleDescription(
			expect.stringContaining(copy.embeddingsConfirmationWord),
		);
		const button = screen.getByRole("button", {
			name: copy.embeddingsChangeConfirm,
		});
		expect(button).toBeDisabled();
		fireEvent.click(button);
		expect(confirm).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "wrong" } });
		expect(button).toBeDisabled();
		fireEvent.change(input, {
			target: {
				value: ` ${copy.embeddingsConfirmationWord.toLowerCase()} `,
			},
		});
		expect(button).not.toBeDisabled();
		fireEvent.click(button);
		expect(confirm).toHaveBeenCalledTimes(1);
	},
);
it("renders distinct company/model and project/indexed counts", () => {
	render(
		<NextIntlClientProvider locale="en" messages={en}>
			<EmbeddingsChangeConfirmDialog
				open
				onOpenChange={() => {}}
				onConfirm={() => {}}
				impact={impact}
			/>
		</NextIntlClientProvider>,
	);
	expect(screen.getByRole("alertdialog")).toHaveTextContent(
		"Company context sources indexed with the current model: 2 of 5.",
	);
	expect(screen.getByRole("alertdialog")).toHaveTextContent(
		"Indexed project context sources and documents: 7.",
	);
});
it("blocks confirmation while counts are loading", () => {
	render(
		<NextIntlClientProvider locale="en" messages={en}>
			<EmbeddingsChangeConfirmDialog
				open
				onOpenChange={() => {}}
				onConfirm={() => {}}
				isLoading
			/>
		</NextIntlClientProvider>,
	);
	expect(screen.getByRole("status")).toHaveTextContent(
		"Checking indexed content",
	);
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "REINDEX" },
	});
	expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
});
it("reports unavailable counts and permits typed confirmation after a read failure", () => {
	const confirm = vi.fn();
	render(
		<NextIntlClientProvider locale="en" messages={en}>
			<EmbeddingsChangeConfirmDialog
				open
				onOpenChange={() => {}}
				onConfirm={confirm}
				isError
			/>
		</NextIntlClientProvider>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent("count is unavailable");
	expect(screen.queryByText(/sources and documents: 0/)).toBeNull();
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "REINDEX" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Change" }));
	expect(confirm).toHaveBeenCalledTimes(1);
});
it("returns focus to the initiating control when cancelled", async () => {
	const { useState } = await import("react");
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<>
				<button type="button" onClick={() => setOpen(true)}>
					Choose model
				</button>
				<EmbeddingsChangeConfirmDialog
					open={open}
					onOpenChange={setOpen}
					onConfirm={() => {}}
					impact={impact}
				/>
			</>
		);
	}
	render(
		<NextIntlClientProvider locale="en" messages={en}>
			<Harness />
		</NextIntlClientProvider>,
	);
	const trigger = screen.getByRole("button", { name: "Choose model" });
	trigger.focus();
	fireEvent.click(trigger);
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(trigger).toHaveFocus());
});

it.each(["en", "de"])(
	"reports an unresolved organization in the selected language (%s)",
	async (locale) => {
		const messages = locale === "de" ? de : en;
		vi.mocked(toast.error).mockClear();
		const action = vi.fn();
		function Harness() {
			const confirmation = useEmbeddingsChangeConfirmation(undefined);
			return (
				<button
					type="button"
					onClick={() => void confirmation.requestChange(action)}
				>
					Change embedding
				</button>
			);
		}
		render(
			<QueryClientProvider client={new QueryClient()}>
				<NextIntlClientProvider locale={locale} messages={messages}>
					<Harness />
				</NextIntlClientProvider>
			</QueryClientProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Change embedding" }),
		);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				locale === "de"
					? "Die Organisation wird noch geladen. Bitte versuchen Sie es erneut, sobald sie verfügbar ist."
					: "Organization is still loading. Try again once it is available.",
			),
		);
		expect(action).not.toHaveBeenCalled();
	},
);
