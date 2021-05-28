import { Vector } from "@connext/vector-protocol";
import {
  ChainAddresses,
  IChannelSigner,
  IMessagingService,
  IVectorProtocol,
  Result,
  EngineParams,
  ChannelRpcMethodsResponsesMap,
  IVectorEngine,
  EngineEventMap,
  IEngineStore,
  EngineEvent,
  EngineEvents,
  ChannelRpcMethod,
  IVectorChainService,
  WITHDRAWAL_RECONCILED_EVENT,
  ChannelRpcMethods,
  IExternalValidation,
  AUTODEPLOY_CHAIN_IDS,
  EngineError,
  UpdateType,
  Values,
  VectorError,
  jsonifyError,
  MinimalTransaction,
  WITHDRAWAL_RESOLVED_EVENT,
  VectorErrorJson,
  ProtocolError,
} from "@connext/vector-types";
import {
  generateMerkleRoot,
  validateChannelUpdateSignatures,
  getSignerAddressFromPublicIdentifier,
  getRandomBytes32,
  getParticipant,
  hashWithdrawalQuote,
  delay,
} from "@connext/vector-utils";
import pino from "pino";
import Ajv from "ajv";
import { Evt } from "evt";

import { version } from "../package.json";

import { DisputeError, IsAliveError, RestoreError, RpcError } from "./errors";
import {
  convertConditionalTransferParams,
  convertResolveConditionParams,
  convertSetupParams,
  convertWithdrawParams,
} from "./paramConverter";
import { setupEngineListeners } from "./listeners";
import { getEngineEvtContainer, withdrawRetryForTransferId } from "./utils";
import { sendIsAlive } from "./isAlive";
import { WithdrawCommitment } from "@connext/vector-contracts";
import { FullChannelState } from "../../types/dist/src";

export const ajv = new Ajv();

export type EngineEvtContainer = { [K in EngineEvent]: Evt<EngineEventMap[K]> };

export class VectorEngine implements IVectorEngine {
  // Setup event container to emit events from vector
  private readonly evts: EngineEvtContainer = getEngineEvtContainer();

  private constructor(
    private readonly signer: IChannelSigner,
    private readonly messaging: IMessagingService,
    private readonly store: IEngineStore,
    private readonly vector: IVectorProtocol,
    private readonly chainService: IVectorChainService,
    private readonly chainAddresses: ChainAddresses,
    private readonly logger: pino.BaseLogger,
  ) {}

  static async connect(
    messaging: IMessagingService,
    store: IEngineStore,
    signer: IChannelSigner,
    chainService: IVectorChainService,
    chainAddresses: ChainAddresses,
    logger: pino.BaseLogger,
    skipCheckIn: boolean,
    gasSubsidyPercentage: number,
    validationService?: IExternalValidation,
  ): Promise<VectorEngine> {
    const vector = await Vector.connect(
      messaging,
      store,
      signer,
      chainService,
      logger.child({ module: "VectorProtocol" }),
      skipCheckIn,
      validationService,
    );
    const engine = new VectorEngine(
      signer,
      messaging,
      store,
      vector,
      chainService,
      chainAddresses,
      logger.child({ module: "VectorEngine" }),
    );
    await engine.setupListener(gasSubsidyPercentage);
    logger.debug({}, "Setup engine listeners");
    if (!skipCheckIn) {
      sendIsAlive(engine.signer, engine.messaging, engine.store, engine.chainService, engine.logger);
    } else {
      logger.warn("Skipping isAlive broadcast because of skipCheckIn config");
    }
    logger.info({ vector: vector.publicIdentifier }, "Vector Engine connected 🚀!");
    return engine;
  }

  get publicIdentifier(): string {
    return this.vector.publicIdentifier;
  }

  get signerAddress(): string {
    return this.vector.signerAddress;
  }

  private async setupListener(gasSubsidyPercentage: number): Promise<void> {
    await setupEngineListeners(
      this.evts,
      this.chainService,
      this.vector,
      this.messaging,
      this.signer,
      this.store,
      this.chainAddresses,
      this.logger,
      this.setup.bind(this),
      gasSubsidyPercentage,
    );
  }

  private async getConfig(): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getConfig], EngineError>
  > {
    return Result.ok([
      {
        index: 0,
        publicIdentifier: this.publicIdentifier,
        signerAddress: this.signerAddress,
        chainAddresses: this.chainAddresses,
      },
    ]);
  }

  private async getTransferQuote(
    params: EngineParams.GetTransferQuote,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferQuote], EngineError>> {
    const validate = ajv.compile(EngineParams.GetTransferQuoteSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const { routerIdentifier, ...message } = params;
    return this.messaging.sendTransferQuoteMessage(Result.ok(message), routerIdentifier, this.publicIdentifier);
  }

  private async getWithdrawalQuote(
    params: EngineParams.GetWithdrawalQuote,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getWithdrawalQuote], EngineError>> {
    const validate = ajv.compile(EngineParams.GetWithdrawalQuoteSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(new RpcError(RpcError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier));
    }

    if (this.publicIdentifier === channel.aliceIdentifier) {
      try {
        // return 0 for quoted fee if you are alice (since you are the submitter)
        const quote = {
          channelAddress: params.channelAddress,
          amount: params.amount,
          assetId: params.assetId,
          fee: "0",
          expiry: (Date.now() + 30_000).toString(),
        };
        const signature = await this.signer.signMessage(hashWithdrawalQuote(quote));
        return Result.ok({ ...quote, signature });
      } catch (e) {
        return Result.fail(
          new RpcError(RpcError.reasons.SigningFailed, params.channelAddress, this.publicIdentifier, {
            signingError: jsonifyError(e),
          }),
        );
      }
    }

    // you are not alice, send request to channel counterparty
    return this.messaging.sendWithdrawalQuoteMessage(Result.ok(params), channel.aliceIdentifier, this.publicIdentifier);
  }

  private async getRouterConfig(
    params: EngineParams.GetRouterConfig,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getRouterConfig], EngineError>> {
    const validate = ajv.compile(EngineParams.GetRouterConfigSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    return this.messaging.sendRouterConfigMessage(Result.ok(undefined), params.routerIdentifier, this.publicIdentifier);
  }

  private async getStatus(): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getStatus], EngineError>
  > {
    const chainIds = Object.keys(this.chainAddresses).map((chainId) => parseInt(chainId));
    const providerResponses = await Promise.all(chainIds.map((chainId) => this.chainService.getSyncing(chainId)));
    const providerSyncing = Object.fromEntries(
      chainIds.map((chainId, index) => {
        const res = providerResponses[index];
        let syncing:
          | string
          | boolean
          | { startingBlock: string; currentBlock: string; highestBlock: string }
          | undefined;
        if (res.isError) {
          syncing = res.getError()?.message;
        } else {
          syncing = res.getValue();
        }
        return [chainId, syncing];
      }),
    );
    return Result.ok({
      version,
      publicIdentifier: this.publicIdentifier,
      signerAddress: this.signerAddress,
      providerSyncing,
    });
  }

  private async getChannelState(
    params: EngineParams.GetChannelState,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getChannelState], EngineError>> {
    const validate = ajv.compile(EngineParams.GetChannelStateSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    try {
      const channel = await this.store.getChannelState(params.channelAddress);
      return Result.ok(channel);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, params.channelAddress, this.publicIdentifier, {
          storeMethod: "getChannelState",
          storeError: e.message,
          params,
        }),
      );
    }
  }

  private async getTransferState(
    params: EngineParams.GetTransferState,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferState], EngineError>> {
    const validate = ajv.compile(EngineParams.GetTransferStateSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    try {
      const transfer = await this.store.getTransferState(params.transferId);
      return Result.ok(transfer);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getTransferState",
          storeError: e.message,
          params,
        }),
      );
    }
  }

  private async getActiveTransfers(
    params: EngineParams.GetActiveTransfers,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getActiveTransfers], EngineError>> {
    const validate = ajv.compile(EngineParams.GetActiveTransfersSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    try {
      const transfers = await this.store.getActiveTransfers(params.channelAddress);
      return Result.ok(transfers);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, params.channelAddress, this.publicIdentifier, {
          storeMethod: "getActiveTransfers",
          storeError: e.message,
        }),
      );
    }
  }

  private async getTransfers(
    params: EngineParams.GetTransfers,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransfers], EngineError>> {
    const validate = ajv.compile(EngineParams.GetTransfersSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    try {
      const transfers = await this.store.getTransfers(params);
      return Result.ok(transfers);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getTransfers",
          storeError: e.message,
        }),
      );
    }
  }

  private async getTransferStateByRoutingId(
    params: EngineParams.GetTransferStateByRoutingId,
  ): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferStateByRoutingId], EngineError>
  > {
    const validate = ajv.compile(EngineParams.GetTransferStateByRoutingIdSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    try {
      const transfer = await this.store.getTransferByRoutingId(params.channelAddress, params.routingId);
      return Result.ok(transfer);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, params.channelAddress ?? "", this.publicIdentifier, {
          storeMethod: "getTransferByRoutingId",
          storeError: e.message,
        }),
      );
    }
  }

  private async getTransferStatesByRoutingId(
    params: EngineParams.GetTransferStatesByRoutingId,
  ): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferStatesByRoutingId], EngineError>
  > {
    const validate = ajv.compile(EngineParams.GetTransferStatesByRoutingIdSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    try {
      const transfers = await this.store.getTransfersByRoutingId(params.routingId);
      return Result.ok(transfers);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getTransfersByRoutingId",
          storeError: e.message,
        }),
      );
    }
  }

  private async getChannelStateByParticipants(
    params: EngineParams.GetChannelStateByParticipants,
  ): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getChannelStateByParticipants], EngineError>
  > {
    const validate = ajv.compile(EngineParams.GetChannelStateByParticipantsSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    try {
      const channel = await this.store.getChannelStateByParticipants(params.alice, params.bob, params.chainId);
      return Result.ok(channel);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getChannelStateByParticipants",
          storeError: e.message,
          params,
        }),
      );
    }
  }

  private async getChannelStates(): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getChannelStates], EngineError>
  > {
    try {
      const channel = await this.store.getChannelStates();
      return Result.ok(channel);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getChannelStates",
          storeError: e.message,
        }),
      );
    }
  }

  private async getRegisteredTransfers(
    params: EngineParams.GetRegisteredTransfers,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getRegisteredTransfers], EngineError>> {
    const validate = ajv.compile(EngineParams.GetRegisteredTransfersSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const { chainId } = params;
    const result = await this.chainService.getRegisteredTransfers(
      this.chainAddresses[chainId].transferRegistryAddress,
      chainId,
    );
    return result;
  }

  private async getWithdrawalCommitment(
    params: EngineParams.GetWithdrawalCommitment,
  ): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getWithdrawalCommitment], EngineError>
  > {
    const validate = ajv.compile(EngineParams.GetWithdrawalCommitmentSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const { transferId } = params;
    try {
      const result = await this.store.getWithdrawalCommitment(transferId);
      return Result.ok(result);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getWithdrawalCommitment",
          error: jsonifyError(e),
        }),
      );
    }
  }

  private async getWithdrawalCommitmentByTransactionHash(
    params: EngineParams.GetWithdrawalCommitmentByTransactionHash,
  ): Promise<
    Result<
      ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getWithdrawalCommitmentByTransactionHash],
      EngineError
    >
  > {
    const validate = ajv.compile(EngineParams.GetWithdrawalCommitmentByTransactionHashSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const { transactionHash } = params;
    try {
      const result = await this.store.getWithdrawalCommitmentByTransactionHash(transactionHash);
      return Result.ok(result);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, {
          storeMethod: "getWithdrawalCommitmentByTransactionHash",
          error: jsonifyError(e),
        }),
      );
    }
  }

  private async setup(
    params: EngineParams.Setup,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_setup], VectorError>> {
    const method = "setup";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.SetupSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const chainProviders = this.chainService.getChainProviders();
    if (chainProviders.isError) {
      return Result.fail(chainProviders.getError()!);
    }

    const setupParamsResult = await convertSetupParams(params, this.chainAddresses);
    if (setupParamsResult.isError) {
      return Result.fail(setupParamsResult.getError()!);
    }
    const setupRes = await this.runProtocolMethodWithRetries<FullChannelState>(
      () => this.vector.setup(setupParamsResult.getValue()),
      "",
    );

    if (setupRes.isError) {
      return Result.fail(setupRes.getError()!);
    }

    const channel = setupRes.getValue();
    if (this.signerAddress === channel.bob) {
      return setupRes;
    }

    // If it is alice && chain id is in autodeployable chains, deploy contract
    if (!AUTODEPLOY_CHAIN_IDS.includes(channel.networkContext.chainId)) {
      return setupRes;
    }

    this.logger.info(
      { method, chainId: channel.networkContext.chainId, channel: channel.channelAddress },
      "Deploying channel multisig",
    );

    const deployRes = await this.chainService.sendDeployChannelTx(channel);
    if (deployRes.isError) {
      const err = deployRes.getError();
      this.logger.error(
        {
          ...(err?.context ?? {}),
          chainId: channel.networkContext.chainId,
          channel: channel.channelAddress,
          error: deployRes.getError()!.message,
        },
        "Failed to deploy channel multisig",
      );
      return setupRes;
    }
    const receipt = deployRes.getValue();
    this.logger.debug({ chainId: channel.networkContext.chainId, hash: receipt.transactionHash }, "Deploy tx mined");
    this.logger.info(
      {
        result: setupRes.isError ? jsonifyError(setupRes.getError()!) : setupRes.getValue().channelAddress,
        method,
        methodId,
      },
      "Method complete",
    );
    return setupRes;
  }

  private async requestSetup(params: EngineParams.Setup): Promise<Result<{ channelAddress: string }, EngineError>> {
    const method = "requestSetup";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.SetupSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const res = await this.messaging.sendSetupMessage(
      Result.ok(params),
      params.counterpartyIdentifier,
      this.publicIdentifier,
    );
    this.logger.info(
      { result: res.isError ? jsonifyError(res.getError()!) : res.getValue().channelAddress, method, methodId },
      "Method complete",
    );
    return res;
  }

  private async deposit(
    params: EngineParams.Deposit,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_deposit], EngineError>> {
    const method = "deposit";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.DepositSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    // NOTE: There is a race-condition for deposits because the onchain process
    // is out-of-band of the protocol. For instance:
    // 1. Alice deposits 5 onchain
    // 2a. Alice sends single-signed update where she has reconciled the 5
    // 2b. Bob deposits 3 onchain
    // 3. Bob receives Alice's signature, and attempts to reconcile on their
    //    own. Bob reconciles 8 and fails to recover Alice's signature properly
    //    leaving all 8 out of the channel.

    // This race condition should be handled by the protocol retries
    const depositRes = await this.runProtocolMethodWithRetries<FullChannelState>(
      () => this.vector.deposit(params),
      params.channelAddress,
    );
    this.logger.info(
      {
        result: depositRes.isError ? jsonifyError(depositRes.getError()!) : depositRes.getValue().channelAddress,
        method,
        methodId,
      },
      "Method complete",
    );

    return depositRes;
  }

  private async requestCollateral(params: EngineParams.RequestCollateral): Promise<Result<undefined, EngineError>> {
    const method = "requestCollateral";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.RequestCollateralSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(new RpcError(RpcError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier));
    }

    const participant = getParticipant(channel, this.publicIdentifier);
    if (!participant) {
      return Result.fail(
        new RpcError(RpcError.reasons.SignerNotInChannel, channel.channelAddress, this.publicIdentifier, {
          alice: channel.aliceIdentifier,
          bob: channel.bobIdentifier,
          signer: this.publicIdentifier,
        }),
      );
    }

    const request = await this.messaging.sendRequestCollateralMessage(
      Result.ok(params),
      participant === "alice" ? channel.bobIdentifier : channel.aliceIdentifier,
      this.publicIdentifier,
    );
    this.logger.info(
      { result: request.isError ? jsonifyError(request.getError()!) : request.getValue(), method, methodId },
      "Method complete",
    );
    return request as Result<undefined, EngineError>;
  }

  private async createTransfer(
    params: EngineParams.ConditionalTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_createTransfer], VectorError>> {
    const method = "createTransfer";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.ConditionalTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(new RpcError(RpcError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier));
    }
    this.logger.info({ channel, method, methodId }, "Pre-transfer channel");

    // First, get translated `create` params using the passed in conditional transfer ones
    const createResult = await convertConditionalTransferParams(
      params,
      this.signer,
      channel,
      this.chainService,
      this.messaging,
    );
    if (createResult.isError) {
      return Result.fail(createResult.getError()!);
    }
    const createParams = createResult.getValue();
    this.logger.info({ transferParams: createParams, method, methodId }, "Created conditional transfer params");
    const protocolRes = await this.runProtocolMethodWithRetries<FullChannelState>(
      () => this.vector.create(createParams),
      createParams.channelAddress,
    );
    if (protocolRes.isError) {
      return Result.fail(protocolRes.getError()!);
    }
    const res = protocolRes.getValue();
    this.logger.info({ channelAddress: res.channelAddress, method, methodId }, "Method complete");
    return Result.ok(res);
  }

  private async resolveTransfer(
    params: EngineParams.ResolveTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_resolveTransfer], EngineError>> {
    const method = "resolveTransfer";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.ResolveTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const transferRes = await this.getTransferState({ transferId: params.transferId });
    if (transferRes.isError) {
      return Result.fail(transferRes.getError()!);
    }
    const transfer = transferRes.getValue();
    if (!transfer) {
      return Result.fail(
        new RpcError(RpcError.reasons.TransferNotFound, params.channelAddress ?? "", this.publicIdentifier, {
          transferId: params.transferId,
        }),
      );
    }
    this.logger.info({ transfer, method, methodId }, "Transfer pre-resolve");

    // First, get translated `create` params using the passed in conditional transfer ones
    const resolveResult = convertResolveConditionParams(params, transfer);
    if (resolveResult.isError) {
      return Result.fail(resolveResult.getError()!);
    }
    const resolveParams = resolveResult.getValue();
    const protocolRes = await this.runProtocolMethodWithRetries<FullChannelState>(
      () => this.vector.resolve(resolveParams),
      resolveParams.channelAddress,
    );
    if (protocolRes.isError) {
      return Result.fail(protocolRes.getError()!);
    }
    const res = protocolRes.getValue();
    this.logger.info({ channelAddress: res.channelAddress, method, methodId }, "Method complete");
    return Result.ok(res);
  }

  private async withdraw(
    params: EngineParams.Withdraw,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_withdraw], EngineError>> {
    const method = "withdraw";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.WithdrawSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(new RpcError(RpcError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier));
    }

    // First, get translated `create` params from withdraw
    const createResult = await convertWithdrawParams(
      params,
      this.signer,
      channel,
      this.chainAddresses,
      this.chainService,
      this.messaging,
    );
    if (createResult.isError) {
      return Result.fail(createResult.getError()!);
    }
    const createParams = createResult.getValue();
    const initiatorSubmits = createParams.meta.initiatorSubmits ?? false;

    // set up event listeners before sending request
    const timeout = 300_000;
    const resolved = (_transferId: string) =>
      this.evts[WITHDRAWAL_RESOLVED_EVENT].waitFor(
        (data) => data.channelAddress === params.channelAddress && data.transfer.transferId === _transferId,
        timeout,
      );
    const reconciled = (_transferId: string) =>
      this.evts[WITHDRAWAL_RECONCILED_EVENT].waitFor(
        (data) => data.channelAddress === params.channelAddress && data.transferId === _transferId,
        timeout,
      );

    // create withdrawal transfer
    const protocolRes = await this.runProtocolMethodWithRetries<FullChannelState>(
      () => this.vector.create(createParams),
      createParams.channelAddress,
    );
    if (protocolRes.isError) {
      return Result.fail(protocolRes.getError()!);
    }
    const res = protocolRes.getValue();
    const transferId = res.latestUpdate.details.transferId;
    this.logger.info({ channelAddress: params.channelAddress, transferId }, "Withdraw transfer created");

    let transactionHash: string | undefined;
    let transaction: MinimalTransaction | undefined;
    try {
      // wait for resolution either way
      const _resolved = await resolved(transferId);

      // if we arent explicitly submitting, wait for counterparty to submit
      if (!initiatorSubmits) {
        const _reconciled = await reconciled(transferId);
        transactionHash = typeof _reconciled === "object" ? _reconciled.transactionHash : undefined;
      }
      transaction = _resolved.transaction;
    } catch (e) {
      this.logger.warn(
        { channelAddress: params.channelAddress, transferId, timeout, initiatorSubmits },
        "Withdraw tx not processed properly",
      );
    }
    if (!transaction) {
      // try to get from store
      const commitment = await this.store.getWithdrawalCommitment(transferId);
      if (!commitment) {
        return Result.fail(
          new RpcError(RpcError.reasons.WithdrawResolutionFailed, params.channelAddress, this.publicIdentifier, {
            transferId,
          }),
        );
      }

      transaction = (await WithdrawCommitment.fromJson(commitment)).getSignedTransaction();
    }

    this.logger.info(
      { channelAddress: res.channelAddress, method, methodId, transactionHash, transaction },
      "Method complete",
    );
    return Result.ok({ channel: res, transactionHash, transaction: transaction! });
  }

  private async withdrawRetry(
    params: EngineParams.WithdrawRetry,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_withdrawRetry], EngineError>> {
    const method = "withdrawRetry";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.WithdrawRetrySchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(
        new RpcError(RpcError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier, {
          transferId: params.transferId,
        }),
      );
    }

    const res = await withdrawRetryForTransferId(
      params.transferId,
      channel,
      this.store,
      this.chainService,
      this.logger,
      this.messaging,
      this.publicIdentifier,
    );

    if (res.isError) {
      return Result.fail(res.getError()!);
    }

    const withdrawRetryRes = res.getValue();

    this.logger.info(
      {
        channel: channel,
        method,
        methodId,
        txHash: withdrawRetryRes.transactionHash,
        channelAddress: withdrawRetryRes.channelAddress,
      },
      "Method complete",
    );

    return Result.ok(withdrawRetryRes);
  }

  private async decrypt(encrypted: string): Promise<Result<string, EngineError>> {
    const method = "decrypt";
    const methodId = getRandomBytes32();
    this.logger.info({ encrypted, method, methodId }, "Method started");
    try {
      const res = await this.signer.decrypt(encrypted);
      this.logger.info({ res, method, methodId }, "Method complete");
      return Result.ok(res);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.DecryptFailed, "", this.publicIdentifier, {
          decryptError: e.message,
        }),
      );
    }
  }

  private async signUtilityMessage(params: EngineParams.SignUtilityMessage): Promise<Result<string, EngineError>> {
    const method = "signUtilityMessage";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.SignUtilityMessageSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    try {
      const sig = await this.signer.signUtilityMessage(params.message);
      this.logger.info({ sig, method, methodId }, "Method complete");
      return Result.ok(sig);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.UtilitySigningFailed, "", this.publicIdentifier, {
          signingError: e.message,
        }),
      );
    }
  }

  private async sendIsAlive(
    params: EngineParams.SendIsAlive,
  ): Promise<Result<{ channelAddress: string }, EngineError>> {
    const method = "sendIsAlive";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.SendIsAliveSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    try {
      const channel = await this.store.getChannelState(params.channelAddress);
      if (!channel) {
        return Result.fail(
          new IsAliveError(IsAliveError.reasons.ChannelNotFound, params.channelAddress, this.signer.publicIdentifier),
        );
      }
      const counterparty = this.signer.address === channel.alice ? channel.bobIdentifier : channel.aliceIdentifier;
      const res = await this.messaging.sendIsAliveMessage(
        Result.ok(params),
        counterparty,
        this.signer.publicIdentifier,
      );
      this.logger.info(
        { result: res.isError ? jsonifyError(res.getError()!) : res.getValue().channelAddress, method, methodId },
        "Method complete",
      );
      return res;
    } catch (e) {
      return Result.fail(
        new IsAliveError(IsAliveError.reasons.Unknown, params.channelAddress, this.signer.publicIdentifier, {
          isAliveError: e.message,
        }),
      );
    }
  }

  // RESTORE STATE
  // NOTE: this is not added to the protocol queue. That is because if your
  // channel needs to be restored, any updates you are sent or try to send
  // will fail until your store is properly updated. The failures create
  // a natural lock. However, it is due to these failures that the protocol
  // methods are retried.
  private async restoreState(
    params: EngineParams.RestoreState,
  ): Promise<Result<ChannelRpcMethodsResponsesMap["chan_restoreState"], EngineError>> {
    const method = "restoreState";
    const methodId = getRandomBytes32();
    this.logger.info({ params, method, methodId }, "Method started");
    const validate = ajv.compile(EngineParams.RestoreStateSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    // Send message to counterparty, they will grab lock and
    // return information under lock, initiator will update channel,
    // then send confirmation message to counterparty, who will release the lock
    const { chainId, counterpartyIdentifier } = params;
    const restoreDataRes = await this.messaging.sendRestoreStateMessage(
      Result.ok({ chainId }),
      counterpartyIdentifier,
      this.signer.publicIdentifier,
    );
    if (restoreDataRes.isError) {
      return Result.fail(restoreDataRes.getError()!);
    }

    const { channel, activeTransfers } = restoreDataRes.getValue() ?? ({} as any);

    // Create helper to generate error
    const generateRestoreError = (
      error: Values<typeof RestoreError.reasons>,
      context: any = {},
    ): Result<FullChannelState, RestoreError> => {
      // handle error by returning it to counterparty && returning result
      const err = new RestoreError(error, channel?.channelAddress ?? "", this.publicIdentifier, {
        ...context,
        method,
        params,
      });
      return Result.fail(err);
    };

    // Verify data exists
    if (!channel || !activeTransfers) {
      return generateRestoreError(RestoreError.reasons.NoData);
    }

    // Verify channel address is same as calculated
    const counterparty = getSignerAddressFromPublicIdentifier(counterpartyIdentifier);
    const calculated = await this.chainService.getChannelAddress(
      channel.alice === this.signer.address ? this.signer.address : counterparty,
      channel.bob === this.signer.address ? this.signer.address : counterparty,
      channel.networkContext.channelFactoryAddress,
      chainId,
    );
    if (calculated.isError) {
      return generateRestoreError(RestoreError.reasons.GetChannelAddressFailed, {
        getChannelAddressError: jsonifyError(calculated.getError()!),
      });
    }
    if (calculated.getValue() !== channel.channelAddress) {
      return generateRestoreError(RestoreError.reasons.InvalidChannelAddress, {
        calculated: calculated.getValue(),
      });
    }

    // Verify signatures on latest update
    const sigRes = await validateChannelUpdateSignatures(
      channel,
      channel.latestUpdate.aliceSignature,
      channel.latestUpdate.bobSignature,
      "both",
    );
    if (sigRes.isError) {
      return generateRestoreError(RestoreError.reasons.InvalidSignatures, {
        recoveryError: sigRes.getError().message,
      });
    }

    // Verify transfers match merkleRoot
    const root = generateMerkleRoot(activeTransfers);
    if (root !== channel.merkleRoot) {
      return generateRestoreError(RestoreError.reasons.InvalidMerkleRoot, {
        calculated: root,
        merkleRoot: channel.merkleRoot,
        activeTransfers: activeTransfers.map((t) => t.transferId),
      });
    }

    // Verify nothing with a sync-able nonce exists in store
    const existing = await this.getChannelState({ channelAddress: channel.channelAddress });
    if (existing.isError) {
      return generateRestoreError(RestoreError.reasons.CouldNotGetChannel, {
        getChannelStateError: jsonifyError(existing.getError()!),
      });
    }
    const nonce = existing.getValue()?.nonce ?? 0;
    const diff = channel.nonce - nonce;
    if (diff <= 1 && channel.latestUpdate.type !== UpdateType.setup) {
      return generateRestoreError(RestoreError.reasons.SyncableState, {
        existing: nonce,
        toRestore: channel.nonce,
      });
    }

    // Save channel
    try {
      await this.store.saveChannelStateAndTransfers(channel, activeTransfers);
    } catch (e) {
      return generateRestoreError(RestoreError.reasons.SaveChannelFailed, {
        saveChannelStateAndTransfersError: e.message,
      });
    }

    // Post to evt
    this.evts[EngineEvents.RESTORE_STATE_EVENT].post({
      channelAddress: channel.channelAddress,
      aliceIdentifier: channel.aliceIdentifier,
      bobIdentifier: channel.bobIdentifier,
      chainId,
    });

    this.logger.info(
      {
        channel,
        transfers: activeTransfers.map((t) => t.transferId),
        method,
        methodId,
      },
      "Method complete",
    );
    return Result.ok(channel);
  }

  // DISPUTE METHODS
  private async getDispute(
    params: EngineParams.GetChannelDispute,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getDispute], EngineError>> {
    const validate = ajv.compile(EngineParams.GetChannelDisputeSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    try {
      const dispute = await this.store.getChannelDispute(params.channelAddress);
      return Result.ok(dispute);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.StoreMethodFailed, params.channelAddress, this.publicIdentifier, { params }),
      );
    }
  }

  private async dispute(
    params: EngineParams.DisputeChannel,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_dispute], EngineError>> {
    const validate = ajv.compile(EngineParams.DisputeChannelSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const channel = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channel.isError) {
      return Result.fail(channel.getError()!);
    }
    const state = channel.getValue();
    if (!state) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier),
      );
    }
    const disputeRes = await this.chainService.sendDisputeChannelTx(state);
    if (disputeRes.isError) {
      return Result.fail(disputeRes.getError()!);
    }

    // save the dispute
    const dispute = await this.chainService.getChannelDispute(state.channelAddress, state.networkContext.chainId);
    if (!dispute.isError && !!dispute.getValue()) {
      try {
        await this.store.saveChannelDispute(state.channelAddress, dispute.getValue()!);
      } catch (e) {
        this.logger.error({ ...jsonifyError(e) }, "Failed to save channel dispute");
      }
    }

    return Result.ok({ transactionHash: disputeRes.getValue().transactionHash });
  }

  private async defund(
    params: EngineParams.DefundChannel,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_defund], EngineError>> {
    const validate = ajv.compile(EngineParams.DefundChannelSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, params.channelAddress ?? "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const channel = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channel.isError) {
      return Result.fail(channel.getError()!);
    }
    const state = channel.getValue();
    if (!state) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier),
      );
    }
    if (!state.inDispute) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.ChannelNotInDispute, params.channelAddress, this.publicIdentifier),
      );
    }
    const disputeRes = await this.chainService.sendDefundChannelTx(state);
    if (disputeRes.isError) {
      return Result.fail(disputeRes.getError()!);
    }

    return Result.ok({ transactionHash: disputeRes.getValue().transactionHash });
  }

  private async getTransferDispute(
    params: EngineParams.GetTransferDispute,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferDispute], EngineError>> {
    const validate = ajv.compile(EngineParams.DisputeTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    try {
      const dispute = await this.store.getTransferDispute(params.transferId);
      return Result.ok(dispute);
    } catch (e) {
      return Result.fail(new RpcError(RpcError.reasons.StoreMethodFailed, "", this.publicIdentifier, { params }));
    }
  }

  private async disputeTransfer(
    params: EngineParams.DisputeTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_disputeTransfer], EngineError>> {
    const validate = ajv.compile(EngineParams.DisputeTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }
    const transferRes = await this.getTransferState(params);
    if (transferRes.isError) {
      return Result.fail(transferRes.getError()!);
    }
    const transfer = transferRes.getValue();
    if (!transfer) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.TransferNotFound, "", this.publicIdentifier, {
          transferId: params.transferId,
        }),
      );
    }

    // Get active transfers
    const activeRes = await this.getActiveTransfers({ channelAddress: transfer.channelAddress });
    if (activeRes.isError) {
      return Result.fail(activeRes.getError()!);
    }
    const disputeRes = await this.chainService.sendDisputeTransferTx(transfer.transferId, activeRes.getValue());
    if (disputeRes.isError) {
      return Result.fail(disputeRes.getError()!);
    }
    return Result.ok({ transactionHash: disputeRes.getValue().transactionHash });
  }

  private async defundTransfer(
    params: EngineParams.DefundTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_defundTransfer], EngineError>> {
    const validate = ajv.compile(EngineParams.DefundTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const transferRes = await this.getTransferState(params);
    if (transferRes.isError) {
      return Result.fail(transferRes.getError()!);
    }
    const transfer = transferRes.getValue();
    if (!transfer) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.TransferNotFound, "", this.publicIdentifier, {
          transferId: params.transferId,
        }),
      );
    }

    if (!transfer.inDispute) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.TransferNotDisputed, transfer.channelAddress, this.publicIdentifier, {
          transferId: transfer.transferId,
        }),
      );
    }

    const defundRes = await this.chainService.sendDefundTransferTx(transfer);
    if (defundRes.isError) {
      return Result.fail(defundRes.getError()!);
    }
    return Result.ok({ transactionHash: defundRes.getValue().transactionHash });
  }

  private async exit(
    params: EngineParams.ExitChannel,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_exit], EngineError>> {
    const validate = ajv.compile(EngineParams.ExitChannelSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(
        new RpcError(RpcError.reasons.InvalidParams, "", this.publicIdentifier, {
          invalidParamsError: validate.errors?.map((e) => e.message).join(","),
          invalidParams: params,
        }),
      );
    }

    const channel = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channel.isError) {
      return Result.fail(channel.getError()!);
    }
    const state = channel.getValue();
    if (!state) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.ChannelNotFound, params.channelAddress, this.publicIdentifier),
      );
    }
    if (!state.inDispute) {
      return Result.fail(
        new DisputeError(DisputeError.reasons.ChannelNotInDispute, params.channelAddress, this.publicIdentifier),
      );
    }

    const results: { assetId: string; transactionHash?: string; error?: VectorErrorJson }[] = [];
    const recipient = params.recipient ?? this.signerAddress;
    const owner = params.owner ?? this.signerAddress;
    for (const assetId of params.assetIds) {
      const result = await this.chainService.sendExitChannelTx(
        state.channelAddress,
        state.networkContext.chainId,
        assetId,
        owner,
        recipient,
      );
      results.push({
        assetId,
        transactionHash: result.isError ? undefined : result.getValue().transactionHash,
        error: result.isError ? jsonifyError(result.getError()!) : undefined,
      });
    }

    return Result.ok(results);
  }

  // NOTE: no need to retry here because this method is not relevant
  // to restoreState conditions
  private async syncDisputes(): Promise<Result<void, EngineError>> {
    try {
      await this.vector.syncDisputes();
      return Result.ok(undefined);
    } catch (e) {
      return Result.fail(
        new RpcError(RpcError.reasons.ProtocolMethodFailed, "", this.publicIdentifier, {
          method: "syncDisputes",
          error: jsonifyError(e),
        }),
      );
    }
  }

  private async runProtocolMethodWithRetries<T = any>(
    fn: () => Promise<Result<T, ProtocolError>>,
    channelAddress: string,
    retryCount = 5,
  ) {
    let result: Result<T> | undefined;
    for (let i = 0; i < retryCount; i++) {
      result = await fn();
      if (!result.isError) {
        return result;
      }
      this.logger.warn({ attempt: i, error: result.getError().message, channelAddress }, "Protocol method failed");
      await delay(500);
    }
    return result as Result<T, ProtocolError>;
  }

  // JSON RPC interface -- this will accept:
  // - "chan_deposit"
  // - "chan_createTransfer"
  // - "chan_resolveTransfer"
  // - etc.
  public async request<T extends ChannelRpcMethod>(
    payload: EngineParams.RpcRequest,
  ): Promise<ChannelRpcMethodsResponsesMap[T]> {
    this.logger.debug({ payload, method: "request" }, "Method called");
    const validate = ajv.compile(EngineParams.RpcRequestSchema);
    const valid = validate(payload);
    if (!valid) {
      this.logger.error({ method: "request", payload, ...(validate.errors ?? {}) });
      throw new RpcError(
        RpcError.reasons.InvalidRpcSchema,
        payload.params?.channelAddress ?? "",
        this.publicIdentifier,
        {
          invalidRpcRequest: payload,
          invalidRpcRequestError: validate.errors?.map((err) => err.message).join(","),
        },
      );
    }

    const methodName = payload.method.replace("chan_", "");
    if (typeof this[methodName] !== "function") {
      throw new RpcError(RpcError.reasons.InvalidMethod, payload.params?.channelAddress ?? "", this.publicIdentifier, {
        payload,
      });
    }

    // every method must be a result type
    const res = await this[methodName](payload.params);
    if (res.isError) {
      throw res.getError();
    }
    return res.getValue();
  }

  ///////////////////////////////////
  // EVENT METHODS

  public on<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): void {
    this.evts[event].pipe(filter).attach(callback);
  }

  public once<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): void {
    this.evts[event].pipe(filter).attachOnce(callback);
  }

  public waitFor<T extends EngineEvent>(
    event: T,
    timeout: number,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): Promise<EngineEventMap[T]> {
    return this.evts[event].pipe(filter).waitFor(timeout);
  }

  public off<T extends EngineEvent>(event?: T): void {
    if (event) {
      this.evts[event].detach();
      return;
    }

    Object.keys(EngineEvents).forEach((k) => this.evts[k].detach());
  }
}
