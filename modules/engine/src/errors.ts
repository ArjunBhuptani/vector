import { EngineError, EngineParams, Values } from "@connext/vector-types";

export class DisputeError extends EngineError {
  static readonly type = "DisputeError";

  static readonly reasons = {
    ChannelDefundTxFailed: "Failed to send defund channel tx",
    ChannelDisputeTxFailed: "Failed to send dispute channel tx",
    ChannelNotInDispute: "Channel is not in dispute",
    ChannelNotFound: "Channel not found",
    CouldNotGetActiveTransfers: "Failed to retrieve active transfers from store",
    CouldNotGetChannel: "Failed to retrieve channel from store",
    CouldNotGetTransfer: "Failed to retrieve transfer from store",
    TransferNotFound: "Transfer not found",
    TransferNotDisputed: "Transfer not in dispute",
    TransferDefundTxFailed: "Failed to send defund transfer tx",
    TransferDisputeTxFailed: "Failed to send dispute transfer tx",
    Unknown: "Unknown dispute error",
  } as const;

  constructor(
    public readonly message: Values<typeof DisputeError.reasons>,
    channelAddress: string,
    publicIdentifier: string,
    context: any = {},
  ) {
    super(message, channelAddress, publicIdentifier, context, DisputeError.type);
  }
}

export class CheckInError extends EngineError {
  static readonly type = "CheckInError";

  static readonly reasons = {
    ChannelNotFound: "Channel not found",
    Unknown: "Unknown check-in error",
  } as const;

  constructor(
    public readonly message: Values<typeof CheckInError.reasons>,
    channelAddress: string,
    publicIdentifier: string,
    context: any = {},
  ) {
    super(message, channelAddress, publicIdentifier, context, CheckInError.type);
  }
}

export class RestoreError extends EngineError {
  static readonly type = "RestoreError";

  static readonly reasons = {
    AckFailed: "Could not send restore ack",
    AcquireLockError: "Failed to acquire restore lock",
    ChannelNotFound: "Channel not found",
    CouldNotGetActiveTransfers: "Failed to retrieve active transfers from store",
    CouldNotGetChannel: "Failed to retrieve channel from store",
    GetChannelAddressFailed: "Failed to calculate channel address for verification",
    InvalidChannelAddress: "Failed to verify channel address",
    InvalidMerkleRoot: "Failed to validate merkleRoot for restoration",
    InvalidSignatures: "Failed to validate sigs on latestUpdate",
    NoData: "No data sent from counterparty to restore",
    ReceivedError: "Got restore error from counterparty",
    ReleaseLockError: "Failed to release restore lock",
    SaveChannelFailed: "Failed to save channel state",
    SyncableState: "Cannot restore, state is syncable. Try reconcileDeposit",
  } as const;

  constructor(
    public readonly message: Values<typeof RestoreError.reasons>,
    channelAddress: string,
    publicIdentifier: string,
    context: any = {},
  ) {
    super(message, channelAddress, publicIdentifier, context, RestoreError.type);
  }
}

export class IsAliveError extends EngineError {
  static readonly type = "IsAliveError";

  static readonly reasons = {
    ChannelNotFound: "Channel not found",
    Unknown: "Unknown isAlive error",
  } as const;

  constructor(
    public readonly message: Values<typeof IsAliveError.reasons>,
    channelAddress: string,
    publicIdentifier: string,
    context: any = {},
  ) {
    super(message, channelAddress, publicIdentifier, context, IsAliveError.type);
  }
}

export class ParameterConversionError extends EngineError {
  static readonly type = "ParameterConversionError";

  static readonly reasons = {
    BobDoesntSubmitAlice: "Bob cannot submit Alice's withdrawals",
    CannotSendToSelf: "An initiator cannot be a receiver on the same chain",
    CouldNotGetQuote: "Failed to get quote",
    CouldNotSignWithdrawal: "Failed to sign withdrawal commitment",
    FailedToGetRegisteredTransfer: "Could not get transfer registry information",
    FeeGreaterThanAmount: "Fees charged are greater than amount",
    NoOp: "Cannot create withdrawal with 0 amount and no call",
    WithdrawToZero: "Cannot withdraw to AddressZero",
    ChannelNotFound: "Channel not found",
    TransferNotFound: "Transfer not found",
  } as const;

  constructor(
    public readonly message: Values<typeof ParameterConversionError.reasons>,
    channelAddress: string,
    publicIdentifier: string,
    context: any = {},
  ) {
    super(message, channelAddress, publicIdentifier, context, ParameterConversionError.type);
  }
}

export class RpcError extends EngineError {
  static readonly type = "RpcError";

  static readonly reasons = {
    ChainServiceFailure: "Failed to execute chain service method",
    ChannelNotFound: "Channel not found",
    DecryptFailed: "Failed to decrypt",
    EngineMethodFailure: "Failed to execute engine method",
    InvalidParams: "Parameters from rpc request are malformed",
    InvalidRpcSchema: "Rpc request is malformed",
    InvalidMethod: "Rpc method is invalid",
    ParamConversionFailed: "Failed to convert engine ",
    ProtocolMethodFailed: "Failed to execute protocol method",
    SignerNotInChannel: "Signer is not in channel",
    StoreMethodFailed: "Failed to execute store method",
    TransferNotFound: "Transfer not found",
    SigningFailed: "Failed to sign message",
    UtilitySigningFailed: "Failed to sign utility message",
    WithdrawResolutionFailed: "Withdrawal commitment not found post-create",
    TransactionFound: "Withdrawal transaction found",
    CommitmentSingleSigned: "Withdrawal commitment single-signed",
  } as const;

  constructor(
    public readonly message: Values<typeof RpcError.reasons>,
    channelAddress: string,
    publicIdentifier: string,
    context: any = {},
  ) {
    super(message, channelAddress, publicIdentifier, context, RpcError.type);
  }
}

export class WithdrawQuoteError extends EngineError {
  static readonly type = "WithdrawQuoteError";

  static readonly reasons = {
    ChannelNotFound: "Channel not found",
    ChainServiceFailure: "Chain service method failed",
    ExchangeRateError: "Calculating exchange failed",
    SignatureFailure: "Signing quote failed",
  } as const;

  constructor(
    public readonly message: Values<typeof WithdrawQuoteError.reasons>,
    publicIdentifier: string,
    request: EngineParams.GetWithdrawalQuote,
    context: any = {},
  ) {
    super(message, request.channelAddress, publicIdentifier, context, WithdrawQuoteError.type);
  }
}
