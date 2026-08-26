import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AutomationLinkFields } from "../AutomationLinkFields";

// The global next-intl mock (vitest.setup.ts) returns the bare i18n key for
// every `t(key)` call, so labels render as their key paths.
function renderFields(
	props: Partial<React.ComponentProps<typeof AutomationLinkFields>> = {},
) {
	const onRefChange = vi.fn();
	const onFilePathChange = vi.fn();
	const onExternalUrlChange = vi.fn();
	render(
		<AutomationLinkFields
			automationRef=""
			automationFilePath=""
			automationExternalUrl=""
			onRefChange={onRefChange}
			onFilePathChange={onFilePathChange}
			onExternalUrlChange={onExternalUrlChange}
			{...props}
		/>,
	);
	return { onRefChange, onFilePathChange, onExternalUrlChange };
}

describe("AutomationLinkFields", () => {
	it("renders the stored link so it survives a reopen", () => {
		renderFields({
			automationRef: "auth › login",
			automationFilePath: "apps/web/tests/e2e/login.spec.ts",
			automationExternalUrl: "https://ci.example.com/run/1",
		});

		expect(screen.getByLabelText("fields.automationRef")).toHaveValue(
			"auth › login",
		);
		expect(screen.getByLabelText("fields.automationFilePath")).toHaveValue(
			"apps/web/tests/e2e/login.spec.ts",
		);
		expect(screen.getByLabelText("fields.automationUrl")).toHaveValue(
			"https://ci.example.com/run/1",
		);
	});

	it("reports every keystroke to the parent, which owns the form state", async () => {
		const user = userEvent.setup();
		const { onRefChange } = renderFields();

		await user.type(screen.getByLabelText("fields.automationRef"), "a");

		expect(onRefChange).toHaveBeenCalledWith("a");
	});

	it("renders a real link for an http(s) report URL", () => {
		renderFields({ automationExternalUrl: "https://ci.example.com/run/1" });

		const link = screen.getByRole("link", {
			name: "fields.automationUrlOpenAria",
		});
		expect(link).toHaveAttribute("href", "https://ci.example.com/run/1");
		expect(link).toHaveAttribute("target", "_blank");
	});

	it("flags a non-http(s) URL and refuses to render it as a link", () => {
		renderFields({ automationExternalUrl: "javascript:alert(1)" });

		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"fields.automationUrlInvalid",
		);
		expect(screen.getByLabelText("fields.automationUrl")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
	});

	it("treats an empty URL as cleared, not invalid", () => {
		renderFields({ automationExternalUrl: "" });

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});
});
