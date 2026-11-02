import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../../../components/ai-elements/code-block";

const m = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next-themes", () => ({
	useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("react-syntax-highlighter", () => {
	m.load();
	return {
		Prism: ({
			children,
			language,
		}: {
			children: string;
			language: string;
		}) => (
			<pre data-testid="highlighted-code" data-language={language}>
				{children}
			</pre>
		),
	};
});

describe("deferred syntax highlighting", () => {
	it("loads grammars only for a rendered code block and keeps its text available", async () => {
		expect(m.load).not.toHaveBeenCalled();
		const code = 'const example = "safe text";';
		render(<CodeBlock code={code} language="js" />);
		expect(screen.getByText(code)).toBeInTheDocument();
		const highlighted = await screen.findByTestId("highlighted-code");
		expect(m.load).toHaveBeenCalledOnce();
		expect(highlighted).toHaveAttribute("data-language", "javascript");
		expect(highlighted).toHaveTextContent(code);
	});
});
