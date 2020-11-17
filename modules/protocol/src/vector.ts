import { VectorChannel } from "@connext/vector-contracts";
import {
  ChannelUpdate,
  ChannelUpdateEvent,
  FullChannelState,
  FullTransferState,
  IChannelSigner,
  IExternalValidation,
  ILockService,
  IMessagingService,
  IVectorChainReader,
  IVectorProtocol,
  IVectorStore,
  OutboundChannelUpdateError,
  ProtocolEventName,
  ProtocolEventPayloadsMap,
  ProtocolParams,
  Result,
  UpdateParams,
  UpdateType,
} from "@connext/vector-types";
import { getCreate2MultisigAddress, getSignerAddressFromPublicIdentifier } from "@connext/vector-utils";
import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import Ajv from "ajv";
import { Evt } from "evt";
import pino from "pino";

import * as sync from "./sync";
import { getParamsFromUpdate } from "./utils";

type EvtContainer = { [K in keyof ProtocolEventPayloadsMap]: Evt<ProtocolEventPayloadsMap[K]> };

const ajv = new Ajv();

export class Vector implements IVectorProtocol {
  private evts: EvtContainer = {
    [ProtocolEventName.CHANNEL_UPDATE_EVENT]: Evt.create<ChannelUpdateEvent>(),
  };

  // make it private so the only way to create the class is to use `connect`
  private constructor(
    private readonly messagingService: IMessagingService,
    private readonly lockService: ILockService,
    private readonly storeService: IVectorStore,
    private readonly signer: IChannelSigner,
    private readonly chainReader: IVectorChainReader,
    private readonly externalValidationService: IExternalValidation,
    private readonly logger: pino.BaseLogger,
  ) {}

  static async connect(
    messagingService: IMessagingService,
    lockService: ILockService,
    storeService: IVectorStore,
    signer: IChannelSigner,
    chainReader: IVectorChainReader,
    logger: pino.BaseLogger,
    validationService?: IExternalValidation,
  ): Promise<Vector> {
    // Set the external validation service. If none is provided,
    // create an object with a matching interface to perform no
    // additional validation
    const externalValidation = validationService ?? {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      validateOutbound: (params: UpdateParams<any>, state: FullChannelState, transfer?: FullTransferState) =>
        Promise.resolve(Result.ok(undefined)),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      validateInbound: (update: ChannelUpdate<any>, state: FullChannelState, transfer?: FullTransferState) =>
        Promise.resolve(Result.ok(undefined)),
    };

    // Handles up asynchronous services and checks to see that
    // channel is `setup` plus is not in dispute
    const node = await new Vector(
      messagingService,
      lockService,
      storeService,
      signer,
      chainReader,
      externalValidation,
      logger,
    ).setupServices();

    logger.info("Vector Protocol connected 🚀!");
    return node;
  }

  get signerAddress(): string {
    return this.signer.address;
  }

  get publicIdentifier(): string {
    return this.signer.publicIdentifier;
  }

  // separate out this function so that we can atomically return and release the lock
  private async lockedOperation(
    params: UpdateParams<any>,
  ): Promise<Result<FullChannelState, OutboundChannelUpdateError>> {
    // Send the update to counterparty
    const outboundRes = await sync.outbound(
      params,
      this.storeService,
      this.chainReader,
      this.messagingService,
      this.externalValidationService,
      this.signer,
      this.logger,
    );
    if (outboundRes.isError) {
      this.logger.error({
        method: "lockedOperation",
        variable: "outboundRes",
        error: outboundRes.getError()?.message,
        context: outboundRes.getError()?.context,
      });
      return outboundRes as Result<any, OutboundChannelUpdateError>;
    }
    // Post to channel update evt
    const { updatedChannel, updatedTransfers, updatedTransfer } = outboundRes.getValue();
    this.evts[ProtocolEventName.CHANNEL_UPDATE_EVENT].post({
      updatedChannelState: updatedChannel,
      updatedTransfers,
      updatedTransfer,
    });
    return Result.ok(outboundRes.getValue().updatedChannel);
  }

  // Primary protocol execution from the leader side
  private async executeUpdate(
    params: UpdateParams<any>,
  ): Promise<Result<FullChannelState, OutboundChannelUpdateError>> {
    this.logger.debug({
      method: "executeUpdate",
      step: "start",
      params,
    });
    this.logger.info({
      method: "executeUpdate",
      step: "start",
      type: params.type,
      channelAddress: params.channelAddress,
      updateSender: this.publicIdentifier,
    });
    let aliceIdentifier: string;
    let bobIdentifier: string;
    if (params.type === UpdateType.setup) {
      aliceIdentifier = this.publicIdentifier;
      bobIdentifier = (params as UpdateParams<"setup">).details.counterpartyIdentifier;
    } else {
      const channel = await this.storeService.getChannelState(params.channelAddress);
      if (!channel) {
        return Result.fail(new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.ChannelNotFound, params));
      }
      aliceIdentifier = channel.aliceIdentifier;
      bobIdentifier = channel.bobIdentifier;
    }
    const isAlice = this.publicIdentifier === aliceIdentifier;
    const counterpartyIdentifier = isAlice ? bobIdentifier : aliceIdentifier;
    const key = await this.lockService.acquireLock(params.channelAddress, isAlice, counterpartyIdentifier);
    const outboundRes = await this.lockedOperation(params);
    await this.lockService.releaseLock(params.channelAddress, key, isAlice, counterpartyIdentifier);
    return outboundRes;
  }

  private async setupServices(): Promise<Vector> {
    // response to incoming message where we are not the leader
    // steps:
    //  - validate and save state
    //  - send back message or error to specified inbox
    //  - publish updated state event
    await this.messagingService.onReceiveProtocolMessage(this.publicIdentifier, async (msg, from, inbox) => {
      if (from === this.publicIdentifier) {
        return;
      }
      this.logger.info({ method: "onReceiveProtocolMessage" }, "Received message");

      if (msg.isError) {
        this.logger.error(
          { method: "inbound", error: msg.getError()?.message },
          "Error received from counterparty's initial message, this shouldn't happen",
        );
        return;
      }

      const received = msg.getValue();

      if (received.update.fromIdentifier === this.publicIdentifier) {
        this.logger.debug({ method: "onReceiveProtocolMessage" }, "Received update from ourselves, doing nothing");
        return;
      }

      // validate and save
      const inboundRes = await sync.inbound(
        received.update,
        received.previousUpdate,
        inbox,
        this.chainReader,
        this.storeService,
        this.messagingService,
        this.externalValidationService,
        this.signer,
        this.logger,
      );
      if (inboundRes.isError) {
        this.logger.warn({ error: inboundRes.getError()!.message }, "Failed to apply inbound update");
        return;
      }

      const { updatedChannel, updatedActiveTransfers, updatedTransfer } = inboundRes.getValue();

      this.evts[ProtocolEventName.CHANNEL_UPDATE_EVENT].post({
        updatedChannelState: updatedChannel,
        updatedTransfers: updatedActiveTransfers,
        updatedTransfer: updatedTransfer,
      });
    });

    // TODO: https://github.com/connext/vector/issues/54

    // TODO: https://github.com/connext/vector/issues/52

    // TODO: https://github.com/connext/vector/issues/53

    // sync latest state before starting
    const channels = await this.storeService.getChannelStates();

    // Handle disputes
    // First check on current dispute status of all channels onchain
    // Since we have no way of knowing the last time the protocol
    // connected, we must check this on startup
    // TODO: is there a better way to do this?
    await Promise.all(
      channels.map(async channel => {
        const currBlock = await this.chainReader.getBlockNumber(channel.networkContext.chainId);
        const disputeRes = await this.chainReader.getChannelDispute(
          channel.channelAddress,
          channel.networkContext.chainId,
        );
        if (disputeRes.isError) {
          this.logger.error(
            { channelAddress: channel.channelAddress, error: disputeRes.getError()!.message },
            "Could not get dispute",
          );
          return;
        }
        const dispute = disputeRes.getValue();
        if (!dispute) {
          return;
        }
        try {
          // if the dispute has expired, save that the channel is no
          // longer in dispute
          if (BigNumber.from(currBlock).lte(dispute.defundExpiry)) {
            // make store call IFF needed
            if (channel.inDispute) {
              await this.storeService.saveChannelDispute({ ...channel, inDispute: false }, dispute);
            }
            return;
          }
          // otherwise, save dispute record
          await this.storeService.saveChannelDispute({ ...channel, inDispute: true }, dispute);
        } catch (e) {
          this.logger.error(
            { channelAddress: channel.channelAddress, error: e.message },
            "Failed to update dispute on startup",
          );
        }

        // Register listeners to update all disputes while the protocol is
        // online and actively connected
        const contract = new Contract(channel.channelAddress, VectorChannel.abi, this.signer);
        contract.on(contract.filters.ChannelDisputed(), async event => {
          await this.storeService.saveChannelDispute({ ...channel, inDispute: true }, event.dispute);
        });
        // contract.on(contract.filters.ChannelDefunded(), async event => {
        //   await this.storeService.saveChannelDispute({ ...channel, inDispute: false }, event.dispute);
        // });
        contract.on(contract.filters.TransferDisputed(), async event => {
          await this.storeService.saveChannelDispute(
            { ...channel, inDispute: true },
            { ...event.dispute, transferId: event.transferId },
          );
        });
      }),
    );
    await Promise.all(
      channels.map(channel =>
        sync
          .outbound(
            getParamsFromUpdate(channel.latestUpdate, this.signer),
            this.storeService,
            this.chainReader,
            this.messagingService,
            this.externalValidationService,
            this.signer,
            this.logger,
          )
          .then(res => {
            if (res.isError) {
              this.logger.warn(
                { channel: channel.channelAddress, error: res.getError()!.message! },
                "Failed to sync on start",
              );
            }
          }),
      ),
    );
    return this;
  }

  private validateParams(params: any, schema: any): undefined | OutboundChannelUpdateError {
    const validate = ajv.compile(schema);
    const valid = validate(params);
    if (!valid) {
      return new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.InvalidParams, params, undefined, {
        errors: validate.errors?.map(e => e.message).join(),
      });
    }
    return undefined;
  }

  /*
   * ***************************
   * *** CORE PUBLIC METHODS ***
   * ***************************
   */
  // NOTE: The following top-level methods are called by users when
  // they are initiating a channel update. This means that any updates
  // generated using this code path will *not* pass through the validation
  // function. Instead, all validation must be done upfront before
  // calling `this.executeUpdate`. This includes all parameter validation,
  // as well as contextual validation (i.e. do I have sufficient funds to
  // create this transfer, is the channel in dispute, etc.)

  // TODO: https://github.com/connext/vector/issues/53
  public async isAlive(channelAddress: string) {
    // isAlive should ping the channel counterparty with a message that contains nonce and then wait for an ack.
    //         it should return an error (and emit it!) if the ack is not received.
    //         on the sync inbound side, we should properly ack this message and also emit an event when you hear it (on both sides)
  }

  public async setup(params: ProtocolParams.Setup): Promise<Result<FullChannelState, OutboundChannelUpdateError>> {
    // Validate all parameters
    const error = this.validateParams(params, ProtocolParams.SetupSchema);
    if (error) {
      this.logger.error({ method: "setup", params, error });
      return Result.fail(error);
    }

    const create2Res = await getCreate2MultisigAddress(
      this.publicIdentifier,
      params.counterpartyIdentifier,
      params.networkContext.chainId,
      params.networkContext.channelFactoryAddress,
      this.chainReader,
    );
    if (create2Res.isError) {
      return Result.fail(
        new OutboundChannelUpdateError(
          OutboundChannelUpdateError.reasons.Create2Failed,
          { details: params, channelAddress: "", type: UpdateType.setup },
          undefined,
          {
            error: create2Res.getError()!.message,
          },
        ),
      );
    }
    const channelAddress = create2Res.getValue();

    // Convert the API input to proper UpdateParam format
    const updateParams: UpdateParams<"setup"> = {
      channelAddress,
      details: params,
      type: UpdateType.setup,
    };

    return this.executeUpdate(updateParams);
  }

  // Adds a deposit that has *already occurred* onchain into the multisig
  public async deposit(params: ProtocolParams.Deposit): Promise<Result<FullChannelState, OutboundChannelUpdateError>> {
    // Validate all input
    const error = this.validateParams(params, ProtocolParams.DepositSchema);
    if (error) {
      return Result.fail(error);
    }

    // Convert the API input to proper UpdateParam format
    const updateParams: UpdateParams<"deposit"> = {
      channelAddress: params.channelAddress,
      type: UpdateType.deposit,
      details: params,
    };

    return this.executeUpdate(updateParams);
  }

  public async create(params: ProtocolParams.Create): Promise<Result<FullChannelState, OutboundChannelUpdateError>> {
    // Validate all input
    const error = this.validateParams(params, ProtocolParams.CreateSchema);
    if (error) {
      return Result.fail(error);
    }

    // Convert the API input to proper UpdateParam format
    const updateParams: UpdateParams<"create"> = {
      channelAddress: params.channelAddress,
      type: UpdateType.create,
      details: params,
    };

    return this.executeUpdate(updateParams);
  }

  public async resolve(params: ProtocolParams.Resolve): Promise<Result<FullChannelState, OutboundChannelUpdateError>> {
    // Validate all input
    const error = this.validateParams(params, ProtocolParams.ResolveSchema);
    if (error) {
      return Result.fail(error);
    }

    // Convert the API input to proper UpdateParam format
    const updateParams: UpdateParams<"resolve"> = {
      channelAddress: params.channelAddress,
      type: UpdateType.resolve,
      details: params,
    };

    return this.executeUpdate(updateParams);
  }

  ///////////////////////////////////
  // STORE METHODS
  public async getChannelState(channelAddress: string): Promise<FullChannelState | undefined> {
    return this.storeService.getChannelState(channelAddress);
  }

  public async getActiveTransfers(channelAddress: string): Promise<FullTransferState[]> {
    return this.storeService.getActiveTransfers(channelAddress);
  }

  public async getChannelStateByParticipants(
    alice: string,
    bob: string,
    chainId: number,
  ): Promise<FullChannelState | undefined> {
    return this.storeService.getChannelStateByParticipants(
      getSignerAddressFromPublicIdentifier(alice),
      getSignerAddressFromPublicIdentifier(bob),
      chainId,
    );
  }

  public async getTransferState(transferId: string): Promise<FullTransferState | undefined> {
    return this.storeService.getTransferState(transferId);
  }

  public async getChannelStates(): Promise<FullChannelState[]> {
    return this.storeService.getChannelStates();
  }

  ///////////////////////////////////
  // EVENT METHODS

  public on<T extends ProtocolEventName>(
    event: T,
    callback: (payload: ProtocolEventPayloadsMap[T]) => void | Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    filter: (payload: ProtocolEventPayloadsMap[T]) => boolean = (_payload: ProtocolEventPayloadsMap[T]) => true,
  ): void {
    this.evts[event].pipe(filter).attach(callback);
  }

  public once<T extends ProtocolEventName>(
    event: T,
    callback: (payload: ProtocolEventPayloadsMap[T]) => void | Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    filter: (payload: ProtocolEventPayloadsMap[T]) => boolean = (_payload: ProtocolEventPayloadsMap[T]) => true,
  ): void {
    this.evts[event].pipe(filter).attachOnce(callback);
  }

  public waitFor<T extends ProtocolEventName>(
    event: T,
    timeout: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    filter: (payload: ProtocolEventPayloadsMap[T]) => boolean = (_payload: ProtocolEventPayloadsMap[T]) => true,
  ): Promise<ProtocolEventPayloadsMap[T]> {
    return this.evts[event].pipe(filter).waitFor(timeout);
  }

  public async off<T extends ProtocolEventName>(event?: T): Promise<void> {
    if (event) {
      this.evts[event].detach();
      return;
    }

    Object.values(this.evts).forEach(evt => evt.detach());
    await this.messagingService.disconnect();
  }
}
