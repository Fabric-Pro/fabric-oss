CREATE TYPE "qa_run_mode" AS ENUM ('MODE_A', 'MODE_B');

ALTER TABLE "test_case"
    ADD COLUMN "playwrightScript" TEXT;

ALTER TABLE "test_agentic_run"
    ADD COLUMN "runMode" "qa_run_mode" NOT NULL DEFAULT 'MODE_A';

ALTER TABLE "test_run_configuration"
    ADD COLUMN "runMode" "qa_run_mode" NOT NULL DEFAULT 'MODE_A';
