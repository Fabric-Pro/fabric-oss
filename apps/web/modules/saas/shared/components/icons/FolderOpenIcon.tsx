import type { SVGProps } from "react";

export function FolderOpenIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="1em"
			height="1em"
			fill="none"
			viewBox="0 0 24 24"
			aria-hidden="true"
			{...props}
		>
			<path
				fill="currentColor"
				fillRule="evenodd"
				d="M20.533 10 20 6H9.414L7.901 4.12A3 3 0 0 0 5.563 3H0l2 18h20l2-11h-3.467ZM6.343 5.373 8.457 8h9.792l.267 2H4l-.751 4.13L2.235 5h3.328a1 1 0 0 1 .78.373Z"
				clipRule="evenodd"
			/>
		</svg>
	);
}
