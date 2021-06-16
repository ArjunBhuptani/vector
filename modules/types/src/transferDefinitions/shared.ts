import { NodeResponses } from "../schemas";
import { Address } from "../basic";
import { Values } from "../error";
import { tidy } from "../utils";

import {
  HashlockTransferName,
  HashlockTransferResolver,
  HashlockTransferResolverEncoding,
  HashlockTransferState,
  HashlockTransferStateEncoding,
} from "./hashlockTransfer";
import {
  WithdrawName,
  WithdrawResolver,
  WithdrawResolverEncoding,
  WithdrawState,
  WithdrawStateEncoding,
} from "./withdraw";
import { CrosschainTransferName, CrosschainTransferResolver, CrosschainTransferState } from "./crosschain";

// Must be updated when adding a new transfer
export const TransferNames = {
  [HashlockTransferName]: HashlockTransferName,
  [WithdrawName]: WithdrawName,
  [CrosschainTransferName]: CrosschainTransferName,
} as const;

// Must be updated when adding a new transfer
export interface TransferResolverMap {
  [HashlockTransferName]: HashlockTransferResolver;
  [WithdrawName]: WithdrawResolver;
  [CrosschainTransferName]: CrosschainTransferResolver;
}

// Must be updated when adding a new transfer
export interface TransferStateMap {
  [HashlockTransferName]: HashlockTransferState;
  [WithdrawName]: WithdrawState;
  [CrosschainTransferName]: CrosschainTransferState;
}

// Must be updated when adding a new transfer
export const TransferEncodingsMap = {
  [HashlockTransferName]: [HashlockTransferStateEncoding, HashlockTransferResolverEncoding],
  [WithdrawName]: [WithdrawStateEncoding, WithdrawResolverEncoding],
} as const;

export type TransferName = keyof typeof TransferNames | string;
export type TransferState = Values<TransferStateMap> | any;
export type TransferResolver = Values<TransferResolverMap> | any;
export type TransferEncodings = Values<typeof TransferEncodingsMap> | [string, string];

export type RegisteredTransfer = {
  stateEncoding: string;
  resolverEncoding: string;
  definition: Address;
  name: string;
  encodedCancel: string;
};

export const TransferQuoteEncoding = tidy(`tuple(
  string routerIdentifier,
  uint256 amount,
  address assetId,
  uint256 chainId,
  string recipient,
  uint256 recipientChainId,
  address recipientAssetId,
  uint256 fee,
  uint256 expiry
)`);
