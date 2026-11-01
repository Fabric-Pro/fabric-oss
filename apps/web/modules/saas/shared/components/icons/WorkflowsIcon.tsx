import type { SVGProps } from "react";

/**
 * Databricks Workspace Workflows / DAG glyph as a 1.5px stroke outline icon
 * inheriting `currentColor` across light and dark themes.
 */
export function WorkflowsIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="1em"
			height="1em"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			<rect width="6" height="6" x="3" y="3" rx="1.5" />
			<rect width="6" height="6" x="15" y="3" rx="1.5" />
			<rect width="6" height="6" x="9" y="15" rx="1.5" />
			<path d="M6 9v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9" />
			<path d="M12 14v1" />
		</svg>
	);
}
