"use client";

import { memo, useMemo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { normalizeChatHeadingOutline } from "./chat-heading-outline";
import {
	chatMarkdownComponents,
	getChatMarkdownClassName,
	getChatMarkdownRehypePlugins,
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
	/** Normalize a chat answer beneath its page heading; authored documents keep their outline. */
	normalizeHeadings?: boolean;
}

export const Response = memo(
	({
		children,
		className,
		components,
		remarkPlugins,
		streaming = false,
		normalizeMarkdown = true,
		normalizeHeadings = false,
	}: ResponseProps) => {
		const rehypePlugins = useMemo(getChatMarkdownRehypePlugins, []);
		// Normalize text to convert Unicode formatting to markdown
		const normalizedText = useMemo(() => {
			if (!children) {
				return "";
			}
			const text = normalizeMarkdown
				? normalizeTextToMarkdown(children)
				: children;
			return normalizeHeadings ? normalizeChatHeadingOutline(text) : text;
		}, [children, normalizeMarkdown, normalizeHeadings]);

		return (
			<Streamdown
				className={getChatMarkdownClassName(className)}
				components={{ ...chatMarkdownComponents, ...components }}
				rehypePlugins={rehypePlugins}
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
		prevProps.normalizeHeadings === nextProps.normalizeHeadings &&
		prevProps.remarkPlugins === nextProps.remarkPlugins,
);

Response.displayName = "Response";
