"use client";

import { TabsContent } from "@ui/components/tabs";
import type { ReactNode } from "react";

/**
 * A tab of the report page. For a viewer who may read the report but not
 * change it, the tab renders as a disabled fieldset: a native disabled
 * fieldset reaches inputs, selects, switches and buttons alike, so no control
 * has to be gated one by one.
 */
export function ReportTabContent({
	value,
	readOnly = false,
	className,
	children,
}: {
	value: string;
	readOnly?: boolean;
	className?: string;
	children: ReactNode;
}) {
	if (!readOnly) {
		return (
			<TabsContent value={value} className={className}>
				{children}
			</TabsContent>
		);
	}
	return (
		<TabsContent value={value} className={className} asChild>
			<fieldset disabled className="m-0 min-w-0 border-0 p-0">
				{children}
			</fieldset>
		</TabsContent>
	);
}
