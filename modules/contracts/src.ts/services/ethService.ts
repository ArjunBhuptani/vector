import {
  FullChannelState,
  IVectorChainService,
  MinimalTransaction,
  ChainError,
  Result,
  ERC20Abi,
  IChainServiceStore,
  TransactionReason,
  FullTransferState,
  UINT_MAX,
  jsonifyError,
  ChainServiceEvents,
  ChainServiceEvent,
  ChainServiceEventMap,
  StringifiedTransactionReceipt,
  StringifiedTransactionResponse,
  getConfirmationsForChain,
  StoredTransaction,
} from "@connext/vector-types";
import {
  delay,
  encodeTransferResolver,
  encodeTransferState,
  getRandomBytes32,
  generateMerkleTreeData,
  hashCoreTransferState,
} from "@connext/vector-utils";
import { Signer } from "@ethersproject/abstract-signer";
import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { BaseLogger } from "pino";
import PriorityQueue from "p-queue";
import { AddressZero, HashZero } from "@ethersproject/constants";
import { Evt } from "evt";
import { v4 as uuidV4 } from "uuid";

import { ChannelFactory, VectorChannel } from "../artifacts";

import { EthereumChainReader } from "./ethReader";
import { parseUnits } from "ethers/lib/utils";

export const EXTRA_GAS = 50_000;
// The amount of time (ms) to wait before a confirmation polling period times out,
// indiciating we should resubmit tx with higher gas if the tx is not confirmed.
export const CONFIRMATION_TIMEOUT = 15_000;
// The min percentage to bump gas.
export const GAS_BUMP_PERCENT = 20;
// 1M gas should cover all Connext txs. Gas won't exceed this amount.
export const BIG_GAS_LIMIT = BigNumber.from(1_000_000);
// nothing should ever be this expensive... _should_
export const BIG_GAS_PRICE = parseUnits("1500", "gwei");

export const waitForTransaction = async (
  provider: JsonRpcProvider,
  transactionHash: string,
  confirmations?: number,
  timeout?: number,
): Promise<Result<TransactionReceipt, ChainError>> => {
  try {
    const receipt = await provider.waitForTransaction(transactionHash, confirmations, timeout);
    if (!receipt) {
      return Result.fail(new ChainError(ChainError.reasons.TransferNotFound, { receipt }));
    }
    if (receipt.status === 0) {
      return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
    }
    return Result.ok(receipt);
  } catch (e) {
    return Result.fail(e);
  }
};

export class EthereumChainService extends EthereumChainReader implements IVectorChainService {
  private signers: Map<number, Signer> = new Map();
  private queue: PriorityQueue = new PriorityQueue({ concurrency: 1 });
  private evts: { [eventName in ChainServiceEvent]: Evt<ChainServiceEventMap[eventName]> } = {
    ...this.disputeEvts,
    [ChainServiceEvents.TRANSACTION_SUBMITTED]: new Evt(),
    [ChainServiceEvents.TRANSACTION_MINED]: new Evt(),
    [ChainServiceEvents.TRANSACTION_FAILED]: new Evt(),
  };
  constructor(
    private readonly store: IChainServiceStore,
    chainProviders: { [chainId: string]: JsonRpcProvider },
    signer: string | Signer,
    log: BaseLogger,
    private readonly defaultRetries = 3,
  ) {
    super(chainProviders, log);
    Object.entries(chainProviders).forEach(([chainId, provider]) => {
      this.signers.set(
        parseInt(chainId),
        typeof signer === "string" ? new Wallet(signer, provider) : (signer.connect(provider) as Signer),
      );
    });

    // TODO: Check to see which tx's are still active / unresolved, and resolve them.
    // this.revitalizeTxs();
  }

  private getSigner(chainId: number): Signer | undefined {
    const signer = this.signers.get(chainId);
    return signer;
  }

  /// Upsert tx submission to store, fire tx submit event.
  private async handleTxSubmit(
    onchainTransactionId: string,
    method: string,
    methodId: string,
    channelAddress: string,
    reason: TransactionReason,
    response: TransactionResponse,
  ): Promise<void> {
    this.log.info({ method, methodId, channelAddress, reason, response }, "Tx submitted.");
    const res = await this.store.saveTransactionAttempt(onchainTransactionId, channelAddress, reason, response);
    this.evts[ChainServiceEvents.TRANSACTION_SUBMITTED].post({
      response: Object.fromEntries(
        Object.entries(response).map(([key, value]) => {
          return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
        }),
      ) as StringifiedTransactionResponse,
      channelAddress,
      reason,
    });
  }

  /// Save the tx receipt in the store and fire tx mined event.
  private async handleTxMined(
    onchainTransactionId: string,
    method: string,
    methodId: string,
    channelAddress: string,
    reason: TransactionReason,
    receipt: TransactionReceipt,
  ) {
    this.log.info({ method, methodId, onchainTransactionId, reason, receipt }, "Tx mined.");
    await this.store.saveTransactionReceipt(onchainTransactionId, receipt);
    this.evts[ChainServiceEvents.TRANSACTION_MINED].post({
      receipt: Object.fromEntries(
        Object.entries(receipt).map(([key, value]) => {
          return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
        }),
      ) as StringifiedTransactionReceipt,
      channelAddress,
      reason,
    });
  }

  /// Save tx failure in store and fire tx failed event.
  private async handleTxFail(
    onchainTransactionId: string,
    method: string,
    methodId: string,
    channelAddress: string,
    reason: TransactionReason,
    response: TransactionResponse,
    receipt?: TransactionReceipt,
    error?: Error,
    message: string = "Tx reverted",
  ) {
    this.log.error({ method, methodId, error: error ? jsonifyError(error) : message }, message);
    await this.store.saveTransactionFailure(onchainTransactionId, error?.message ?? message, receipt);
    this.evts[ChainServiceEvents.TRANSACTION_FAILED].post({
      error,
      channelAddress,
      reason,
      ...(receipt
        ? {
            receipt: Object.fromEntries(
              Object.entries(receipt).map(([key, value]) => {
                return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
              }),
            ) as StringifiedTransactionReceipt,
          }
        : {}),
    });
  }

  /// Helper method to wrap queuing up a transaction and waiting for response.
  private async sendTx(
    txFn: (gasPrice: BigNumber, nonce?: number) => Promise<TransactionResponse | undefined>,
    gasPrice: BigNumber,
    nonce?: number,
  ): Promise<Result<TransactionResponse | undefined, Error>> {
    // Queue up the execution of the transaction.
    return await this.queue.add(
      async (): Promise<Result<TransactionResponse | undefined, Error>> => {
        try {
          // Send transaction using the passed in callback.
          const response: TransactionResponse | undefined = await txFn(gasPrice, nonce);
          return Result.ok(response);
        } catch (e) {
          return Result.fail(e);
        }
      },
    );
  }

  /// Check to see if any txs were left in an unfinished state. This should only execute on
  /// contructor / init.
  public async revitalizeTxs() {
    // Get all txs from store that were left in submitted state. Resubmit them.
    const storedTransactions: StoredTransaction[] = await this.store.getActiveTransactions();
    for (const tx of storedTransactions) {
      const latestAttempt = tx.attempts[tx.attempts.length - 1];
      const txResponseRes = await this.getTxResponseFromHash(tx.chainId, latestAttempt.transactionHash);
      if (txResponseRes.isError) {
        this.log.error({ error: txResponseRes.getError(), tx }, "Error in getTxResponseFromHash");
        continue;
      }
      const txResponse = txResponseRes.getValue();
      if (txResponse.receipt) {
        this.log.info({ txHash: txResponse.receipt.transactionHash }, "Tx mined, saving to db");
        // receipt should be available
        await this.store.saveTransactionReceipt(tx.channelAddress, txResponse.receipt);
        continue;
      }
      this.sendTxWithRetries(tx.to, tx.chainId, tx.reason, async () => {
        const signer = this.getSigner(tx.chainId);
        if (!signer) {
          throw new ChainError(ChainError.reasons.SignerNotFound, { chainId: tx.chainId });
        }
        return signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          chainId: tx.chainId,
          gasPrice: latestAttempt.gasPrice,
          nonce: tx.nonce,
          value: BigNumber.from(tx.value || 0),
        });
      });
    }
  }

  /// Helper method to grab signer from chain ID and check provider for a transaction.
  /// Returns the transaction if found.
  /// Throws ChainError if signer not found, tx not found, or tx already mined.
  public async getTxResponseFromHash(
    chainId: number,
    txHash: string,
  ): Promise<Result<{ response?: TransactionResponse; receipt?: TransactionReceipt }, ChainError>> {
    const provider = this.chainProviders[chainId];
    if (!provider) {
      return Result.fail(new ChainError(ChainError.reasons.ProviderNotFound, { chainId }));
    }

    try {
      const response = await provider.getTransaction(txHash);
      let receipt: TransactionReceipt | undefined;
      if (response?.confirmations > 0) {
        receipt = await provider.send("eth_getTransactionReceipt", [txHash]);
      }
      return Result.ok({ response, receipt });
    } catch (e) {
      return Result.fail(new ChainError(ChainError.reasons.TxNotFound, { error: e, transactionHash: txHash }));
    }
  }

  public async speedUpTx(
    chainId: number,
    tx: MinimalTransaction & { transactionHash: string; nonce: number },
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const method = "speedUpTx";
    const methodId = getRandomBytes32();
    this.log.info({ method, methodId, transactionHash: tx.transactionHash }, "Method started");
    let receipt: TransactionResponse | null;
    const signer = this.getSigner(chainId);
    if (!signer) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound, { chainId }));
    }
    // Make sure tx is not mined already
    const getTxRes = await this.getTxResponseFromHash(chainId, tx.transactionHash);
    if (getTxRes.isError) {
      return Result.fail(getTxRes.getError()!);
    }
    if (getTxRes.getValue().receipt) {
      return Result.fail(new ChainError(ChainError.reasons.TxAlreadyMined));
    }

    // Safe to retry sending
    const txRes = await this.sendTxWithRetries(
      tx.to,
      chainId,
      TransactionReason.speedUpTransaction,
      async (gasPrice: BigNumber, nonce?: number) => {
        const price = await this.getGasPrice(chainId);
        if (price.isError) {
          throw price.getError()!;
        }
        const current = price.getValue().add(parseUnits("20", "gwei"));
        const increased = current.gt(receipt?.gasPrice ?? 0)
          ? current
          : BigNumber.from(receipt?.gasPrice ?? 0).add(parseUnits("20", "gwei"));
        return signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          chainId,
          gasPrice: increased,
          nonce: tx.nonce,
          value: BigNumber.from(tx.value),
        });
      },
    );
    if (txRes.isError) {
      return Result.fail(txRes.getError()!);
    }
    if (!txRes.getValue()) {
      return Result.fail(new ChainError(ChainError.reasons.FailedToSendTx, { message: "Tx response not available" }));
    }
    return Result.ok(txRes.getValue()!);
  }

  public async sendTxWithRetries(
    channelAddress: string,
    chainId: number,
    reason: TransactionReason,
    // should return undefined IFF tx didnt send based on validation in
    // fn
    txFn: (gasPrice: BigNumber, nonce?: number) => Promise<undefined | TransactionResponse>,
  ): Promise<Result<TransactionReceipt | undefined, ChainError>> {
    const method = "sendTxWithRetries";
    const methodId = getRandomBytes32();
    const errors = [];
    for (let attempt = 0; attempt < this.defaultRetries; attempt++) {
      this.log.info(
        {
          method,
          methodId,
          retries: this.defaultRetries,
          attempt,
          channelAddress,
          chainId,
          reason,
        },
        "Attempting to send tx",
      );
      const receipt = await this.sendAndConfirmTx(channelAddress, chainId, reason, txFn);
      if (!receipt.isError) {
        this.log.info(
          {
            method,
            methodId,
            transactionHash: receipt.getValue()?.transactionHash,
            channelAddress,
            chainId,
          },
          "Tx confirmed",
        );
        return receipt;
      }
      // Otherwise, handle error
      const error = receipt.getError()!;
      if (!error.canRetry) {
        this.log.error(
          { error: error.message, channelAddress, reason, stack: error.stack, method, methodId },
          "Failed to send tx, will not retry",
        );
        return receipt;
      }
      // wait before retrying
      errors.push(error);
      this.log.warn(
        { error: error.message, channelAddress, attempt, retries: this.defaultRetries, method, methodId },
        "Tx failed, waiting before retry",
      );
      await delay(1000);
    }
    return Result.fail(
      new ChainError(ChainError.reasons.FailedToSendTx, {
        errors: errors.map((e) => e.message).toString(),
        retries: this.defaultRetries,
        channelAddress,
        reason,
      }),
    );
  }

  public async sendAndConfirmTx(
    channelAddress: string,
    chainId: number,
    reason: TransactionReason,
    // tx fn can return undefined so that just in time logic to stop txs can be made
    txFn: (gasPrice: BigNumber, nonce?: number) => Promise<TransactionResponse | undefined>,
    presetGasPrice?: BigNumber,
  ): Promise<Result<TransactionReceipt | undefined, ChainError>> {
    const method = "sendAndConfirmTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(chainId);
    if (!signer) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    let tryNumber: number = 0;
    let response: TransactionResponse | undefined;
    let receipt: TransactionReceipt | undefined;
    // Nonce will persist across iterations, as soon as it is defined in the first one.
    let nonce: number | undefined = undefined;
    let gasPrice: BigNumber;

    try {
      // Get (initial) gas price if there is not a preset amount passed into this method.
      gasPrice =
        presetGasPrice ??
        (await (async (): Promise<BigNumber> => {
          const price = await this.getGasPrice(chainId);
          if (price.isError) {
            throw price.getError()!;
          }
          return price.getValue();
        })());
    } catch (e) {
      return Result.fail(e);
    }

    // This is the gas bump loop.
    // We will raise gas price for a tx if the confirmation of the tx times out.
    // (Default timeout should be around ~15 sec, i.e. GAS_BUMP_THRESHOLD)
    let onchainTransactionId = uuidV4();
    while (!receipt) {
      tryNumber += 1;
      try {
        /// SUBMIT
        const result = await this.sendTx(txFn, gasPrice, response ? response.nonce : undefined);
        if (result.isError) {
          // If an error occurred, throw it to handle it in the catch block.
          const error = result.getError()!;
          // If the nonce has already been used, the 'original' tx must have been mined and the tx
          // we attempted here was a duplicate with bumped gas. Assuming we're on a subsuquent attempt,
          // handle this by simply proceeding to the confirm block without throwing.
          if (tryNumber > 1 && error.message.includes("nonce has already been used")) {
            // TODO: Confirm that this error message comparison is valid in this context.
            // TODO: Might be better to compare code to NONCE_EXPIRED, etc.
            // A more robust comparison is desirable here either way.
            this.log.info(
              { method, methodId, channelAddress, reason },
              "Nonce already used: proceeding to check for confirmation.",
            );
          } else {
            throw error;
          }
        } else {
          // If response returns undefined, we assume the tx was not sent. This will happen if some logic was
          // passed into txFn to bail out at the time of sending.
          let tempResponse = result.getValue();
          if (!tempResponse) {
            this.log.warn({ method, methodId, channelAddress, reason }, "Did not attempt tx");
            // Iff this is the only iteration, then we want to go ahead return w/o saving anything.
            if (tryNumber === 1) {
              return Result.ok(undefined);
            }
          } else {
            response = tempResponse;
          }

          // NOTE: Response MUST be defined here because if it was NEVER defined (i.e. undefined on first iteration),
          // we would have returned in prev block, and if it was undefined on this iteration we would not overwrite
          // that value.
          // Tx was submitted: handle saving to store.
          await this.handleTxSubmit(onchainTransactionId, method, methodId, channelAddress, reason, response!);
        }

        /// CONFIRM
        // Now we wait for confirmation and get tx receipt.
        receipt = await this.waitForConfirmation(chainId, response!);
        // Check status in event of tx reversion.
        if (receipt.status === 0) {
          throw new ChainError(ChainError.reasons.TxReverted, { receipt, method, methodId });
        }
      } catch (e) {
        // Check if the error was a confirmation timeout.
        if (e.message === ChainError.retryableTxErrors.ConfirmationTimeout) {
          // Scale up gas by percentage as specified by GAS_BUMP_PERCENT.
          this.log.info(
            { channelAddress, reason, method, methodId },
            "Tx timed out waiting for confirmation. Bumping gas price and reattempting.",
          );
          gasPrice = gasPrice.add(gasPrice.mul(GAS_BUMP_PERCENT).div(100));
          // if the gas price is past the max, return a failure.
          if (gasPrice.gt(BIG_GAS_PRICE)) {
            const error = new ChainError(ChainError.reasons.MaxGasPriceReached, {
              gasPrice: gasPrice.toString(),
              methodId,
              method,
              max: BIG_GAS_PRICE,
            });
            await this.handleTxFail(
              onchainTransactionId,
              method,
              methodId,
              channelAddress,
              reason,
              response!,
              receipt,
              error,
              "Max gas price reached",
            );
            return Result.fail(error);
          }
          // NOTE: This is just some syntactic sugar for readability. This is the only event where we
          // should continue in this loop: to proceed to a subsuquent tx with a raised gas price.
          continue;
        } else {
          let error = e;
          if (e.message.includes("sender doesn't have enough funds")) {
            error = new ChainError(ChainError.reasons.NotEnoughFunds);
          }
          // Don't save tx if it failed to submit (i.e. no response), only if it fails to mine.
          if (response) {
            // If we get any other error here, we classify this event as a tx failure.
            await this.handleTxFail(
              onchainTransactionId,
              method,
              methodId,
              channelAddress,
              reason,
              response,
              receipt,
              e,
              "Tx reverted",
            );
          } else {
            this.log.error(
              { method, methodId, channelAddress, reason, error: jsonifyError(error) },
              "Failed to send tx",
            );
          }
          return Result.fail(error);
        }
      }
    }

    // Success! Save mined tx receipt.
    await this.handleTxMined(onchainTransactionId, method, methodId, channelAddress, reason, receipt);
    return Result.ok(receipt);
  }

  public async waitForConfirmation(chainId: number, response: TransactionResponse): Promise<TransactionReceipt> {
    const provider: JsonRpcProvider = this.chainProviders[chainId];
    if (!provider) {
      throw new ChainError(ChainError.reasons.ProviderNotFound);
    }
    const numConfirmations = getConfirmationsForChain(chainId);
    // An anon fn to get the tx receipt, as we may require multiple retries with raised gas price.
    const getTransactionReceipt = async (): Promise<TransactionReceipt | undefined> => {
      const receipt = await provider.send("eth_getTransactionReceipt", [response.hash]);
      if (receipt?.confirmations < numConfirmations) {
        return undefined;
      }
      return receipt;
    };

    // Poll for receipt.
    let receipt: TransactionReceipt | undefined = await getTransactionReceipt();
    // NOTE: This loop won't execute if receipt is valid (not undefined).
    let timeElapsed: number = 0;
    const startMark = new Date().getTime();
    while (!receipt && timeElapsed < CONFIRMATION_TIMEOUT) {
      // Pause for 2 sec.
      await delay(2000);
      receipt = await getTransactionReceipt();
      if (receipt) {
        break;
      }
      // Update elapsed time.
      timeElapsed = new Date().getTime() - startMark;
    }
    if (!receipt) {
      throw new ChainError(ChainError.retryableTxErrors.ConfirmationTimeout);
    }
    return receipt;
  }

  public async sendDeployChannelTx(
    channelState: FullChannelState,
    deposit?: { amount: string; assetId: string }, // Included IFF createChannelAndDepositAlice
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const method = "sendDeployChannelTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    // check if multisig must be deployed
    const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);

    if (multisigRes.isError) {
      return Result.fail(multisigRes.getError()!);
    }

    if (multisigRes.getValue() !== `0x`) {
      return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
    }

    const channelFactory = new Contract(channelState.networkContext.channelFactoryAddress, ChannelFactory.abi, signer);

    // If there is no deposit information, just create the channel
    if (!deposit) {
      // Deploy multisig tx
      this.log.info(
        { channelAddress: channelState.channelAddress, sender, method, methodId },
        "Deploying channel without deposit",
      );
      const result = await this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.deploy,
        async (gasPrice: BigNumber, nonce?: number) => {
          const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
          if (multisigRes.isError) {
            throw multisigRes.getError()!;
          }
          if (multisigRes.getValue() !== `0x`) {
            return undefined;
          }
          return channelFactory.createChannel(channelState.alice, channelState.bob, {
            gasPrice: gasPrice,
            gasLimit: BIG_GAS_LIMIT,
            nonce,
          });
        },
      );
      if (result.isError) {
        return result as Result<any, ChainError>;
      }
      if (!result.getValue()) {
        return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
      }
      return Result.ok(result.getValue()!);
    }

    // Deploy a channel with a deposit (only alice can do this)
    if (sender !== channelState.alice) {
      return Result.fail(
        new ChainError(ChainError.reasons.FailedToDeploy, {
          message: "Sender is not alice",
          sender,
          alice: channelState.alice,
          channel: channelState.channelAddress,
        }),
      );
    }

    const { assetId, amount } = deposit;

    const balanceRes = await this.getOnchainBalance(assetId, channelState.alice, channelState.networkContext.chainId);
    if (balanceRes.isError) {
      return Result.fail(balanceRes.getError()!);
    }
    const balance = balanceRes.getValue();
    if (balance.lt(amount)) {
      return Result.fail(
        new ChainError(ChainError.reasons.NotEnoughFunds, {
          balance: balance.toString(),
          amount,
          assetId,
          chainId: channelState.networkContext.chainId,
        }),
      );
    }
    this.log.info(
      { balance: balance.toString(), method, methodId, assetId, chainId: channelState.networkContext.chainId },
      "Onchain balance sufficient",
    );

    // Handle eth deposits
    if (assetId === AddressZero) {
      const res = await this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.deployWithDepositAlice,
        async (gasPrice: BigNumber, nonce?: number) => {
          const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
          if (multisigRes.isError) {
            throw multisigRes.getError()!;
          }
          if (multisigRes.getValue() !== `0x`) {
            // multisig deployed, just send deposit
            return undefined;
          }
          // otherwise deploy with deposit
          return channelFactory.createChannelAndDepositAlice(channelState.alice, channelState.bob, assetId, amount, {
            value: amount,
            gasPrice: gasPrice,
            gasLimit: BIG_GAS_LIMIT,
            nonce,
          });
        },
      );
      if (res.isError) {
        return Result.fail(res.getError()!);
      }
      if (!res.getValue()) {
        return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
      }
      return Result.ok(res.getValue()!);
    }

    // Must be token deposit, first approve the token transfer
    this.log.info({ assetId, amount, channel: channelState.channelAddress, sender }, "Approving tokens");
    const approveRes = await this.approveTokens(
      channelState.channelAddress,
      channelState.networkContext.channelFactoryAddress,
      sender,
      amount,
      assetId,
      channelState.networkContext.chainId,
    );
    if (approveRes.isError) {
      return Result.fail(approveRes.getError()!);
    }
    if (approveRes.getValue()) {
      const receipt = approveRes.getValue()!;
      if (receipt.status === 0) {
        return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
      }
      this.log.info({ txHash: receipt.transactionHash, method, assetId }, "Token approval confirmed");
    }
    const res = await this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.deployWithDepositAlice,
      async (gasPrice: BigNumber, nonce?: number) => {
        const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
        if (multisigRes.isError) {
          throw multisigRes.getError()!;
        }
        if (multisigRes.getValue() !== `0x`) {
          // multisig deployed, just send deposit (will check allowance)
          return undefined;
        }
        return channelFactory.createChannelAndDepositAlice(channelState.alice, channelState.bob, assetId, amount, {
          gasPrice: gasPrice,
          gasLimit: BIG_GAS_LIMIT,
          nonce,
        });
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    if (!res.getValue()) {
      return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
    }
    return Result.ok(res.getValue()!);
  }

  public async sendWithdrawTx(
    channelState: FullChannelState,
    minTx: MinimalTransaction,
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const method = "sendWithdrawTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    if (channelState.alice !== sender && channelState.bob !== sender) {
      return Result.fail(new ChainError(ChainError.reasons.SenderNotInChannel));
    }

    // check if multisig must be deployed
    const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);

    if (multisigRes.isError) {
      return Result.fail(multisigRes.getError()!);
    }

    if (multisigRes.getValue() === `0x`) {
      // Deploy multisig tx
      this.log.info({ channelAddress: channelState.channelAddress, sender, method, methodId }, "Deploying channel");
      const txRes = await this.sendDeployChannelTx(channelState);
      if (txRes.isError && txRes.getError()?.message !== ChainError.reasons.MultisigDeployed) {
        return Result.fail(
          new ChainError(ChainError.reasons.FailedToDeploy, {
            method,
            error: txRes.getError()!.message,
            channel: channelState.channelAddress,
          }),
        );
      }
    }

    this.log.info({ sender, method, methodId, channel: channelState.channelAddress }, "Sending withdraw tx to chain");
    const res = await this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.withdraw,
      async (gasPrice: BigNumber, nonce?: number) => {
        return signer.sendTransaction({ ...minTx, gasPrice, gasLimit: BIG_GAS_LIMIT, from: sender, nonce });
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }

  public async sendDepositTx(
    channelState: FullChannelState,
    sender: string,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const method = "sendDepositTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (channelState.alice !== sender && channelState.bob !== sender) {
      return Result.fail(new ChainError(ChainError.reasons.SenderNotInChannel));
    }

    const toDeposit = BigNumber.from(amount);
    if (toDeposit.isNegative()) {
      return Result.fail(new ChainError(ChainError.reasons.NegativeDepositAmount));
    }

    // first check if multisig is needed to deploy
    const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);

    if (multisigRes.isError) {
      return Result.fail(multisigRes.getError()!);
    }

    const multisigCode = multisigRes.getValue();
    // alice needs to deploy the multisig
    if (multisigCode === `0x` && sender === channelState.alice) {
      this.log.info(
        {
          method,
          methodId,
          channelAddress: channelState.channelAddress,
          assetId,
          amount,
          senderAddress: await signer.getAddress(),
        },
        `Deploying channel with deposit`,
      );
      const deployResult = await this.sendDeployChannelTx(channelState, { amount, assetId });
      if (deployResult.isError) {
        const error = deployResult.getError()!;
        if (!(error.message === ChainError.reasons.MultisigDeployed)) {
          return Result.fail(deployResult.getError()!);
        }
        // NOTE: If the multisig is already deployed, then our tx to deploy must have been reverted.
        // We can proceed to making the deposit here ourselves in the code below.
      } else {
        // Deploy and deposit succeeded.
        return Result.ok(deployResult.getValue()!);
      }
    }

    const balanceRes = await this.getOnchainBalance(assetId, sender, channelState.networkContext.chainId);
    if (balanceRes.isError) {
      return Result.fail(balanceRes.getError()!);
    }
    const balance = balanceRes.getValue();
    if (balance.lt(amount)) {
      return Result.fail(
        new ChainError(ChainError.reasons.NotEnoughFunds, {
          balance: balance.toString(),
          amount,
          assetId,
          chainId: channelState.networkContext.chainId,
        }),
      );
    }
    this.log.info(
      { balance: balance.toString(), method, methodId, assetId, chainId: channelState.networkContext.chainId },
      "Onchain balance sufficient",
    );

    this.log.info({ method, methodId, assetId, amount }, "Channel is deployed, sending deposit");
    if (sender === channelState.alice) {
      this.log.info(
        { method, sender, alice: channelState.alice, bob: channelState.bob },
        "Detected participant A, sending tx",
      );
      const txRes = await this.sendDepositATx(channelState, amount, assetId);
      if (txRes.isError) {
        this.log.error({ method, error: txRes.getError()!.message }, "Error sending tx");
      } else {
        this.log.info({ method, txHash: txRes.getValue().transactionHash }, "Tx mined");
      }
      return txRes;
    } else {
      this.log.info(
        { method, sender, alice: channelState.alice, bob: channelState.bob },
        "Detected participant B, sendng tx",
      );
      const txRes = await this.sendDepositBTx(channelState, amount, assetId);
      if (txRes.isError) {
        this.log.error({ method, error: txRes.getError()!.message }, "Error sending tx");
      } else {
        this.log.info({ method, txHash: txRes.getValue().transactionHash }, "Tx mined");
      }
      return txRes;
    }
  }

  ////////////////////////////
  /// CHAIN SERVICE EVENTS
  public on<T extends ChainServiceEvent>(
    event: T,
    callback: (payload: ChainServiceEventMap[T]) => void | Promise<void>,
    filter: (payload: ChainServiceEventMap[T]) => boolean = () => true,
  ): void {
    (this.evts[event].pipe(filter) as Evt<ChainServiceEventMap[T]>).attach(callback);
  }

  public once<T extends ChainServiceEvent>(
    event: T,
    callback: (payload: ChainServiceEventMap[T]) => void | Promise<void>,
    filter: (payload: ChainServiceEventMap[T]) => boolean = () => true,
  ): void {
    (this.evts[event].pipe(filter) as Evt<ChainServiceEventMap[T]>).attachOnce(callback);
  }

  public off<T extends ChainServiceEvent>(event?: T): void {
    if (event) {
      this.evts[event].detach();
      return;
    }
    Object.values(this.evts).forEach((evt) => evt.detach());
  }

  public waitFor<T extends ChainServiceEvent>(
    event: T,
    timeout: number,
    filter: (payload: ChainServiceEventMap[T]) => boolean = () => true,
  ): Promise<ChainServiceEventMap[T]> {
    return this.evts[event].pipe(filter).waitFor(timeout) as Promise<ChainServiceEventMap[T]>;
  }

  ////////////////////////////
  /// INTERNAL METHODS
  public async approveTokens(
    channelAddress: string,
    spender: string,
    owner: string,
    depositAmount: string,
    assetId: string,
    chainId: number,
    approvalAmount: string = UINT_MAX,
  ): Promise<Result<TransactionReceipt | undefined, ChainError>> {
    const method = "approveTokens";
    this.log.debug(
      {
        method,
        channelAddress,
        spender,
        owner,
        approvalAmount,
        depositAmount,
        assetId,
        chainId,
      },
      "Method started",
    );
    const signer = this.signers.get(chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    this.log.info({ method, assetId, spender, owner, channelAddress }, "Checking allowance");
    const erc20 = new Contract(assetId, ERC20Abi, signer);
    const allowanceRes = await this.getTokenAllowance(assetId, owner, spender, chainId);
    if (allowanceRes.isError) {
      this.log.error(
        {
          method,
          spender,
          owner,
          assetId,
          error: allowanceRes.getError()?.message,
        },
        "Error checking approved tokens for deposit A",
      );
      return Result.fail(allowanceRes.getError()!);
    }
    const allowance = allowanceRes.getValue();
    this.log.info(
      { method, assetId, spender, owner, channelAddress, allowance: allowance.toString(), depositAmount },
      "Retrieved allowance",
    );

    if (BigNumber.from(allowanceRes.getValue()).gte(depositAmount)) {
      this.log.info(
        {
          method,
          assetId,
          channelAddress,
        },
        "Allowance is sufficient",
      );
      return Result.ok(undefined);
    }
    this.log.info(
      {
        method,
        assetId,
        channelAddress,
        spender,
        owner,
        approvalAmount,
      },
      "Approving tokens",
    );
    const approveRes = await this.sendTxWithRetries(
      channelAddress,
      chainId,
      TransactionReason.approveTokens,
      async (gasPrice: BigNumber, nonce?: number) => {
        return erc20.approve(spender, approvalAmount, { gasPrice, nonce });
      },
    );
    if (approveRes.isError) {
      this.log.error(
        {
          method,
          spender,
          owner,
          assetId,
          approvalAmount,
          allowance: allowance.toString(),
          error: approveRes.getError()?.message,
        },
        "Error approving tokens for deposit A",
      );
      return approveRes;
    }
    const approveTx = approveRes.getValue();
    this.log.info({ txHash: approveTx!.transactionHash, method, assetId, approvalAmount }, "Approve token tx mined");
    return approveRes;
  }

  public async sendDepositATx(
    channelState: FullChannelState,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const method = "sendDepositATx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    const vectorChannel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
    if (assetId !== AddressZero) {
      // need to approve
      this.log.info({ method, methodId, assetId, channelAddress: channelState.channelAddress }, "Approving token");
      const approveRes = await this.approveTokens(
        channelState.channelAddress,
        channelState.channelAddress,
        channelState.alice,
        amount,
        assetId,
        channelState.networkContext.chainId,
      );
      if (approveRes.isError) {
        this.log.error(
          {
            method,
            methodId,
            channelAddress: channelState.channelAddress,
            error: approveRes.getError()?.message,
          },
          "Error approving tokens for deposit A",
        );
        return Result.fail(approveRes.getError()!);
      }
      this.log.info(
        { txHash: approveRes.getValue()?.transactionHash, method, methodId, assetId },
        "Token approval confirmed",
      );
      const res = await this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositA,
        async (gasPrice: BigNumber, nonce?: number) => {
          return vectorChannel.depositAlice(assetId, amount, { gasPrice, nonce });
        },
      );
      if (res.isError) {
        return Result.fail(res.getError()!);
      }
      return Result.ok(res.getValue()!);
    }
    const res = await this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.depositA,
      async (gasPrice: BigNumber, nonce?: number) => {
        return vectorChannel.depositAlice(assetId, amount, { value: amount, gasPrice, nonce });
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }

  public async sendDepositBTx(
    channelState: FullChannelState,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    if (assetId === AddressZero) {
      const res = await this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositB,
        async (gasPrice: BigNumber, nonce?: number) => {
          return signer.sendTransaction({
            data: "0x",
            to: channelState.channelAddress,
            value: BigNumber.from(amount),
            chainId: channelState.networkContext.chainId,
            gasPrice,
            from: sender,
            nonce,
          });
        },
      );
      if (res.isError) {
        return Result.fail(res.getError()!);
      }
      return Result.ok(res.getValue()!);
    } else {
      const erc20 = new Contract(channelState.networkContext.channelFactoryAddress, ERC20Abi, signer);
      const res = await this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositB,
        async (gasPrice: BigNumber, nonce?: number) => {
          return erc20.transfer(channelState.channelAddress, amount, { gasPrice, nonce });
        },
      );
      if (res.isError) {
        return Result.fail(res.getError()!);
      }
      return Result.ok(res.getValue()!);
    }
  }

  async sendDisputeChannelTx(channelState: FullChannelState): Promise<Result<TransactionReceipt, ChainError>> {
    const method = "sendDisputeChannelTx";
    const methodId = getRandomBytes32();
    this.log.info({ method, methodId, channelAddress: channelState.channelAddress }, "Method started");
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!channelState.latestUpdate.aliceSignature || !channelState.latestUpdate.bobSignature) {
      return Result.fail(new ChainError(ChainError.reasons.MissingSigs));
    }

    const code = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
    if (code.isError) {
      return Result.fail(code.getError()!);
    }
    if (code.getValue() === "0x") {
      this.log.info(
        { method, methodId, channelAddress: channelState.channelAddress, chainId: channelState.networkContext.chainId },
        "Deploying channel",
      );
      const gasPrice = await this.getGasPrice(channelState.networkContext.chainId);
      if (gasPrice.isError) {
        return Result.fail(gasPrice.getError()!);
      }

      const deploy = await this.sendDeployChannelTx(channelState);
      if (deploy.isError) {
        return Result.fail(deploy.getError()!);
      }
      this.log.info(
        {
          method,
          methodId,
          channelAddress: channelState.channelAddress,
          transactionHash: deploy.getValue().transactionHash,
        },
        "Channel deployed",
      );
    }

    const res = await this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.disputeChannel,
      (gasPrice, nonce) => {
        const channel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
        return channel.disputeChannel(
          channelState,
          channelState.latestUpdate.aliceSignature,
          channelState.latestUpdate.bobSignature,
          {
            gasPrice,
            nonce,
          },
        );
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }

  async sendDefundChannelTx(
    channelState: FullChannelState,
    assetsToDefund: string[] = channelState.assetIds,
    indices: string[] = [],
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!channelState.latestUpdate.aliceSignature || !channelState.latestUpdate.bobSignature) {
      return Result.fail(new ChainError(ChainError.reasons.MissingSigs));
    }
    const res = await this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.defundChannel,
      (gasPrice, nonce) => {
        const channel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
        return channel.defundChannel(
          channelState,
          assetsToDefund,
          indices.length > 0 ? indices : assetsToDefund.map((_asset, idx) => idx),
          { gasPrice, nonce },
        );
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }

  async sendDisputeTransferTx(
    transferIdToDispute: string,
    activeTransfers: FullTransferState[],
  ): Promise<Result<TransactionReceipt, ChainError>> {
    // Make sure transfer is active
    const transferState = activeTransfers.find((t) => t.transferId === transferIdToDispute);
    if (!transferState) {
      return Result.fail(
        new ChainError(ChainError.reasons.TransferNotFound, {
          transfer: transferIdToDispute,
          active: activeTransfers.map((t) => t.transferId),
        }),
      );
    }

    // Get signer
    const signer = this.signers.get(transferState.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    // Generate merkle root
    const { tree } = generateMerkleTreeData(activeTransfers);

    const res = await this.sendTxWithRetries(
      transferState.channelAddress,
      transferState.chainId,
      TransactionReason.disputeTransfer,
      (gasPrice, nonce) => {
        const channel = new Contract(transferState.channelAddress, VectorChannel.abi, signer);
        return channel.disputeTransfer(transferState, tree.getHexProof(hashCoreTransferState(transferState)), {
          gasPrice,
          nonce,
        });
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }

  async sendDefundTransferTx(
    transferState: FullTransferState,
    responderSignature: string = HashZero,
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const signer = this.signers.get(transferState.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!transferState.transferResolver) {
      return Result.fail(new ChainError(ChainError.reasons.ResolverNeeded));
    }

    const encodedState = encodeTransferState(transferState.transferState, transferState.transferEncodings[0]);
    const encodedResolver = encodeTransferResolver(transferState.transferResolver, transferState.transferEncodings[1]);

    const res = await this.sendTxWithRetries(
      transferState.channelAddress,
      transferState.chainId,
      TransactionReason.defundTransfer,
      (gasPrice, nonce) => {
        const channel = new Contract(transferState.channelAddress, VectorChannel.abi, signer);
        return channel.defundTransfer(transferState, encodedState, encodedResolver, responderSignature, {
          gasPrice,
          nonce,
        });
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }

  public async sendExitChannelTx(
    channelAddress: string,
    chainId: number,
    assetId: string,
    owner: string,
    recipient: string,
  ): Promise<Result<TransactionReceipt, ChainError>> {
    const signer = this.signers.get(chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    this.log.info({ channelAddress, chainId, assetId, owner, recipient }, "Defunding channel");

    const res = await this.sendTxWithRetries(
      channelAddress,
      chainId,
      TransactionReason.exitChannel,
      (gasPrice, nonce) => {
        const channel = new Contract(channelAddress, VectorChannel.abi, signer);
        return channel.exit(assetId, owner, recipient, { gasPrice, nonce });
      },
    );
    if (res.isError) {
      return Result.fail(res.getError()!);
    }
    return Result.ok(res.getValue()!);
  }
}
