-- CreateEnum
CREATE TYPE "BackfillRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "BackfillRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "status" "BackfillRunStatus" NOT NULL DEFAULT 'QUEUED',
    "processed" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "hasMoreAfter" BOOLEAN NOT NULL DEFAULT true,
    "hasMoreBefore" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BackfillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackfillRun_emailAccountId_status_idx" ON "BackfillRun"("emailAccountId", "status");

-- AddForeignKey
ALTER TABLE "BackfillRun" ADD CONSTRAINT "BackfillRun_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
