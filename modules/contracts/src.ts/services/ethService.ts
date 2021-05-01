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
  TransactionResponseWithResult,
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

import { ChannelFactory, VectorChannel } from "../artifacts";

import { EthereumChainReader } from "./ethReader";
import { parseUnits } from "ethers/lib/utils";

export const EXTRA_GAS = 50_000;
// The amount of time (ms) to wait before a confirmation polling period times out,
// indiciating we should resubmit tx with higher gas if the tx is not confirmed.
export const CONFIRMATION_TIMEOUT = 15000;
// The min percentage to bump gas.
export const GAS_BUMP_PERCENT = 0.2;
// 1M gas should cover all Connext txs. Gas won't exceed this amount.
export const BIG_GAS_LIMIT = BigNumber.from(1_000_000);

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
    super(chainProviders, log.child({ module: "EthereumChainService" }));
    Object.entries(chainProviders).forEach(([chainId, provider]) => {
      this.signers.set(
        parseInt(chainId),
        typeof signer === "string" ? new Wallet(signer, provider) : (signer.connect(provider) as Signer),
      );
    });

    // TODO: Check to see which tx's are still active / unresolved, and resolve them.
    this.revitalizeTxs();
  }

  private getSigner(chainId: number): Signer {
    const signer = this.signers.get(chainId);
    if (!signer?._isSigner) {
      throw new ChainError(ChainError.reasons.SignerNotFound);
    }
    return signer;
  }

  /// Check to see if any txs were left in an unfinished state. This should only execute on
  /// contructor / init.
  private async revitalizeTxs() {
    // Get all tx's from store that were left in submitted state. Resubmit them.
    const storedTransactions: StoredTransaction[] = await this.store.getActiveTransactions();
    // TODO: Should we filter out "stale" tx's (older than a specified elapsed time)?
    for (let i = 0; i < storedTransactions.length; i++) {
      let tx: StoredTransaction = storedTransactions[i];
      try {
        const receipt = await this.getTxReceiptFromHash(tx.chainId, {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          transactionHash: tx.transactionHash,
          nonce: tx.nonce,
        });
        if (!receipt) {
          continue;
        }
        this.sendTxWithRetries(tx.to, tx.chainId, tx.reason, async (gasPrice: BigNumber) => {
          const signer = this.getSigner(tx.chainId);
          return signer.sendTransaction({
            to: tx.to,
            data: tx.data,
            chainId: tx.chainId,
            gasPrice,
            nonce: tx.nonce,
            value: BigNumber.from(tx.value),
          });
        });
      } catch (e) {
        // TODO: Log?
        continue;
      }
    }
  }

  /// Helper method to grab signer from chain ID and check provider for a transaction.
  /// Returns the transaction if found.
  /// Throws ChainError if signer not found, tx not found, or tx already mined.
  private async getTxReceiptFromHash(
    chainId: number,
    tx: MinimalTransaction & { transactionHash: string; nonce: number },
  ): Promise<TransactionResponse | null> {
    const signer = this.getSigner(chainId);

    let receipt: TransactionResponse | null;
    try {
      receipt = await signer.provider!.getTransaction(tx.transactionHash);
    } catch (e) {
      throw new ChainError(ChainError.reasons.TxNotFound, { error: e.message, transactionHash: tx.transactionHash });
    }
    if (receipt && receipt.confirmations > 0) {
      throw new ChainError(ChainError.reasons.TxAlreadyMined, {
        transactionHash: tx.transactionHash,
        confirmations: receipt.confirmations,
        blockNumber: receipt.blockNumber,
      });
    }
    return receipt;
  }

  async speedUpTx(
    chainId: number,
    tx: MinimalTransaction & { transactionHash: string; nonce: number },
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const method = "speedUpTx";
    const methodId = getRandomBytes32();
    this.log.info({ method, methodId, transactionHash: tx.transactionHash }, "Method started");
    let signer: Signer;
    let receipt: TransactionResponse | null;
    try {
      signer = this.getSigner(chainId);
      // Make sure tx is not mined already
      receipt = await this.getTxReceiptFromHash(chainId, tx);
    } catch (e) {
      return Result.fail(e);
    }

    // Safe to retry sending
    return this.sendTxWithRetries(tx.to, chainId, TransactionReason.speedUpTransaction, async (gasPrice: BigNumber) => {
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
    }) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendTxWithRetries(
    channelAddress: string,
    chainId: number,
    reason: TransactionReason,
    // should return undefined IFF tx didnt send based on validation in
    // fn
    txFn: (gasPrice: BigNumber) => Promise<undefined | TransactionResponse>,
  ): Promise<Result<TransactionResponseWithResult | undefined, ChainError>> {
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
          reason,
        },
        "Attempting to send tx",
      );
      const response = await this.sendTxAndParseResponse(channelAddress, chainId, reason, txFn);
      console.log("response: ", response);
      if (!response.isError) {
        return response;
      }
      // Otherwise, handle error
      const error = response.getError()!;
      if (!error.canRetry) {
        this.log.error(
          { error: error.message, channelAddress, reason, stack: error.stack, method, methodId },
          "Failed to send tx, will not retry",
        );
        return response;
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

  public async sendTxAndParseResponse(
    channelAddress: string,
    chainId: number,
    reason: TransactionReason,
    txFn: (gasPrice: BigNumber) => Promise<undefined | TransactionResponse>,
    presetGasPrice?: BigNumber,
  ): Promise<Result<TransactionResponseWithResult | undefined, ChainError>> {
    try {
      // Get gas price if there is not a preset amount passed into this method.
      let gasPrice: BigNumber =
        presetGasPrice ??
        (await (async (): Promise<BigNumber> => {
          const price = await this.getGasPrice(chainId);
          if (price.isError) {
            throw price.getError()!;
          }
          return price.getValue();
        })());
      // Queue up the execution of the transaction.
      const response = await this.queue.add(async () => {
        let response: TransactionResponse | undefined;

        // We will raise gas price if the confirmation of the tx "times out" essentially.
        // Default timeout should be around ~15 sec. (GAS_BUMP_THRESHOLD)
        // We raise our gas price for subsuquent attempts if this is the case.

        // Send transaction using the passed in callback.
        response = await txFn(gasPrice);
        this.log.info({ channelAddress, reason, response }, "Tx response:");
        // If response returns undefined, we assume the tx was not sent / reverted.
        if (!response) {
          this.log.warn({ channelAddress, reason }, "Did not attempt tx");
          return response;
        }

        // save to store
        await this.store.saveTransactionResponse(channelAddress, reason, response);
        this.evts[ChainServiceEvents.TRANSACTION_SUBMITTED].post({
          response: Object.fromEntries(
            Object.entries(response).map(([key, value]) => {
              return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
            }),
          ) as StringifiedTransactionResponse,
          channelAddress,
          reason,
        });

        const completed = (): Promise<Result<TransactionReceipt, ChainError>> => {
          return new Promise(async (resolve, reject) => {
            while (gasPrice < BIG_GAS_LIMIT) {
              try {
                // Wait for confirmation.
                const receipt = await this.waitForConfirmation(chainId, response!);
                // Handle receipt / store updates to complete tx.
                if (receipt.status === 0) {
                  this.log.error({ method: "sendTxAndParseResponse", receipt }, "Transaction reverted.");
                  await this.store.saveTransactionFailure(channelAddress, response!.hash, "Tx reverted");
                  this.evts[ChainServiceEvents.TRANSACTION_FAILED].post({
                    receipt: Object.fromEntries(
                      Object.entries(receipt).map(([key, value]) => {
                        return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
                      }),
                    ) as StringifiedTransactionReceipt,
                    channelAddress,
                    reason,
                  });
                } else {
                  await this.store.saveTransactionReceipt(channelAddress, receipt);
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
                // Break out of the loop here, as the tx has been completed.
                resolve(Result.ok(receipt));
              } catch (e) {
                // TODO: Maybe it would be more robust to have waitForConfirmation return undefined or something
                // specific in the event of timeout, as opposed to using error comparison?

                // Check if the error was a confirmation timeout.
                if (e.message === ChainError.retryableTxErrors.ConfirmationTimeout) {
                  // Scale up gas by percentage as specified by GAS_BUMP_PERCENT.
                  this.log.info(
                    { channelAddress, reason },
                    "Tx timed out waiting for confirmation. Bumping gas price and reattempting.",
                  );
                  gasPrice = gasPrice.add(gasPrice.mul(GAS_BUMP_PERCENT));

                  // TODO: resend exact same tx with the same nonce, overwrite the response in the DB
                } else {
                  // If we get any other error here, we classify this event as a tx failure and break out of the loop.
                  this.log.error({ method: "sendTxAndParseResponse", error: jsonifyError(e) }, "Transaction reverted.");
                  await this.store.saveTransactionFailure(channelAddress, response!.hash, e.message);
                  this.evts[ChainServiceEvents.TRANSACTION_FAILED].post({
                    error: e,
                    channelAddress,
                    reason,
                  });
                  reject(Result.fail(e));
                }
              }
            }
          });
        };

        // add completed function
        return Result.ok({
          ...response,
          completed,
        });
      });
      if (!response) {
        return Result.ok(response);
      }
      return response;
    } catch (e) {
      // Don't save tx if it failed to submit, only if it fails to mine
      let error = e;
      if (e.message.includes("sender doesn't have enough funds")) {
        error = new ChainError(ChainError.reasons.NotEnoughFunds);
      } else {
        this.log.error({ channelAddress, reason, error: jsonifyError(e) }, "Failed to do tx");
      }
      return Result.fail(error);
    }
  }

  private async waitForConfirmation(chainId: number, response: TransactionResponse): Promise<TransactionReceipt> {
    const provider: JsonRpcProvider = this.chainProviders[chainId];
    if (!provider) {
      throw new ChainError(ChainError.reasons.ProviderNotFound);
    }
    // An anon fn to get the tx receipt, as we may require multiple retries with raised gas price.
    const getTransactionReceipt = async (): Promise<TransactionReceipt | undefined> => {
      // TODO: This should be replaced with a polling method (?)
      // TODO: If we're polling here, we shouldn't be awaiting a receipt, but checking to see if it's available
      // (i.e. it's been confirmed / mined).
      return await provider.getTransactionReceipt(response.hash);
      // TODO: If the tx has not yet been mined, return undefined.
      // return undefined;
    };

    let receipt: TransactionReceipt | undefined = undefined;

    // Poll for receipt.
    // let result = await waitForTransaction(provider, response.hash);
    receipt = await getTransactionReceipt();
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
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
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
        async (gasPrice: BigNumber) => {
          const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
          if (multisigRes.isError) {
            return Result.fail(multisigRes.getError()!);
          }
          if (multisigRes.getValue() !== `0x`) {
            return undefined;
          }
          return channelFactory.createChannel(channelState.alice, channelState.bob, {
            gasPrice: gasPrice,
            gasLimit: BIG_GAS_LIMIT,
          });
        },
      );
      if (result.isError) {
        return result as Result<any, ChainError>;
      }
      if (!result.getValue()) {
        return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
      }
      return result as Result<TransactionResponseWithResult>;
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
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.deployWithDepositAlice,
        async (gasPrice: BigNumber) => {
          const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
          if (multisigRes.isError) {
            return Result.fail(multisigRes.getError()!);
          }
          if (multisigRes.getValue() !== `0x`) {
            // multisig deployed, just send deposit
            return this.sendDepositATx(channelState, amount, AddressZero);
          }
          // otherwise deploy with deposit
          return channelFactory.createChannelAndDepositAlice(channelState.alice, channelState.bob, assetId, amount, {
            value: amount,
            gasPrice: gasPrice,
            gasLimit: BIG_GAS_LIMIT,
          });
        },
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
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
      const receipt = await approveRes.getValue()!.wait(getConfirmationsForChain(channelState.networkContext.chainId));
      if (receipt.status === 0) {
        return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
      }
      this.log.info({ txHash: receipt.transactionHash, method, assetId }, "Token approval confirmed");
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.deployWithDepositAlice,
      async (gasPrice: BigNumber) => {
        const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
        if (multisigRes.isError) {
          return Result.fail(multisigRes.getError()!);
        }
        if (multisigRes.getValue() !== `0x`) {
          // multisig deployed, just send deposit (will check allowance)
          return this.sendDepositATx(channelState, amount, assetId);
        }
        return channelFactory.createChannelAndDepositAlice(channelState.alice, channelState.bob, assetId, amount, {
          gasPrice: gasPrice,
          gasLimit: BIG_GAS_LIMIT,
        });
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendWithdrawTx(
    channelState: FullChannelState,
    minTx: MinimalTransaction,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
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
      const deployTx = txRes.isError ? undefined : txRes.getValue();
      if (deployTx) {
        this.log.info({ method, methodId, deployTx: deployTx.hash }, "Deploy tx broadcast");
        try {
          this.log.debug(
            {
              method,
              methodId,
            },
            "Waiting for event to be emitted",
          );
          const receipt = await deployTx.wait(getConfirmationsForChain(channelState.networkContext.chainId));
          if (receipt.status === 0) {
            return Result.fail(
              new ChainError(ChainError.reasons.TxReverted, {
                receipt,
                deployTx: deployTx.hash,
                channel: channelState.channelAddress,
                chainId: channelState.networkContext.chainId,
              }),
            );
          }
        } catch (e) {
          this.log.error({ method, methodId, error: jsonifyError(e) }, "Caught error waiting for tx");
          return Result.fail(
            new ChainError(ChainError.reasons.FailedToDeploy, {
              error: e.message,
              deployTx: deployTx.hash,
              channel: channelState.channelAddress,
              chainId: channelState.networkContext.chainId,
            }),
          );
        }
        this.log.debug({ method, methodId }, "Deploy tx mined");
      } else {
        this.log.info({ method, methodId }, "Multisig already deployed");
      }
    }

    this.log.info({ sender, method, methodId, channel: channelState.channelAddress }, "Sending withdraw tx to chain");
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.withdraw,
      async (gasPrice: BigNumber) => {
        return signer.sendTransaction({ ...minTx, gasPrice, gasLimit: BIG_GAS_LIMIT, from: sender });
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendDepositTx(
    channelState: FullChannelState,
    sender: string,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
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
      return this.sendDeployChannelTx(channelState, { amount, assetId });
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
        this.log.error({ method, error: txRes.getError()?.message }, "Error sending tx");
      } else {
        this.log.info({ method, txHash: txRes.getValue().hash }, "Submitted tx");
      }
      return txRes;
    } else {
      this.log.info(
        { method, sender, alice: channelState.alice, bob: channelState.bob },
        "Detected participant B, sendng tx",
      );
      const txRes = await this.sendDepositBTx(channelState, amount, assetId);
      if (txRes.isError) {
        this.log.error({ method, error: txRes.getError()?.message }, "Error sending tx");
      } else {
        this.log.info({ method, txHash: txRes.getValue().hash }, "Submitted tx");
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
  ): Promise<Result<TransactionResponseWithResult | undefined, ChainError>> {
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
      async (gasPrice: BigNumber) => {
        return erc20.approve(spender, approvalAmount, { gasPrice });
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
    this.log.info({ txHash: approveTx!.hash, method, assetId, approvalAmount }, "Approve token tx submitted");
    return approveRes;
  }

  public async sendDepositATx(
    channelState: FullChannelState,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
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
      const approveTx = approveRes.getValue();
      if (approveTx) {
        const receipt = await approveTx.wait();
        if (receipt.status === 0) {
          return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
        }
      }
      this.log.info({ txHash: approveTx?.hash, method, methodId, assetId }, "Token approval confirmed");
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositA,
        async (gasPrice: BigNumber) => {
          return vectorChannel.depositAlice(assetId, amount, { gasPrice });
        },
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.depositA,
      async (gasPrice: BigNumber) => {
        return vectorChannel.depositAlice(assetId, amount, { value: amount, gasPrice });
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendDepositBTx(
    channelState: FullChannelState,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    if (assetId === AddressZero) {
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositB,
        async (gasPrice: BigNumber) => {
          return signer.sendTransaction({
            data: "0x",
            to: channelState.channelAddress,
            value: BigNumber.from(amount),
            chainId: channelState.networkContext.chainId,
            gasPrice,
            from: sender,
          });
        },
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    } else {
      const erc20 = new Contract(channelState.networkContext.channelFactoryAddress, ERC20Abi, signer);
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositB,
        async (gasPrice: BigNumber) => {
          return erc20.transfer(channelState.channelAddress, amount, { gasPrice });
        },
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    }
  }

  async sendDisputeChannelTx(
    channelState: FullChannelState,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
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
      this.log.debug(
        { method, methodId, channelAddress: channelState.channelAddress, transactionHash: deploy.getValue().hash },
        "Deploy channel tx",
      );
      const result = await deploy.getValue().completed();
      if (result.isError) {
        return Result.fail(result.getError()!);
      }
      this.log.info(
        {
          method,
          methodId,
          channelAddress: channelState.channelAddress,
          transactionHash: result.getValue().transactionHash,
        },
        "Channel deployed",
      );
    }

    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.disputeChannel,
      () => {
        const channel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
        return channel.disputeChannel(
          channelState,
          channelState.latestUpdate.aliceSignature,
          channelState.latestUpdate.bobSignature,
        );
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  async sendDefundChannelTx(
    channelState: FullChannelState,
    assetsToDefund: string[] = channelState.assetIds,
    indices: string[] = [],
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!channelState.latestUpdate.aliceSignature || !channelState.latestUpdate.bobSignature) {
      return Result.fail(new ChainError(ChainError.reasons.MissingSigs));
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.defundChannel,
      () => {
        const channel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
        return channel.defundChannel(
          channelState,
          assetsToDefund,
          indices.length > 0 ? indices : assetsToDefund.map((_asset, idx) => idx),
        );
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  async sendDisputeTransferTx(
    transferIdToDispute: string,
    activeTransfers: FullTransferState[],
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
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

    return this.sendTxWithRetries(
      transferState.channelAddress,
      transferState.chainId,
      TransactionReason.disputeTransfer,
      () => {
        const channel = new Contract(transferState.channelAddress, VectorChannel.abi, signer);
        return channel.disputeTransfer(transferState, tree.getHexProof(hashCoreTransferState(transferState)));
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  async sendDefundTransferTx(
    transferState: FullTransferState,
    responderSignature: string = HashZero,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(transferState.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!transferState.transferResolver) {
      return Result.fail(new ChainError(ChainError.reasons.ResolverNeeded));
    }

    const encodedState = encodeTransferState(transferState.transferState, transferState.transferEncodings[0]);
    const encodedResolver = encodeTransferResolver(transferState.transferResolver, transferState.transferEncodings[1]);

    return this.sendTxWithRetries(
      transferState.channelAddress,
      transferState.chainId,
      TransactionReason.defundTransfer,
      () => {
        const channel = new Contract(transferState.channelAddress, VectorChannel.abi, signer);
        return channel.defundTransfer(transferState, encodedState, encodedResolver, responderSignature);
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendExitChannelTx(
    channelAddress: string,
    chainId: number,
    assetId: string,
    owner: string,
    recipient: string,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    this.log.info({ channelAddress, chainId, assetId, owner, recipient }, "Defunding channel");

    return this.sendTxWithRetries(channelAddress, chainId, TransactionReason.exitChannel, () => {
      const channel = new Contract(channelAddress, VectorChannel.abi, signer);
      return channel.exit(assetId, owner, recipient);
    }) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }
}
