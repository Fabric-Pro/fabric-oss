/**
 * The Glossy page's own error boundary (Fizzy #2589, U14): a crash on the
 * page names the Glossy edition, not the document editor, offers Try again,
 * and links back to the document it came from.
 *
 * Copy is resolved against the REAL `en.json` through next-intl's translator,
 * so a missing key or a wrong namespace fails here rather than rendering a
 * raw key.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const params = vi.hoisted(() => ({
	current: {} as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
	useParams: () => params.current,
}));

vi.mock("next/link", () => ({
	default: ({ href, children }: { href: string; children: ReactNode }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const translatorFor = createTranslator as unknown as (config: {
		locale: string;
		messages: unknown;
		namespace: string;
	}) => (key: string) => string;
	return {
		useTranslations: (namespace: string) =>
			translatorFor({ locale: "en", messages, namespace }),
	};
});

import GlossyEditionError from "../../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/documents/[documentId]/glossy/error";

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	consoleError = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);
	params.current = {
		organizationSlug: "example-org",
		id: "project-1",
		documentId: "document-1",
	};
});

afterEach(() => {
	consoleError.mockRestore();
});

describe("Glossy page — error boundary", () => {
	it("names the failure in the page's own copy, with Try again and a way back to the document", async () => {
		const user = userEvent.setup();
		const reset = vi.fn();
		render(
			<GlossyEditionError
				error={Object.assign(new Error("Render crashed"), {
					digest: "digest-example",
				})}
				reset={reset}
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "Couldn't load the Glossy edition.",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("digest-example")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Back to document" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project-1/documents/document-1",
		);

		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(reset).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalled();
	});

	it("links to the app home when the route params are missing", () => {
		params.current = {};
		render(
			<GlossyEditionError
				error={new Error("Render crashed")}
				reset={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("link", { name: "Back to document" }),
		).toHaveAttribute("href", "/app");
	});
});
