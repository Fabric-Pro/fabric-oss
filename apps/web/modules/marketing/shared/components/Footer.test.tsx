import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@i18n/routing", () => ({
	LocaleLink: ({
		children,
		href,
	}: {
		children: React.ReactNode;
		href: string;
	}) => <a href={href}>{children}</a>,
}));
vi.mock("@repo/config", () => ({ config: { appName: "Fabric" } }));
vi.mock("@shared/components/Logo", () => ({
	Logo: () => <span>Fabric</span>,
}));

import { Footer } from "./Footer";

describe("Fabric marketing ownership", () => {
	it("names TechFabric as the owner and links to its contact page", () => {
		render(<Footer />);

		expect(screen.getByRole("contentinfo")).toHaveTextContent(
			"Fabric is a product of TechFabric",
		);
		expect(
			screen.getByRole("link", { name: "Contact TechFabric" }),
		).toHaveAttribute("href", "https://techfabric.com/contact");
	});
});
