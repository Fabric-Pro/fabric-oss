-- AlterTable: a user-chosen edge `kind` (re-typed connection) the read overlay
-- applies over the detected AI/structural kind.
ALTER TABLE "code_understanding_edge_override"
    ADD COLUMN "isUserKind" BOOLEAN NOT NULL DEFAULT false;
