import {
  TransferState,
  CoreTransferState,
  Address,
  TransferResolver,
  Balance,
  TransferQuote,
  TransferQuoteEncoding,
  WithdrawalQuote,
  WithdrawalQuoteEncoding,
  FullTransferState,
} from "@connext/vector-types";
import { defaultAbiCoder } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { keccak256 as solidityKeccak256, sha256 as soliditySha256 } from "@ethersproject/solidity";
import { keccak256 } from "ethereumjs-util";
import { bufferify } from "./crypto";

export const getTransferId = (
  channelAddress: Address,
  channelNonce: string,
  transferDefinition: Address,
  transferTimeout: string,
): string =>
  solidityKeccak256(
    ["address", "address", "uint256", "uint256"],
    [transferDefinition, channelAddress, transferTimeout, channelNonce],
  );

export const encodeTransferState = (state: TransferState, encoding: string): string =>
  defaultAbiCoder.encode([encoding], [state]);

export const decodeTransferState = <T extends TransferState = any>(encoded: string, encoding: string): T =>
  defaultAbiCoder.decode([encoding], encoded)[0];

export const encodeBalance = (balance: Balance): string => {
  return "0x".concat(
    BigNumber.from(balance.amount[0]).toHexString().slice(2).padStart(64, "0"),
    BigNumber.from(balance.amount[1]).toHexString().slice(2).padStart(64, "0"),
    "000000000000000000000000",
    balance.to[0].slice(2),
    "000000000000000000000000",
    balance.to[1].slice(2),
  );
};

export const decodeTransferResolver = <T extends TransferResolver = any>(encoded: string, encoding: string): T =>
  defaultAbiCoder.decode([encoding], encoded)[0];

export const encodeTransferResolver = (resolver: TransferResolver, encoding: string): string =>
  defaultAbiCoder.encode([encoding], [resolver]);

export const encodeCoreTransferState = (state: CoreTransferState): string => {
  return "0x".concat(
    "000000000000000000000000",
    state.channelAddress.slice(2),
    state.transferId.slice(2),
    "000000000000000000000000",
    state.transferDefinition.slice(2),
    "000000000000000000000000",
    state.initiator.slice(2),
    "000000000000000000000000",
    state.responder.slice(2),
    "000000000000000000000000",
    state.assetId.slice(2),
    encodeBalance(state.balance).slice(2),
    BigNumber.from(state.transferTimeout).toHexString().slice(2).padStart(64, "0"),
    state.initialStateHash.slice(2),
  );
};

export const hashTransferState = (state: TransferState, encoding: string): string =>
  solidityKeccak256(["bytes"], [encodeTransferState(state, encoding)]);

// export const hashCoreTransferState = (state: CoreTransferState): string =>
//   solidityKeccak256(["bytes"], [encodeCoreTransferState(state)]);

export const hashCoreTransferState = (state: CoreTransferState): Buffer =>
  keccak256(bufferify(encodeCoreTransferState(state)));

export const createlockHash = (preImage: string): string => soliditySha256(["bytes32"], [preImage]);

export const encodeTransferQuote = (quote: TransferQuote): string =>
  defaultAbiCoder.encode([TransferQuoteEncoding], [quote]);

export const decodeTransferQuote = (encodedQuote: string): TransferQuote => {
  const decoded = defaultAbiCoder.decode([TransferQuoteEncoding], encodedQuote)[0];
  return {
    routerIdentifier: decoded.routerIdentifier,
    amount: decoded.amount.toString(),
    assetId: decoded.assetId,
    chainId: decoded.chainId.toNumber(),
    recipient: decoded.recipient,
    recipientChainId: decoded.recipientChainId.toNumber(),
    recipientAssetId: decoded.recipientAssetId,
    fee: decoded.fee.toString(),
    expiry: decoded.expiry.toString(),
  };
};

export const hashTransferQuote = (quote: TransferQuote): string =>
  solidityKeccak256(["bytes"], [encodeTransferQuote(quote)]);

export const encodeWithdrawalQuote = (quote: WithdrawalQuote): string =>
  defaultAbiCoder.encode([WithdrawalQuoteEncoding], [quote]);

export const decodeWithdrawalQuote = (encodedQuote: string): WithdrawalQuote => {
  const decoded = defaultAbiCoder.decode([WithdrawalQuoteEncoding], encodedQuote)[0];
  return {
    channelAddress: decoded.channelAddress,
    amount: decoded.amount.toString(),
    assetId: decoded.assetId,
    fee: decoded.fee.toString(),
    expiry: decoded.expiry.toString(),
  };
};

export const hashWithdrawalQuote = (quote: WithdrawalQuote): string =>
  solidityKeccak256(["bytes"], [encodeWithdrawalQuote(quote)]);

export const getTransferParticipant = (
  transfer: FullTransferState,
  publicIdentifier: string,
): "initiator" | "responder" | undefined => {
  const isInitiator = transfer.initiatorIdentifier.toLowerCase() === publicIdentifier.toLowerCase();
  if (!isInitiator && transfer.responderIdentifier.toLowerCase() !== publicIdentifier.toLowerCase()) {
    return undefined;
  }
  return isInitiator ? "initiator" : "responder";
};

export const getTransferBalance = (transfer: FullTransferState, role: "initiator" | "responder") => {
  return transfer.balance.amount[role === "initiator" ? 0 : 1];
};
