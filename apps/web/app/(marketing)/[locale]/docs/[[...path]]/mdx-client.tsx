"use client";

import { MDXContent } from "@content-collections/mdx/react";
import { Mermaid } from "@marketing/blog/components/Mermaid";
import { Card, Cards } from "fumadocs-ui/components/card";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

interface MdxClientProps {
	code: string;
}

const components = {
	...defaultMdxComponents,
	Card,
	Cards,
	Tabs,
	Tab,
	Steps,
	Step,
	File,
	Folder,
	Files,
	Mermaid,
	img: (props: React.ComponentProps<typeof ImageZoom>) => (
		<ImageZoom
			{...props}
			className="rounded-lg border-4 border-secondary/10"
		/>
	),
} as MDXComponents;

export function MdxClient({ code }: MdxClientProps) {
	return <MDXContent code={code} components={components} />;
}
