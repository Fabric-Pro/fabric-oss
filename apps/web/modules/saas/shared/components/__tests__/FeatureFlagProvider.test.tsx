import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagProvider, useFeatureFlag } from "../FeatureFlagProvider";

function Probe() {
	return <span>{useFeatureFlag("PERSONAL_MEETINGS") ? "on" : "off"}</span>;
}

describe("FeatureFlagProvider", () => {
	it("exposes the provided value", () => {
		render(
			<FeatureFlagProvider value={{ PERSONAL_MEETINGS: true }}>
				<Probe />
			</FeatureFlagProvider>,
		);
		expect(screen.getByText("on")).toBeInTheDocument();
	});

	it("reports a disabled flag as off", () => {
		render(
			<FeatureFlagProvider value={{ PERSONAL_MEETINGS: false }}>
				<Probe />
			</FeatureFlagProvider>,
		);
		expect(screen.getByText("off")).toBeInTheDocument();
	});

	it("throws when used outside a provider", () => {
		// A missing provider must not read as "feature disabled" — that hides
		// the bug behind behavior indistinguishable from a legitimate off flag.
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => render(<Probe />)).toThrow(/FeatureFlagProvider/);
		spy.mockRestore();
	});
});
