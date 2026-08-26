"use client";

import { memo, useMemo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import {
	chatMarkdownComponents,
	getChatMarkdownClassName,
} from "./chat-markdown";
import { normalizeTextToMarkdown } from "./text-normalizer";

interface ResponseProps {
	children?: string;
	className?: string;
	components?: Record<string, any>;
	remarkPlugins?: StreamdownProps["remarkPlugins"];
	streaming?: boolean;
	/**
	 * Normalize Unicode formatting to markdown (default: true).
	 * Converts Unicode bullets (•), decorative headers, etc. to proper markdown.
	 * Useful for reasoning models that output plain text with Unicode formatting.
	 */
	normalizeMarkdown?: boolean;
}

export const Response = memo(
	({
		children,
		className,
		components,
		remarkPlugins,
		streaming = false,
		normalizeMarkdown = true,
	}: ResponseProps) => {
		// Normalize text to convert Unicode formatting to markdown
		const normalizedText = useMemo(() => {
			if (!children) {
				return "";
			}
			if (!normalizeMarkdown || typeof children !== "string") {
				return children;
			}
			let text = normalizeTextToMarkdown(children);
			// Convert relative image proxy URLs to absolute so rehype-harden can resolve them
			// (rehype-harden blocks relative URLs when defaultOrigin is not set)
			if (
				typeof window !== "undefined" &&
				text.includes("/api/storage/image")
			) {
				text = text.replace(
					/!\[([^\]]*)\]\(\/api\/storage\/image\?/g,
					`![$1](${window.location.origin}/api/storage/image?`,
				);
			}
			return text;
		}, [children, normalizeMarkdown]);

		return (
			<Streamdown
				className={getChatMarkdownClassName(className)}
				components={{ ...chatMarkdownComponents, ...components }}
				remarkPlugins={remarkPlugins}
				parseIncompleteMarkdown={streaming}
			>
				{normalizedText}
			</Streamdown>
		);
	},
	(prevProps, nextProps) =>
		prevProps.children === nextProps.children &&
		prevProps.className === nextProps.className &&
		prevProps.streaming === nextProps.streaming &&
		prevProps.normalizeMarkdown === nextProps.normalizeMarkdown &&
		prevProps.remarkPlugins === nextProps.remarkPlugins,
);

Response.displayName = "Response";
