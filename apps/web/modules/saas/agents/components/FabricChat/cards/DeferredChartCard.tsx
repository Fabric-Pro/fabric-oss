"use client";

import dynamic from "next/dynamic";

export const DeferredChartCard = dynamic(() =>
	import("./ChartCard").then((module) => module.ChartCard),
);
