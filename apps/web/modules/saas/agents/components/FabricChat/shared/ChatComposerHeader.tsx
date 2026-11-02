import type { ReactNode } from "react";

export function ChatComposerHeader({
	showSelection,
	showActions,
	selection,
	children,
}: {
	showSelection: boolean;
	showActions: boolean;
	selection: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="grid w-full min-w-0 gap-1">
			{showSelection && (
				<div className="flex h-12 min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap px-1 py-1 [scrollbar-width:thin] [&>*]:shrink-0">
					{selection}
				</div>
			)}
			{showActions && (
				<div className="flex h-12 min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap px-1 py-1 [scrollbar-width:thin] [&>*]:shrink-0">
					{children}
				</div>
			)}
		</div>
	);
}
