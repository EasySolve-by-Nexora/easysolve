-- Indexes for the hottest per-user queries and the expiry sweeps.
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE INDEX IF NOT EXISTS "Reset_userId_idx" ON "Reset"("userId");
CREATE INDEX IF NOT EXISTS "Reset_expiresAt_idx" ON "Reset"("expiresAt");
CREATE INDEX IF NOT EXISTS "RateLimit_expiresAt_idx" ON "RateLimit"("expiresAt");
CREATE INDEX IF NOT EXISTS "Issue_userId_status_idx" ON "Issue"("userId", "status");
CREATE INDEX IF NOT EXISTS "Issue_userId_updatedAt_idx" ON "Issue"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "Run_userId_status_idx" ON "Run"("userId", "status");
CREATE INDEX IF NOT EXISTS "Run_userId_createdAt_idx" ON "Run"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Job_userId_status_idx" ON "Job"("userId", "status");
CREATE INDEX IF NOT EXISTS "Message_userId_conversation_createdAt_idx" ON "Message"("userId", "conversation", "createdAt");
CREATE INDEX IF NOT EXISTS "Usage_userId_createdAt_idx" ON "Usage"("userId", "createdAt");

-- Lets a crashed "posting" application be recovered after a grace period.
ALTER TABLE "Application" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
