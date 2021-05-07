/*
  Warnings:

  - The primary key for the `onchain_transaction` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `transactionHash` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `gasLimit` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `gasPrice` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `timestamp` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `raw` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `blockHash` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `blockNumber` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `contractAddress` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `transactionIndex` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `root` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `gasUsed` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `logsBloom` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `logs` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `cumulativeGasUsed` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the column `byzantium` on the `onchain_transaction` table. All the data in the column will be lost.
  - You are about to drop the `ChannelDispute` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TransferDispute` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[confirmedTransactionHash]` on the table `onchain_transaction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[onchainTransactionId]` on the table `transfer` will be added. If there are existing duplicate values, this will fail.
  - The required column `id` was added to the `onchain_transaction` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- DropForeignKey
ALTER TABLE "ChannelDispute" DROP CONSTRAINT "ChannelDispute_channelAddress_fkey";

-- DropForeignKey
ALTER TABLE "TransferDispute" DROP CONSTRAINT "TransferDispute_transferId_fkey";

-- DropForeignKey
ALTER TABLE "transfer" DROP CONSTRAINT "transfer_transactionHash_fkey";

-- DropIndex
DROP INDEX "onchain_transaction.transactionHash_chainId_unique";

-- AlterTable
ALTER TABLE "onchain_transaction" DROP CONSTRAINT "onchain_transaction_pkey",
DROP COLUMN "transactionHash",
DROP COLUMN "gasLimit",
DROP COLUMN "gasPrice",
DROP COLUMN "timestamp",
DROP COLUMN "raw",
DROP COLUMN "blockHash",
DROP COLUMN "blockNumber",
DROP COLUMN "contractAddress",
DROP COLUMN "transactionIndex",
DROP COLUMN "root",
DROP COLUMN "gasUsed",
DROP COLUMN "logsBloom",
DROP COLUMN "logs",
DROP COLUMN "cumulativeGasUsed",
DROP COLUMN "byzantium",
ADD COLUMN     "id" TEXT NOT NULL,
ADD COLUMN     "confirmedTransactionHash" TEXT,
ALTER COLUMN "to" DROP NOT NULL,
ALTER COLUMN "from" DROP NOT NULL,
ALTER COLUMN "data" DROP NOT NULL,
ALTER COLUMN "value" DROP NOT NULL,
ALTER COLUMN "chainId" DROP NOT NULL,
ALTER COLUMN "nonce" DROP NOT NULL,
ADD PRIMARY KEY ("id");

-- DropTable
DROP TABLE "ChannelDispute";

-- DropTable
DROP TABLE "TransferDispute";

-- CreateTable
CREATE TABLE "channel_dispute" (
    "channelAddress" TEXT NOT NULL,
    "channelStateHash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "consensusExpiry" TEXT NOT NULL,
    "defundExpiry" TEXT NOT NULL,

    PRIMARY KEY ("channelAddress")
);

-- CreateTable
CREATE TABLE "transfer_dispute" (
    "transferId" TEXT NOT NULL,
    "transferStateHash" TEXT NOT NULL,
    "transferDisputeExpiry" TEXT NOT NULL,
    "isDefunded" BOOLEAN NOT NULL,

    PRIMARY KEY ("transferId")
);

-- CreateTable
CREATE TABLE "onchain_transaction_attempt" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "onchainTransactionId" TEXT NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "gasLimit" TEXT NOT NULL,
    "gasPrice" TEXT NOT NULL,

    PRIMARY KEY ("transactionHash")
);

-- CreateTable
CREATE TABLE "onchain_transaction_receipt" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transactionHash" TEXT NOT NULL,
    "timestamp" TEXT,
    "raw" TEXT,
    "blockHash" TEXT,
    "blockNumber" INTEGER,
    "contractAddress" TEXT,
    "transactionIndex" INTEGER,
    "root" TEXT,
    "gasUsed" TEXT,
    "logsBloom" TEXT,
    "logs" TEXT,
    "cumulativeGasUsed" TEXT,
    "byzantium" BOOLEAN,
    "status" INTEGER,

    PRIMARY KEY ("transactionHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "onchain_transaction_confirmedTransactionHash_unique" ON "onchain_transaction"("confirmedTransactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_onchainTransactionId_unique" ON "transfer"("onchainTransactionId");

-- AddForeignKey
ALTER TABLE "channel_dispute" ADD FOREIGN KEY ("channelAddress") REFERENCES "channel"("channelAddress") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_dispute" ADD FOREIGN KEY ("transferId") REFERENCES "transfer"("transferId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onchain_transaction_attempt" ADD FOREIGN KEY ("onchainTransactionId") REFERENCES "onchain_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onchain_transaction" ADD FOREIGN KEY ("confirmedTransactionHash") REFERENCES "onchain_transaction_receipt"("transactionHash") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer" ADD FOREIGN KEY ("onchainTransactionId") REFERENCES "onchain_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
