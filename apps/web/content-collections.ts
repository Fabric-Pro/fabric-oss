import type { AnyCollection } from "@content-collections/core";
import { defineCollection, defineConfig } from "@content-collections/core";
import { compileMDX } from "@content-collections/mdx";
import {
	createDocSchema,
	createMetaSchema,
	transformMDX,
} from "@fumadocs/content-collections/configuration";
import { remarkImage, remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { z } from "zod";
import { config } from "../../config/index";

function sanitizePath(path: string) {
	return path
		.replace(/(\.[a-zA-Z-]{2,5})$/, "")
		.replace(/^\//, "")
		.replace(/\/$/, "")
		.replace(/index$/, "");
}

function getLocaleFromFilePath(path: string) {
	return (
		path
			.match(/(\.[a-zA-Z-]{2,5})+\.(md|mdx|json)$/)?.[1]
			?.replace(".", "") ?? config.i18n.defaultLocale
	);
}

const posts = defineCollection({
	name: "posts",
	directory: "content/posts",
	include: "**/*.{mdx,md}",
	schema: z.object({
		title: z.string(),
		date: z.string(),
		image: z.string().optional(),
		coverImage: z.string().optional(), // Support both image and coverImage
		authorName: z.string(),
		authorImage: z.string().optional(),
		authorLink: z.string().optional(),
		excerpt: z.string().optional(),
		tags: z.array(z.string()),
		published: z.boolean(),
		content: z.string(),
	}),
	transform: async (document, context) => {
		const body = await compileMDX(context, document, {
			rehypePlugins: [
				// Skip Shiki for code blocks - we handle them in MDX components
				// This allows Mermaid diagrams to work
			],
			remarkPlugins: [
				[
					remarkImage,
					{
						publicDir: "public",
					},
				],
			],
		});

		// Extract locale from filename or use default
		const locale = getLocaleFromFilePath(document._meta.path);

		// Normalize image field - support both 'image' and 'coverImage'
		const image = document.image || document.coverImage;

		return {
			...document,
			image,
			body,
			locale,
			path: sanitizePath(document._meta.path),
		};
	},
});

const legalPages = defineCollection({
	name: "legalPages",
	directory: "content/legal",
	// .mdx only: content/legal also holds a plain-Markdown README for whoever
	// self-hosts, and it is guidance rather than a legal page — it has no
	// title/content frontmatter and must never render at a public /legal route.
	include: "**/*.mdx",
	schema: z.object({
		title: z.string(),
		content: z.string(),
	}),
	transform: async (document, context) => {
		const body = await compileMDX(context, document);
		const locale = getLocaleFromFilePath(document._meta.path);
		return {
			...document,
			body,
			locale,
			path: sanitizePath(document._meta.path),
		};
	},
});

const docs = defineCollection({
	name: "docs",
	directory: "content/docs",
	include: "**/*.mdx",
	schema: z.object({
		...createDocSchema(z),
		content: z.string(),
	}),
	transform: async (document, context) => {
		const transformed = await transformMDX(document, context, {
			remarkPlugins: [
				[
					remarkImage,
					{
						publicDir: "public",
					},
				],
				remarkMdxMermaid,
			],
		});
		const locale = getLocaleFromFilePath(document._meta.path);
		return { ...transformed, locale };
	},
});

const docsMeta = defineCollection({
	name: "docsMeta",
	directory: "content/docs",
	include: "**/meta*.json",
	parser: "json",
	schema: z.object(createMetaSchema(z)),
});

export default defineConfig({
	collections: [
		posts,
		legalPages,
		docs,
		docsMeta,
	] as unknown as AnyCollection[],
});
