"use client";

import { cn } from "@ui/lib";
import { Mermaid } from "../../modules/marketing/blog/components/Mermaid";
import { CodeBlock, CodeBlockCopyButton, InlineCode } from "./code-block";

const BLOCK_ELEMENT_TAGS = new Set([
	"div",
	"figure",
	"table",
	"pre",
	"blockquote",
	"ul",
	"ol",
]);

const CHAT_MARKDOWN_CLASSNAME =
	"streamdown w-full font-sans text-[15px] leading-7 text-foreground antialiased [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

function hasBlockElements(children: unknown): boolean {
	const childArray = Array.isArray(children) ? children : [children];

	return childArray.some((child: any) => {
		if (!child) {
			return false;
		}

		if (
			typeof child?.type === "string" &&
			BLOCK_ELEMENT_TAGS.has(child.type)
		) {
			return true;
		}

		if (child?.props?.["data-streamdown"]) {
			return true;
		}

		if (child?.type === "img" || child?.props?.src) {
			return true;
		}

		if (
			typeof child?.type === "function" &&
			child.type.name?.toLowerCase().includes("image")
		) {
			return true;
		}

		if (child?.props?.children) {
			return hasBlockElements(child.props.children);
		}

		return false;
	});
}

function extractCodeBlock(children: unknown): {
	code: string;
	language: string;
} {
	const child = Array.isArray(children) ? children[0] : children;
	const rawChildren = child?.props?.children;
	const code =
		typeof rawChildren === "string"
			? rawChildren
			: Array.isArray(rawChildren)
				? rawChildren.join("")
				: "";

	const className: string = child?.props?.className ?? "";
	const dataLang: string | undefined = child?.props?.["data-language"];
	const match =
		/language-([A-Za-z0-9+#-]+)/.exec(className || "") ??
		/lang-([A-Za-z0-9+#-]+)/.exec(className || "");
	const language = dataLang || match?.[1] || "plaintext";

	return { code, language };
}

function isMermaidBlock(language: string, code: string): boolean {
	if (language.toLowerCase() === "mermaid") {
		return true;
	}

	const trimmed = code.trimStart();
	return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart-beta)\b/.test(
		trimmed,
	);
}

export const chatMarkdownComponents = {
	p: ({ children, ...props }: any) => {
		if (hasBlockElements(children)) {
			return (
				<div
					style={{ color: "inherit" }}
					className="my-3 text-[15px] leading-7 text-foreground"
					{...props}
				>
					{children}
				</div>
			);
		}

		return (
			<p
				style={{ color: "inherit" }}
				className="my-3 text-[15px] leading-7 text-foreground"
				{...props}
			>
				{children}
			</p>
		);
	},
	h1: ({ children, ...props }: any) => (
		<h1
			style={{ color: "inherit" }}
			className="mt-3 mb-2.5 font-sans text-[1.12rem] font-semibold leading-[1.2] tracking-tight text-foreground first:mt-0"
			{...props}
		>
			{children}
		</h1>
	),
	h2: ({ children, ...props }: any) => (
		<h2
			style={{ color: "inherit" }}
			className="mt-3 mb-2 font-sans text-[1rem] font-semibold leading-[1.25] tracking-tight text-foreground first:mt-0"
			{...props}
		>
			{children}
		</h2>
	),
	h3: ({ children, ...props }: any) => (
		<h3
			style={{ color: "inherit" }}
			className="mt-2.5 mb-1.5 font-sans text-[0.95rem] font-semibold leading-[1.35] text-foreground first:mt-0"
			{...props}
		>
			{children}
		</h3>
	),
	h4: ({ children, ...props }: any) => (
		<h4
			style={{ color: "inherit" }}
			className="mt-2.5 mb-1.5 font-sans text-[0.9rem] font-semibold leading-[1.35] text-foreground"
			{...props}
		>
			{children}
		</h4>
	),
	h5: ({ children, ...props }: any) => (
		<h5
			style={{ color: "inherit" }}
			className="mt-3 mb-2 font-sans text-sm font-semibold text-foreground"
			{...props}
		>
			{children}
		</h5>
	),
	h6: ({ children, ...props }: any) => (
		<h6
			style={{ color: "inherit" }}
			className="mt-3 mb-2 font-sans text-sm font-medium text-muted-foreground"
			{...props}
		>
			{children}
		</h6>
	),
	table: ({ children, ...props }: any) => (
		<div className="my-4 overflow-x-auto rounded-xl border border-border/60 bg-background/50 shadow-sm">
			<table
				style={{ color: "inherit" }}
				className="w-full min-w-[32rem] border-collapse text-left text-sm"
				{...props}
			>
				{children}
			</table>
		</div>
	),
	thead: ({ children, ...props }: any) => (
		<thead className="bg-muted/70 text-foreground" {...props}>
			{children}
		</thead>
	),
	tbody: ({ children, ...props }: any) => (
		<tbody className="divide-y divide-border/60" {...props}>
			{children}
		</tbody>
	),
	tr: ({ children, ...props }: any) => (
		<tr
			className="border-b border-border/50 align-top odd:bg-background/30 even:bg-background/10"
			{...props}
		>
			{children}
		</tr>
	),
	th: ({ children, ...props }: any) => (
		<th
			className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
			{...props}
		>
			{children}
		</th>
	),
	td: ({ children, ...props }: any) => (
		<td
			className="px-4 py-3 text-[14px] leading-6 text-foreground"
			{...props}
		>
			{children}
		</td>
	),
	ul: ({ children, ...props }: any) => (
		<ul className="my-3 list-disc space-y-1.5 pl-6" {...props}>
			{children}
		</ul>
	),
	ol: ({ children, ...props }: any) => (
		<ol className="my-3 list-decimal space-y-1.5 pl-6" {...props}>
			{children}
		</ol>
	),
	li: ({ children, ...props }: any) => (
		<li className="text-[15px] leading-7 text-foreground" {...props}>
			{children}
		</li>
	),
	strong: ({ children, ...props }: any) => (
		<strong className="font-semibold text-foreground" {...props}>
			{children}
		</strong>
	),
	em: ({ children, ...props }: any) => (
		<em className="italic text-foreground" {...props}>
			{children}
		</em>
	),
	code: ({ children, ...props }: any) => (
		<InlineCode {...props}>{children}</InlineCode>
	),
	pre: ({ children, ...props }: any) => {
		const { code, language } = extractCodeBlock(children);

		if (isMermaidBlock(language, code)) {
			return (
				<div className="my-4 overflow-hidden rounded-2xl border border-border/60 bg-background/60">
					<Mermaid chart={code} />
				</div>
			);
		}

		return (
			<CodeBlock
				code={code}
				language={language}
				className="my-3"
				style={{ color: "inherit" }}
				{...props}
			>
				<CodeBlockCopyButton aria-label="Copy code" />
			</CodeBlock>
		);
	},
	a: ({ children, href, ...props }: any) => (
		<a
			href={href}
			className="text-primary underline-offset-4 transition-colors hover:underline"
			target="_blank"
			rel="noopener noreferrer"
			{...props}
		>
			{children}
		</a>
	),
	blockquote: ({ children, ...props }: any) => (
		<blockquote
			className="my-4 border-l-4 border-primary/40 bg-muted/20 py-1 pl-4 italic text-muted-foreground"
			{...props}
		>
			{children}
		</blockquote>
	),
	img: ({ alt, src, ...props }: any) => {
		const isRealImage =
			src &&
			(src.startsWith("http") || src.startsWith("/api/storage/image"));
		if (!isRealImage) {
			return null;
		}

		return (
			<>
				{/* biome-ignore lint/performance/noImgElement: markdown responses may contain trusted remote images */}
				<img
					alt={alt || ""}
					src={src}
					className="my-3 h-auto max-w-full rounded-lg"
					{...props}
				/>
			</>
		);
	},
	result: ({ children }: any) => <span>{children}</span>,
	output: ({ children }: any) => <span>{children}</span>,
	error: ({ children }: any) => <span>{children}</span>,
	name: ({ children }: any) => <span>{children}</span>,
	account: ({ children }: any) => <span>{children}</span>,
	account_slug: ({ children }: any) => <span>{children}</span>,
	board: ({ children }: any) => <span>{children}</span>,
	card: ({ children }: any) => <span>{children}</span>,
	column: ({ children }: any) => <span>{children}</span>,
	unknown: ({ children }: any) => <span>{children}</span>,
};

export function getChatMarkdownClassName(className?: string) {
	return cn(CHAT_MARKDOWN_CLASSNAME, className);
}
