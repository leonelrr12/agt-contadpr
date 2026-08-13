-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerified" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "auth_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_token_tokenHash_key" ON "auth_token"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_token_userId_idx" ON "auth_token"("userId");

-- AddForeignKey
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
