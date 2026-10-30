import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { InterfaceModeToggle } from "../InterfaceModeToggle";

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => {
		const messages =
			namespace === "tooltips.publishing.interfaceMode"
				? en.tooltips.publishing.interfaceMode
				: en.tooltips.agents.interfaceMode;
		return messages[key as "simple" | "advanced"];
	},
}));

it("keeps agent tooltips as the default", async () => {
	render(<InterfaceModeToggle value="simple" onChange={vi.fn()} />);
	await userEvent.hover(screen.getByRole("button", { name: "simple" }));
	expect(await screen.findByRole("tooltip")).toHaveTextContent(
		en.tooltips.agents.interfaceMode.simple,
	);
});
it("uses publishing copy for both modes and has German translations", async () => {
	render(
		<InterfaceModeToggle
			value="simple"
			onChange={vi.fn()}
			tooltipNamespace="tooltips.publishing.interfaceMode"
		/>,
	);
	const user = userEvent.setup();
	for (const mode of ["simple", "advanced"] as const) {
		const button = screen.getByRole("button", { name: mode });
		await user.hover(button);
		await waitFor(() =>
			expect(screen.getByRole("tooltip")).toHaveTextContent(
				en.tooltips.publishing.interfaceMode[mode],
			),
		);
		await user.unhover(button);
		expect(de.tooltips.publishing.interfaceMode[mode]).toBeTruthy();
	}
});
