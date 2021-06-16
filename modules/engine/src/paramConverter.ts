import { WithdrawCommitment } from "@connext/vector-contracts";
import {
  getRandomBytes32,
  getSignerAddressFromPublicIdentifier,
  recoverAddressFromChannelMessage,
} from "@connext/vector-utils";
import {
  CreateTransferParams,
  ResolveTransferParams,
  FullChannelState,
  Result,
  DEFAULT_TRANSFER_TIMEOUT,
  DEFAULT_CHANNEL_TIMEOUT,
  FullTransferState,
  WithdrawState,
  EngineParams,
  IChannelSigner,
  ChainAddresses,
  RouterSchemas,
  TransferNames,
  TransferName,
  IVectorChainReader,
  EngineError,
  jsonifyError,
  IMessagingService,
  DEFAULT_FEE_EXPIRY,
  SetupParams,
  IVectorChainService,
  IEngineStore,
} from "@connext/vector-types";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero } from "@ethersproject/constants";
import { getAddress } from "@ethersproject/address";

import { ParameterConversionError } from "./errors";
import { isCrosschainTransfer } from "./listeners";

export async function convertSetupParams(
  params: EngineParams.Setup,
  chainAddresses: ChainAddresses,
): Promise<Result<SetupParams>> {
  return Result.ok({
    counterpartyIdentifier: params.counterpartyIdentifier,
    timeout: params.timeout ?? DEFAULT_CHANNEL_TIMEOUT.toString(),
    networkContext: {
      channelFactoryAddress: chainAddresses[params.chainId].channelFactoryAddress,
      transferRegistryAddress: chainAddresses[params.chainId].transferRegistryAddress,
      chainId: params.chainId,
    },
    meta: params.meta,
  });
}

export async function convertConditionalTransferParams(
  params: EngineParams.ConditionalTransfer,
  signer: IChannelSigner,
  channel: FullChannelState,
  chainReader: IVectorChainReader,
  messaging: IMessagingService,
): Promise<Result<CreateTransferParams, EngineError>> {
  const { channelAddress, amount, assetId, recipient, details, type, timeout, meta: providedMeta } = params;

  const recipientChainId = params.recipientChainId ?? channel.networkContext.chainId;
  const recipientAssetId = getAddress(params.recipientAssetId ?? params.assetId);
  const channelCounterparty = signer.address === channel.alice ? channel.bob : channel.alice;

  if (recipient === signer.publicIdentifier && recipientChainId === channel.networkContext.chainId) {
    // If signer is also the receipient on same chain/network
    return Result.fail(
      new ParameterConversionError(
        ParameterConversionError.reasons.CannotSendToSelf,
        channelAddress,
        signer.publicIdentifier,
        {
          params,
        },
      ),
    );
  }

  // If the recipient is the channel counterparty, no default routing
  // meta needs to be created, otherwise create the default routing meta.
  // NOTE: While the engine and protocol do not care about the structure
  // of the meta, this is where several relevant default values are
  // set for the higher level modules to parse
  let baseRoutingMeta: RouterSchemas.RouterMeta | undefined = undefined;
  if (recipient && getSignerAddressFromPublicIdentifier(recipient) !== channelCounterparty) {
    // Get a quote if it is not provided
    // NOTE: this explicitly assumes that the channel.alice is the
    // router identifier.
    let quote = params.quote;
    if (!quote) {
      const quoteRes =
        signer.publicIdentifier !== channel.aliceIdentifier
          ? await messaging.sendTransferQuoteMessage(
              Result.ok({
                amount: params.amount,
                assetId: params.assetId,
                chainId: channel.networkContext.chainId,
                recipient,
                recipientChainId,
                recipientAssetId,
              }),
              channel.aliceIdentifier,
              signer.publicIdentifier,
            )
          : Result.ok({
              signature: undefined,
              chainId: channel.networkContext.chainId,
              routerIdentifier: signer.publicIdentifier,
              amount: params.amount,
              assetId: params.assetId,
              recipient,
              recipientChainId,
              recipientAssetId,
              fee: "0",
              expiry: (Date.now() + DEFAULT_FEE_EXPIRY).toString(),
            });
      if (quoteRes.isError) {
        return Result.fail(
          new ParameterConversionError(
            ParameterConversionError.reasons.CouldNotGetQuote,
            channelAddress,
            signer.publicIdentifier,
            { params, quoteError: jsonifyError(quoteRes.getError()!) },
          ),
        );
      }
      quote = quoteRes.getValue();
    }
    const fee = BigNumber.from(quote.fee);
    if (fee.gt(params.amount)) {
      return Result.fail(
        new ParameterConversionError(
          ParameterConversionError.reasons.FeeGreaterThanAmount,
          channelAddress,
          signer.publicIdentifier,
          { quote },
        ),
      );
    }
    const requireOnline = providedMeta?.requireOnline ?? true; // true by default
    baseRoutingMeta = {
      requireOnline,
      routingId: providedMeta?.routingId ?? getRandomBytes32(),
      path: [{ recipient, recipientChainId, recipientAssetId }],
      quote: {
        ...quote, // use our own values by default
        routerIdentifier: channel.aliceIdentifier,
        amount: params.amount,
        assetId: params.assetId,
        chainId: channel.networkContext.chainId,
        recipient,
        recipientChainId,
        recipientAssetId,
      },
    };
  }

  // TODO: transfers should be allowed to go to participants outside of the
  // channel (i.e. some dispute recovery address). This should be passed in
  // via the transfer params as a `recoveryAddress` variable
  // const transferStateRecipient = recipient ? getSignerAddressFromPublicIdentifier(recipient) : channelCounterparty; #437

  // Get the transfer information from the chain reader
  const registryRes = !type.startsWith(`0x`)
    ? await chainReader.getRegisteredTransferByName(
        type as TransferName,
        channel.networkContext.transferRegistryAddress,
        channel.networkContext.chainId,
      )
    : await chainReader.getRegisteredTransferByDefinition(
        type,
        channel.networkContext.transferRegistryAddress,
        channel.networkContext.chainId,
      );
  if (registryRes.isError) {
    return Result.fail(
      new ParameterConversionError(
        ParameterConversionError.reasons.FailedToGetRegisteredTransfer,
        channelAddress,
        signer.publicIdentifier,
        { params, registryError: jsonifyError(registryRes.getError()!) },
      ),
    );
  }
  const { definition } = registryRes.getValue()!;

  // Construct initial state
  const transferInitialState = {
    ...details,
  };

  return Result.ok({
    channelAddress,
    balance: { to: [signer.address, channelCounterparty], amount: [amount.toString(), "0"] },
    assetId,
    transferDefinition: definition,
    transferInitialState,
    timeout: timeout ?? DEFAULT_TRANSFER_TIMEOUT.toString(),
    meta: {
      ...(baseRoutingMeta ?? {}),
      ...(providedMeta ?? {}),
    },
  });
}

export async function convertResolveConditionParams(
  params: EngineParams.ResolveTransfer,
  transfer: FullTransferState,
  signer: IChannelSigner,
  chainAddresses: ChainAddresses,
  chainService: IVectorChainReader,
  store: IEngineStore,
): Promise<Result<ResolveTransferParams, EngineError>> {
  const { channelAddress, transferResolver, meta } = params;

  // special case for crosschain transfer
  // we need to generate a separate sig for withdrawal commitment since the transfer resolver may have gotten forwarded
  // and needs to be regenerated for this leg of the transfer
  const isCrossChain = await isCrosschainTransfer(transfer, chainAddresses, chainService);
  if (isCrossChain.getValue()) {
    // first check if the provided sig is valid. in the case of the receiver directly resolving the withdrawal, it will
    // be valid already
    let channel: FullChannelState | undefined;
    try {
      channel = await store.getChannelState(transfer.channelAddress);
    } catch (e) {
      return Result.fail(
        new ParameterConversionError(
          ParameterConversionError.reasons.ChannelNotFound,
          transfer.channelAddress,
          signer.publicIdentifier,
          {
            getChannelStateError: jsonifyError(e),
          },
        ),
      );
    }
    if (!channel) {
      return Result.fail(
        new ParameterConversionError(
          ParameterConversionError.reasons.ChannelNotFound,
          transfer.channelAddress,
          signer.publicIdentifier,
        ),
      );
    }
    const {
      transferState: { nonce, initiatorSignature, fee, callTo, callData },
      balance,
    } = transfer;
    const withdrawalAmount = balance.amount.reduce((prev, curr) => prev.add(curr), BigNumber.from(0)).sub(fee);
    const commitment = new WithdrawCommitment(
      channel.channelAddress,
      channel.alice,
      channel.bob,
      signer.address,
      transfer.assetId,
      withdrawalAmount.toString(),
      nonce,
      callTo,
      callData,
    );
    let recovered: string;
    try {
      recovered = await recoverAddressFromChannelMessage(commitment.hashToSign(), transferResolver.responderSignature);
    } catch (e) {
      recovered = e.message;
    }

    // if it is not valid, regenerate the sig, otherwise use the provided one
    if (recovered !== channel.alice && recovered !== channel.bob) {
      // Generate your signature on the withdrawal commitment
      transferResolver.responderSignature = await signer.signMessage(commitment.hashToSign());
    }
    await commitment.addSignatures(initiatorSignature, transferResolver.responderSignature);
    // Store the double signed commitment
    await store.saveWithdrawalCommitment(transfer.transferId, commitment.toJson());
  }

  return Result.ok({
    channelAddress,
    transferId: transfer.transferId,
    transferResolver,
    meta: { ...(transfer.meta ?? {}), ...(meta ?? {}) },
  });
}

export async function convertWithdrawParams(
  params: EngineParams.Withdraw,
  signer: IChannelSigner,
  channel: FullChannelState,
  chainAddresses: ChainAddresses,
  chainReader: IVectorChainReader,
  _messaging: IMessagingService,
): Promise<Result<CreateTransferParams, EngineError>> {
  const { channelAddress, callTo, callData, meta, timeout } = params;
  const assetId = getAddress(params.assetId);
  const recipient = getAddress(params.recipient);
  const initiatorSubmits = params.initiatorSubmits ?? false;

  // TODO: refactor to always determine who submits based on the
  // `initiatorSubmits` flag. #428
  if (initiatorSubmits && signer.address === channel.alice) {
    return Result.fail(
      new ParameterConversionError(
        ParameterConversionError.reasons.BobDoesntSubmitAlice,
        channelAddress,
        signer.publicIdentifier,
        { params },
      ),
    );
  }

  // If recipient is AddressZero, throw
  if (recipient === AddressZero) {
    return Result.fail(
      new ParameterConversionError(
        ParameterConversionError.reasons.WithdrawToZero,
        channelAddress,
        signer.publicIdentifier,
        { params },
      ),
    );
  }

  // If it is a no-op, throw
  const noCall = !callTo || callTo === AddressZero;
  if (params.amount === "0" && noCall) {
    return Result.fail(
      new ParameterConversionError(ParameterConversionError.reasons.NoOp, channelAddress, signer.publicIdentifier, {
        params,
      }),
    );
  }

  // No more withdrawal quotes: https://github.com/connext/vector/issues/529
  const quote = {
    // use hardcoded values
    channelAddress: channel.channelAddress,
    amount: params.amount,
    assetId: params.assetId,
    fee: "0",
    expiry: (Date.now() + DEFAULT_FEE_EXPIRY).toString(),
  };

  const commitment = new WithdrawCommitment(
    channel.channelAddress,
    channel.alice,
    channel.bob,
    params.recipient,
    assetId,
    params.amount,
    // Use channel nonce as a way to keep withdraw hashes unique
    channel.nonce.toString(),
    callTo,
    callData,
  );

  let initiatorSignature: string;
  try {
    initiatorSignature = await signer.signMessage(commitment.hashToSign());
  } catch (err) {
    return Result.fail(
      new ParameterConversionError(
        ParameterConversionError.reasons.CouldNotSignWithdrawal,
        channelAddress,
        signer.publicIdentifier,
        {
          signatureError: err.message,
          params,
          commitment: commitment.toJson(),
        },
      ),
    );
  }

  const channelCounterparty = channel.alice === signer.address ? channel.bob : channel.alice;

  const transferInitialState: WithdrawState = {
    initiatorSignature,
    initiator: signer.address,
    responder: channelCounterparty,
    data: commitment.hashToSign(),
    nonce: channel.nonce.toString(),
    fee: "0",
    callTo: callTo ?? AddressZero,
    callData: callData ?? "0x",
  };

  // Get the transfer information from the chain reader
  const registryRes = await chainReader.getRegisteredTransferByName(
    TransferNames.Withdraw,
    chainAddresses[channel.networkContext.chainId].transferRegistryAddress,
    channel.networkContext.chainId,
  );
  if (registryRes.isError) {
    return Result.fail(
      new ParameterConversionError(
        ParameterConversionError.reasons.FailedToGetRegisteredTransfer,
        channelAddress,
        signer.publicIdentifier,
        { params, registryError: jsonifyError(registryRes.getError()!) },
      ),
    );
  }
  const { definition } = registryRes.getValue()!;

  return Result.ok({
    channelAddress,
    balance: {
      amount: [params.amount, "0"],
      to: [recipient, channelCounterparty],
    },
    assetId,
    transferDefinition: definition,
    transferInitialState,
    timeout: timeout ?? DEFAULT_TRANSFER_TIMEOUT.toString(),
    // Note: we MUST include withdrawNonce in meta. The counterparty will NOT have the same nonce on their end otherwise.
    meta: {
      ...(meta ?? {}),
      quote: {
        ...quote, // use our own values by default
        channelAddress,
        amount: params.amount,
        assetId: params.assetId,
      },
      withdrawNonce: channel.nonce.toString(),
      initiatorSubmits,
    },
  });
}
