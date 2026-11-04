-- Run outside a transaction: reports remain writable during the index build.
CREATE INDEX CONCURRENTLY "template_instance_projectId_idx" ON "template_instance"("projectId");
