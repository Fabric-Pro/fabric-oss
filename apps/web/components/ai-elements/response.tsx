"use client";

import { getBaseUrl } from "@repo/utils/base-url";
import { memo, useMemo } from "react";
import {
	defaultRehypePlugins,
	Streamdown,
	type StreamdownProps,
} from "streamdown";
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
		const rehypePlugins = useMemo(
			() =>
				Object.values(defaultRehypePlugins).map<
					NonNullable<StreamdownProps["rehypePlugins"]>[number]
				>((plugin) => {
					if (
						plugin !== defaultRehypePlugins.harden ||
						!Array.isArray(plugin)
					) {
						return plugin;
					}
					return [
						plugin[0],
						{ ...plugin[1], defaultOrigin: getBaseUrl() },
					];
				}),
			[],
		);
		// Normalize text to convert Unicode formatting to markdown
		const normalizedText = useMemo(() => {
			if (!children) {
				return "";
			}
			if (!normalizeMarkdown || typeof children !== "string") {
				return children;
			}
			return normalizeTextToMarkdown(children);
		}, [children, normalizeMarkdown]);

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
		prevProps.remarkPlugins === nextProps.remarkPlugins,
);

Response.displayName = "Response";
