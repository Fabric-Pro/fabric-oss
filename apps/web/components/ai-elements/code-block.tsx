"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftRight,
	CheckIcon,
	CopyIcon,
	EyeIcon,
	WrapText,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
	type ComponentProps,
	createContext,
	type HTMLAttributes,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
	oneDark,
	oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { toast } from "sonner";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
	code: string;
	language?: string;
	showLineNumbers?: boolean;
};

type CodeBlockContextType = {
	code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
	code: "",
});

// Map common language aliases to prism language names
// Prism supports 100+ languages - this maps common aliases and variations
const languageMap: Record<string, string> = {
	// JavaScript ecosystem
	js: "javascript",
	javascript: "javascript",
	ts: "typescript",
	typescript: "typescript",
	tsx: "tsx",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	node: "javascript",

	// Python
	py: "python",
	python: "python",
	python3: "python",
	py3: "python",

	// Ruby
	rb: "ruby",
	ruby: "ruby",

	// Shell/Bash
	sh: "bash",
	bash: "bash",
	shell: "bash",
	zsh: "bash",
	fish: "bash",
	powershell: "powershell",
	ps1: "powershell",
	pwsh: "powershell",

	// Data formats
	json: "json",
	json5: "json5",
	yaml: "yaml",
	yml: "yaml",
	xml: "xml",
	toml: "toml",
	ini: "ini",
	csv: "csv",

	// Markup/Markdown
	md: "markdown",
	markdown: "markdown",
	mdx: "mdx",
	html: "markup",
	htm: "markup",
	svg: "markup",
	mathml: "markup",

	// CSS ecosystem
	css: "css",
	scss: "scss",
	sass: "sass",
	less: "less",
	stylus: "stylus",

	// SQL and databases
	sql: "sql",
	mysql: "sql",
	pgsql: "sql",
	postgres: "sql",
	postgresql: "sql",
	sqlite: "sql",
	plsql: "plsql",

	// GraphQL
	graphql: "graphql",
	gql: "graphql",

	// Go
	go: "go",
	golang: "go",

	// Rust
	rust: "rust",
	rs: "rust",

	// Java ecosystem
	java: "java",
	kotlin: "kotlin",
	kt: "kotlin",
	kts: "kotlin",
	groovy: "groovy",
	gradle: "groovy",
	scala: "scala",

	// .NET ecosystem
	csharp: "csharp",
	"c#": "csharp",
	cs: "csharp",
	fsharp: "fsharp",
	"f#": "fsharp",
	fs: "fsharp",
	vb: "vbnet",
	vbnet: "vbnet",
	"visual-basic": "vbnet",

	// C/C++
	c: "c",
	cpp: "cpp",
	"c++": "cpp",
	cxx: "cpp",
	cc: "cpp",
	h: "c",
	hpp: "cpp",
	objc: "objectivec",
	"objective-c": "objectivec",
	objectivec: "objectivec",

	// Apple ecosystem
	swift: "swift",

	// PHP
	php: "php",

	// R
	r: "r",
	rlang: "r",

	// Lua
	lua: "lua",

	// Perl
	perl: "perl",
	pl: "perl",

	// Functional languages
	haskell: "haskell",
	hs: "haskell",
	elixir: "elixir",
	ex: "elixir",
	exs: "elixir",
	erlang: "erlang",
	erl: "erlang",
	clojure: "clojure",
	clj: "clojure",
	cljs: "clojure",
	ocaml: "ocaml",
	ml: "ocaml",
	elm: "elm",
	purescript: "purescript",
	purs: "purescript",
	reasonml: "reason",
	reason: "reason",
	rescript: "reason",

	// Systems/Low-level
	asm: "nasm",
	assembly: "nasm",
	nasm: "nasm",
	wasm: "wasm",
	wat: "wasm",
	llvm: "llvm",

	// DevOps/Infrastructure
	dockerfile: "docker",
	docker: "docker",
	makefile: "makefile",
	make: "makefile",
	cmake: "cmake",
	nginx: "nginx",
	apache: "apacheconf",
	terraform: "hcl",
	tf: "hcl",
	hcl: "hcl",
	ansible: "yaml",

	// Data Science
	julia: "julia",
	jl: "julia",
	matlab: "matlab",
	octave: "matlab",

	// Mobile
	dart: "dart",
	flutter: "dart",

	// Other modern languages
	zig: "zig",
	nim: "nim",
	crystal: "crystal",
	v: "v",
	vlang: "v",
	solidity: "solidity",
	sol: "solidity",
	move: "rust", // Move is similar to Rust
	cairo: "rust", // Cairo is similar to Rust

	// Config files
	env: "bash",
	dotenv: "bash",
	properties: "properties",
	conf: "ini",
	cfg: "ini",

	// Misc
	diff: "diff",
	patch: "diff",
	git: "git",
	regex: "regex",
	regexp: "regex",
	latex: "latex",
	tex: "latex",

	// Plain text fallbacks
	plaintext: "text",
	text: "text",
	txt: "text",
	log: "text",
	output: "text",
};

function normalizeLanguage(lang: string | undefined): string {
	if (!lang) {
		return "text";
	}
	const lower = lang.toLowerCase();
	return languageMap[lower] || lower;
}

function HtmlPreviewDialog({
	open,
	onOpenChange,
	code,
	language,
	srcdoc,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	code: string;
	language?: string;
	srcdoc: string;
}) {
	const [isCopied, setIsCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(code);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
			toast.success("Code copied to clipboard");
		} catch (error) {
			console.error("Failed to copy code:", error);
			toast.error("Failed to copy code");
		}
	}, [code]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-6xl w-full h-[90vh] flex flex-col p-0 gap-0"
				hideCloseButton
			>
				<DialogHeader className="flex flex-row items-center justify-between px-4 py-3 border-b border-border shrink-0">
					<DialogTitle className="text-sm font-medium uppercase tracking-wide">
						{language || "HTML"} Preview
					</DialogTitle>
					<div className="flex items-center gap-1">
						<Button
							onClick={handleCopy}
							size="icon"
							variant="ghost"
							className={cn(
								"size-7 rounded border border-border bg-background shadow-sm transition-colors",
								isCopied
									? "text-primary"
									: "text-muted-foreground hover:text-foreground",
							)}
							title={isCopied ? "Copied!" : "Copy code"}
						>
							{isCopied ? (
								<CheckIcon className="size-3" />
							) : (
								<CopyIcon className="size-3" />
							)}
						</Button>
					</div>
				</DialogHeader>
				<iframe
					srcDoc={srcdoc}
					sandbox="allow-scripts"
					className="w-full flex-1 border-0 bg-white"
					title="HTML Preview"
				/>
			</DialogContent>
		</Dialog>
	);
}

export const CodeBlock = ({
	code,
	language,
	showLineNumbers = false,
	className,
	children,
	...props
}: CodeBlockProps) => {
	const [isCopied, setIsCopied] = useState(false);
	const [isWrapped, setIsWrapped] = useState(false);
	const [showPreview, setShowPreview] = useState(false);
	const { resolvedTheme } = useTheme();

	const lineCount = useMemo(() => code.split("\n").length, [code]);
	const normalizedLang = useMemo(
		() => normalizeLanguage(language),
		[language],
	);

	const lowerLang = language?.toLowerCase() ?? "";
	const isPreviewable =
		["markup"].includes(normalizedLang) ||
		["html", "htm", "svg"].includes(lowerLang);

	const srcdoc = useMemo(() => {
		if (!isPreviewable) {
			return "";
		}
		return code;
	}, [code, isPreviewable]);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(code);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
			toast.success("Code copied to clipboard");
		} catch (error) {
			console.error("Failed to copy code:", error);
			toast.error("Failed to copy code");
		}
	}, [code]);

	const toggleWrap = useCallback(() => {
		setIsWrapped((prev) => {
			const newState = !prev;
			toast.success(
				newState ? "Code wrap enabled" : "Code wrap disabled",
			);
			return newState;
		});
	}, []);

	// Custom style overrides for the syntax highlighter
	const customStyle = {
		margin: 0,
		padding: "1rem",
		background: "transparent",
		fontSize: "0.875rem",
		lineHeight: "1.625",
	};

	return (
		<CodeBlockContext.Provider value={{ code }}>
			<div
				className={cn(
					"group relative w-full max-w-full min-w-0 rounded-md border border-border bg-muted/30 overflow-hidden",
					className,
				)}
				{...props}
			>
				{/* Header with language label, line count, and action buttons */}
				<div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
					<div className="flex items-center gap-2">
						{language && (
							<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
								{language}
							</span>
						)}
						<span className="text-xs text-muted-foreground">
							{lineCount} {lineCount === 1 ? "line" : "lines"}
						</span>
					</div>

					<div className="flex gap-1">
						<Button
							onClick={toggleWrap}
							size="icon"
							variant="ghost"
							className={cn(
								"size-7 rounded border border-border bg-background shadow-sm transition-colors",
								isWrapped
									? "text-primary"
									: "text-muted-foreground hover:text-foreground",
							)}
							title={isWrapped ? "Disable wrap" : "Enable wrap"}
						>
							{isWrapped ? (
								<ArrowLeftRight className="size-3" />
							) : (
								<WrapText className="size-3" />
							)}
						</Button>
						{isPreviewable && (
							<Button
								onClick={() => setShowPreview(true)}
								size="icon"
								variant="ghost"
								className="size-7 rounded border border-border bg-background shadow-sm transition-colors text-muted-foreground hover:text-foreground"
								title="Preview HTML"
							>
								<EyeIcon className="size-3" />
							</Button>
						)}
						<Button
							onClick={handleCopy}
							size="icon"
							variant="ghost"
							className={cn(
								"size-7 rounded border border-border bg-background shadow-sm transition-colors",
								isCopied
									? "text-primary"
									: "text-muted-foreground hover:text-foreground",
							)}
							title={isCopied ? "Copied!" : "Copy code"}
						>
							{isCopied ? (
								<CheckIcon className="size-3" />
							) : (
								<CopyIcon className="size-3" />
							)}
						</Button>
					</div>
				</div>

				{/* Code content */}
				<div
					className={cn(
						"subtle-scrollbar overflow-x-auto overflow-y-auto max-h-[400px]",
						isWrapped &&
							"[&_pre]:whitespace-pre-wrap [&_pre]:break-words",
						"[&_pre]:!bg-transparent [&_code]:!bg-transparent",
					)}
				>
					<SyntaxHighlighter
						language={normalizedLang}
						style={resolvedTheme === "dark" ? oneDark : oneLight}
						customStyle={customStyle}
						showLineNumbers={showLineNumbers}
						wrapLines={isWrapped}
						wrapLongLines={isWrapped}
					>
						{code}
					</SyntaxHighlighter>
				</div>

				{/* HTML preview dialog */}
				{isPreviewable && (
					<HtmlPreviewDialog
						open={showPreview}
						onOpenChange={setShowPreview}
						code={code}
						language={language}
						srcdoc={srcdoc}
					/>
				)}
				{children}
			</div>
		</CodeBlockContext.Provider>
	);
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	onCopy?: () => void;
	onError?: (error: Error) => void;
	timeout?: number;
};

export const CodeBlockCopyButton = ({
	onCopy,
	onError,
	timeout = 2000,
	children,
	className,
	...props
}: CodeBlockCopyButtonProps) => {
	const [isCopied, setIsCopied] = useState(false);
	const { code } = useContext(CodeBlockContext);

	const copyToClipboard = async () => {
		if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
			onError?.(new Error("Clipboard API not available"));
			return;
		}

		try {
			await navigator.clipboard.writeText(code);
			setIsCopied(true);
			onCopy?.();
			toast.success("Code copied to clipboard");
			setTimeout(() => setIsCopied(false), timeout);
		} catch (error) {
			onError?.(error as Error);
			toast.error("Failed to copy code");
		}
	};

	const Icon = isCopied ? CheckIcon : CopyIcon;

	return (
		<Button
			className={cn("shrink-0", className)}
			onClick={copyToClipboard}
			size="icon"
			variant="ghost"
			{...props}
		>
			{children ?? <Icon size={14} />}
		</Button>
	);
};

/**
 * InlineCode component with click-to-copy functionality
 */
export const InlineCode = ({
	children,
	className,
	...props
}: HTMLAttributes<HTMLElement>) => {
	const t = useTranslations("tooltips.common");
	const [isCopied, setIsCopied] = useState(false);
	const codeText = typeof children === "string" ? children : String(children);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(codeText);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 1500);
			toast.success("Code copied to clipboard");
		} catch (error) {
			console.error("Failed to copy code:", error);
			toast.error("Failed to copy code");
		}
	}, [codeText]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className={cn(
						"inline rounded px-1.5 py-0.5 font-mono text-[0.85em]",
						"bg-muted/50 text-foreground/85 border border-border/40",
						"before:content-none after:content-none",
						"hover:bg-muted/70 active:bg-muted/70 transition-colors duration-150 cursor-pointer",
						"align-baseline text-left",
						isCopied && "ring-1 ring-primary/30 bg-primary/5",
						className,
					)}
					onClick={() => {
						void handleCopy();
					}}
					{...props}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent>
				{isCopied ? t("copied") : t("copy")}
			</TooltipContent>
		</Tooltip>
	);
};
