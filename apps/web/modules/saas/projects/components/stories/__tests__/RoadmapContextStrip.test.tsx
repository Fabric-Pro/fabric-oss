import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RoadmapContextStrip } from "../RoadmapContextStrip";

const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: en } = await import("@repo/i18n/translations/en.json");
	const { default: de } = await import("@repo/i18n/translations/de.json");
	return {
		...actual,
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: locale.value,
				messages: locale.value === "de" ? de : en,
				namespace,
			}),
	};
});
it.each([
	["en", "About this roadmap"],
	["de", "Über diese Roadmap"],
])(
	"keeps the icon-only About control named and explained in %s",
	async (language, name) => {
		locale.value = language;
		const user = userEvent.setup();
		render(<RoadmapContextStrip />);
		const button = screen.getByRole("button", { name, exact: true });
		expect(button).toHaveClass("size-8");
		expect(button.textContent).toBe("");
		await user.hover(button);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(name);
		await user.click(button);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	},
);
