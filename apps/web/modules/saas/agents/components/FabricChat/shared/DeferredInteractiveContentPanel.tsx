"use client";

import dynamic from "next/dynamic";

export const DeferredInteractiveContentPanel = dynamic(() =>
	import("./InteractiveContentPanel").then(
		(module) => module.InteractiveContentPanel,
	),
);
