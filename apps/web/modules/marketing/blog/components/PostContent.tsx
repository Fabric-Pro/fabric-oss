"use client";

import { MDXContent } from "@content-collections/mdx/react";
import { mdxComponents } from "../utils/mdx-components";

export function PostContent({ content }: { content: string }) {
	return (
		<div className="prose prose-lg dark:prose-invert mx-auto mt-6 max-w-4xl [&>h1:first-of-type]:hidden">
			<MDXContent code={content} components={mdxComponents} />
		</div>
	);
}
