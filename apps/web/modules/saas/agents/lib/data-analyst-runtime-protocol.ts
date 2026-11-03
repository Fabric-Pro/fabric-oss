import { z } from "zod";

export {
	DATA_ANALYST_AGENT_ID,
	DATA_ANALYST_EVENT,
} from "./data-analyst-runtime-contract";

export const dataAnalystPropsSchema = z.object({}).strict();
export type DataAnalystProps = z.infer<typeof dataAnalystPropsSchema>;

const chartTypeSchema = z.enum(["line", "bar", "pie", "area", "scatter"]);
const chartConfigSchema = z.object({
	xAxis: z.string(),
	yAxis: z.union([z.string(), z.array(z.string())]),
	title: z.string().optional(),
	series: z.string().optional(),
	stacked: z.boolean().optional(),
	showLegend: z.boolean().optional(),
});
export const dataAnalystChartArgsSchema = z.object({
	chartType: chartTypeSchema,
	data: z.array(z.record(z.string(), z.unknown())),
	config: chartConfigSchema,
	sourceDescription: z.string().optional(),
});
const dataAnalystChartSchema = dataAnalystChartArgsSchema.extend({
	type: z.literal("chart"),
	id: z.string(),
	metadata: z
		.object({
			createdAt: z.string().optional(),
			sourceDescription: z.string().optional(),
			dataPointCount: z.number().optional(),
			totalValue: z.number().optional(),
		})
		.optional(),
});
export type DataAnalystChart = z.infer<typeof dataAnalystChartSchema>;
export const dataAnalystChartEventSchema = z.object({
	toolCallId: z.string(),
	chart: dataAnalystChartSchema,
});
