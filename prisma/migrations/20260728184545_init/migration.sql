-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "ianaTimezone" TEXT NOT NULL,
    "feePercentBps" INTEGER NOT NULL DEFAULT 290,
    "feeFixedMinor" INTEGER NOT NULL DEFAULT 30,
    "feeToleranceBps" INTEGER NOT NULL DEFAULT 50,
    "agingWindowDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "watermark" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "payoutsSeen" INTEGER NOT NULL DEFAULT 0,
    "transactionsSeen" INTEGER NOT NULL DEFAULT 0,
    "ordersSeen" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "legacyId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "payoutDate" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "computedGrossMinor" BIGINT,
    "computedFeesMinor" BIGINT,
    "computedRefundsMinor" BIGINT,
    "computedAdjustmentsMinor" BIGINT,
    "computedNetMinor" BIGINT,
    "varianceMinor" BIGINT,
    "reconStatus" TEXT NOT NULL DEFAULT 'pending',
    "transactionsSyncedAt" DATETIME,
    "reconciledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BalanceTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "transactionDate" DATETIME NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceOrderTransactionId" TEXT,
    "associatedOrderGid" TEXT,
    "matchState" TEXT NOT NULL DEFAULT 'unmatched',
    "matchTargetType" TEXT,
    "matchTargetId" TEXT,
    "matchReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BalanceTransaction_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "financialStatus" TEXT,
    "processedAt" DATETIME NOT NULL,
    "shopifyUpdatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrderTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "detailJson" TEXT NOT NULL,
    "note" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shop_key" ON "Shop"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCursor_shop_resource_key" ON "SyncCursor"("shop", "resource");

-- CreateIndex
CREATE INDEX "SyncRun_shop_status_idx" ON "SyncRun"("shop", "status");

-- CreateIndex
CREATE INDEX "SyncRun_shop_startedAt_idx" ON "SyncRun"("shop", "startedAt");

-- CreateIndex
CREATE INDEX "Payout_shop_payoutDate_idx" ON "Payout"("shop", "payoutDate");

-- CreateIndex
CREATE INDEX "Payout_shop_reconStatus_idx" ON "Payout"("shop", "reconStatus");

-- CreateIndex
CREATE INDEX "Payout_shop_status_idx" ON "Payout"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_shop_shopifyGid_key" ON "Payout"("shop", "shopifyGid");

-- CreateIndex
CREATE INDEX "BalanceTransaction_shop_payoutId_idx" ON "BalanceTransaction"("shop", "payoutId");

-- CreateIndex
CREATE INDEX "BalanceTransaction_shop_matchState_idx" ON "BalanceTransaction"("shop", "matchState");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceTransaction_shop_shopifyGid_key" ON "BalanceTransaction"("shop", "shopifyGid");

-- CreateIndex
CREATE INDEX "Order_shop_processedAt_idx" ON "Order"("shop", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_shopifyGid_key" ON "Order"("shop", "shopifyGid");

-- CreateIndex
CREATE INDEX "OrderTransaction_orderId_idx" ON "OrderTransaction"("orderId");

-- CreateIndex
CREATE INDEX "OrderTransaction_shop_gateway_processedAt_idx" ON "OrderTransaction"("shop", "gateway", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderTransaction_shop_shopifyGid_key" ON "OrderTransaction"("shop", "shopifyGid");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_shop_shopifyGid_key" ON "Refund"("shop", "shopifyGid");

-- CreateIndex
CREATE INDEX "Discrepancy_shop_status_idx" ON "Discrepancy"("shop", "status");

-- CreateIndex
CREATE INDEX "Discrepancy_shop_type_idx" ON "Discrepancy"("shop", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Discrepancy_shop_type_subjectType_subjectId_key" ON "Discrepancy"("shop", "type", "subjectType", "subjectId");
