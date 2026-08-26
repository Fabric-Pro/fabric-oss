"use client";

import { LocaleLink } from "@i18n/routing";
import { slugifyHeadline } from "@shared/lib/content";
import type { MDXComponents } from "mdx/types";
import type { ImageProps } from "next/image";
import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
	oneDark,
	oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { Mermaid } from "../components/Mermaid";

export const mdxComponents = {
	a: (props) => {
		const { href, children, ...rest } = props;
		const isInternalLink =
			href && (href.startsWith("/") || href.startsWith("#"));

		return isInternalLink ? (
			<LocaleLink href={href} {...rest}>
				{children}
			</LocaleLink>
		) : (
			<a target="_blank" rel="noopener noreferrer" href={href} {...rest}>
				{children}
			</a>
		);
	},
	pre: ({ children, ...props }: any) => {
		// Handle different possible structures
		let codeElement = children;

		// If children is an array, find the code element
		if (Array.isArray(children)) {
			codeElement = children.find(
				(child: any) =>
					child?.type === "code" ||
					child?.props?.className?.includes("language-"),
			);
		}

		// Extract code content and language
		if (codeElement?.props) {
			const { className = "", children: codeContent } = codeElement.props;
			const match = className.match(/language-(\w+)/);
			const language = match ? match[1] : "text";

			// Get the actual code string
			let code = codeContent;
			if (typeof code !== "string") {
				code = String(code || "");
			}

			// Render Mermaid diagrams
			if (language === "mermaid") {
				return <Mermaid chart={code} />;
			}

			// Render syntax-highlighted code
			return <CodeBlock language={language} code={code} />;
		}

		// Fallback for plain pre blocks
		return (
			<pre
				className="my-6 overflow-auto rounded-lg border bg-muted p-4 font-mono text-sm"
				{...props}
			>
				{children}
			</pre>
		);
	},
	code: ({ className, children, ...props }: any) => {
		// Inline code only (block code is handled by pre)
		if (!className) {
			return (
				<code
					className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
					{...props}
				>
					{children}
				</code>
			);
		}

		// Block code (let pre handle it)
		return (
			<code className={className} {...props}>
				{children}
			</code>
		);
	},
	img: (props) =>
		props.src ? (
			<Image
				{...(props as ImageProps)}
				sizes="100vw"
				style={{ width: "100%", height: "auto" }}
				className="rounded-lg shadow"
				loading="lazy"
			/>
		) : null,
	h1: ({ children, ...rest }) => {
		const id = slugifyHeadline(children as string);
		return (
			<h1
				id={id}
				className="group mb-6 font-bold text-4xl scroll-mt-20"
				{...rest}
			>
				<a href={`#${id}`} className="no-underline hover:underline">
					{children}
				</a>
				<a
					href={`#${id}`}
					className="ml-2 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity"
				>
					#
				</a>
			</h1>
		);
	},
	h2: ({ children, ...rest }) => {
		const id = slugifyHeadline(children as string);
		return (
			<h2
				id={id}
				className="group mb-4 font-bold text-2xl scroll-mt-20"
				{...rest}
			>
				<a href={`#${id}`} className="no-underline hover:underline">
					{children}
				</a>
				<a
					href={`#${id}`}
					className="ml-2 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity"
				>
					#
				</a>
			</h2>
		);
	},
	h3: ({ children, ...rest }) => {
		const id = slugifyHeadline(children as string);
		return (
			<h3
				id={id}
				className="group mb-4 font-bold text-xl scroll-mt-20"
				{...rest}
			>
				<a href={`#${id}`} className="no-underline hover:underline">
					{children}
				</a>
				<a
					href={`#${id}`}
					className="ml-2 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity"
				>
					#
				</a>
			</h3>
		);
	},
	h4: ({ children, ...rest }) => {
		const id = slugifyHeadline(children as string);
		return (
			<h4
				id={id}
				className="group mb-4 font-bold text-lg scroll-mt-20"
				{...rest}
			>
				<a href={`#${id}`} className="no-underline hover:underline">
					{children}
				</a>
				<a
					href={`#${id}`}
					className="ml-2 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity"
				>
					#
				</a>
			</h4>
		);
	},
	h5: ({ children, ...rest }) => {
		const id = slugifyHeadline(children as string);
		return (
			<h5
				id={id}
				className="group mb-4 font-bold text-base scroll-mt-20"
				{...rest}
			>
				<a href={`#${id}`} className="no-underline hover:underline">
					{children}
				</a>
				<a
					href={`#${id}`}
					className="ml-2 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity"
				>
					#
				</a>
			</h5>
		);
	},
	h6: ({ children, ...rest }) => {
		const id = slugifyHeadline(children as string);
		return (
			<h6
				id={id}
				className="group mb-4 font-bold text-sm scroll-mt-20"
				{...rest}
			>
				<a href={`#${id}`} className="no-underline hover:underline">
					{children}
				</a>
				<a
					href={`#${id}`}
					className="ml-2 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity"
				>
					#
				</a>
			</h6>
		);
	},
	p: ({ children, ...rest }) => (
		<p className="mb-6 text-foreground/60 leading-relaxed" {...rest}>
			{children}
		</p>
	),
	ul: ({ children, ...rest }) => (
		<ul className="mb-6 list-inside list-disc space-y-2 pl-4" {...rest}>
			{children}
		</ul>
	),
	ol: ({ children, ...rest }) => (
		<ol className="mb-6 list-inside list-decimal space-y-2 pl-4" {...rest}>
			{children}
		</ol>
	),
	li: ({ children, ...rest }) => <li {...rest}>{children}</li>,
	table: ({ children, ...rest }) => (
		<div className="my-6 overflow-x-auto rounded-lg border">
			<table className="w-full border-collapse text-sm" {...rest}>
				{children}
			</table>
		</div>
	),
	thead: ({ children, ...rest }) => (
		<thead className="bg-muted/50" {...rest}>
			{children}
		</thead>
	),
	tbody: ({ children, ...rest }) => (
		<tbody className="divide-y divide-border" {...rest}>
			{children}
		</tbody>
	),
	tr: ({ children, ...rest }) => (
		<tr className="border-b border-border last:border-0" {...rest}>
			{children}
		</tr>
	),
	th: ({ children, ...rest }) => (
		<th
			className="px-4 py-3 text-left font-semibold text-foreground"
			{...rest}
		>
			{children}
		</th>
	),
	td: ({ children, ...rest }) => (
		<td className="px-4 py-3 text-foreground/70" {...rest}>
			{children}
		</td>
	),
} satisfies MDXComponents;

// Code block with syntax highlighting
function CodeBlock({ language, code }: { language: string; code: string }) {
	const [mounted, setMounted] = useState(false);
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		setMounted(true);
	}, []);

	const isDark = resolvedTheme === "dark";
	const showLineNumbers = language !== "text" && language !== "bash";

	// SSR: render a plain code block to avoid hydration mismatch
	// SyntaxHighlighter generates different HTML based on theme
	if (!mounted) {
		return (
			<div className="my-6 overflow-hidden rounded-lg border">
				<pre
					className="overflow-auto bg-muted/50 p-4 text-sm leading-relaxed"
					style={{ margin: 0 }}
				>
					<code>{code}</code>
				</pre>
			</div>
		);
	}

	return (
		<div className="my-6 overflow-hidden rounded-lg border">
			<SyntaxHighlighter
				language={language}
				style={isDark ? oneDark : oneLight}
				customStyle={{
					margin: 0,
					padding: "1rem",
					fontSize: "0.875rem",
					lineHeight: "1.5",
				}}
				showLineNumbers={showLineNumbers}
			>
				{code}
			</SyntaxHighlighter>
		</div>
	);
}
