-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "run_id_onchain" BYTEA,
    "status" TEXT NOT NULL,
    "budget_usdc" DECIMAL(20,6) NOT NULL,
    "spent_gas_usdc" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "spent_pay_usdc" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "run_eth_usd" DECIMAL(20,6) NOT NULL,
    "deadline" TIMESTAMPTZ(6),
    "plan" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealed_at" TIMESTAMPTZ(6),

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "idx" INTEGER NOT NULL,
    "target_addr" BYTEA NOT NULL,
    "function_name" TEXT NOT NULL,
    "function_args" JSONB NOT NULL,
    "payload_hash" BYTEA NOT NULL,
    "evidence" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "depends_on" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "gas_budget_usdc" DECIMAL(20,6),
    "veto_reason" TEXT,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "execution_id" TEXT,
    "tx_hash" BYTEA,
    "tx_link" TEXT,
    "gas_used_wei" DECIMAL,
    "gas_used_usdc" DECIMAL(20,6),
    "would_revert" BOOLEAN,
    "revert_reason" TEXT,
    "kh_status" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "item_idx" INTEGER,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifests" (
    "run_id" UUID NOT NULL,
    "json" JSONB NOT NULL,
    "sha256" BYTEA NOT NULL,
    "exported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manifests_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runs_run_id_onchain_key" ON "runs"("run_id_onchain");

-- CreateIndex
CREATE UNIQUE INDEX "items_run_id_idx_key" ON "items"("run_id", "idx");

-- CreateIndex
CREATE INDEX "attempts_item_id_attempt_no_idx" ON "attempts"("item_id", "attempt_no");

-- CreateIndex
CREATE INDEX "events_run_id_at_idx" ON "events"("run_id", "at");

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
