import { HexString, SignatureString, Address, Bytes32 } from "../basic";
import { tidy } from "../utils";

export const CrosschainTransferName = "CrosschainTransfer";

export type CrosschainTransferState = {
  initiatorSignature: SignatureString;
  initiator: Address;
  responder: Address;
  data: Bytes32;
  nonce: string;
  fee: string;
  callTo: Address;
  callData: string;
  lockHash: HexString;
};

export type CrosschainTransferResolver = {
  responderSignature: SignatureString;
  preImage: HexString;
};

export const CrosschainTransferStateEncoding = tidy(`tuple(
  bytes initiatorSignature,
  address initiator,
  address responder,
  bytes32 data,
  uint256 nonce,
  uint256 fee,
  address callTo,
  bytes callData,
  bytes32 lockHash
)`);

export const CrosschainTransferResolverEncoding = tidy(`tuple(
  bytes responderSignature,
  bytes32 preImage
)`);
