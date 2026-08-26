import { seedFrameTemplates } from "./frame-templates-seed";

seedFrameTemplates()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("Error seeding templates:", error);
		process.exit(1);
	});
