import {
  TransferState,
  CoreTransferState,
  DEFAULT_TRANSFER_TIMEOUT,
  FullTransferState,
  HashlockTransferState,
  HashlockTransferStateEncoding,
  HashlockTransferResolverEncoding,
  FullChannelState,
  CrosschainTransferResolverEncoding,
  CrosschainTransferState,
  CrosschainTransferStateEncoding,
} from "@connext/vector-types";
import { sha256 as soliditySha256 } from "@ethersproject/solidity";

import { getRandomBytes32 } from "../hexStrings";
import { hashTransferState } from "../transfers";

import { mkAddress, mkHash, mkBytes32, mkPublicIdentifier, mkSig } from "./util";

export const createTestHashlockTransferState = (overrides: Partial<HashlockTransferState> = {}): TransferState => {
  return {
    lockHash: mkHash("0xeee"),
    expiry: "0",
    ...overrides,
  };
};

export const createTestHashlockTransferStates = (
  count = 2,
  overrides: Partial<HashlockTransferState>[] = [],
): TransferState[] => {
  return Array(count)
    .fill(0)
    .map((val, idx) => {
      return createTestHashlockTransferState({ ...(overrides[idx] ?? {}) });
    });
};

export const createCoreTransferState = (overrides: Partial<CoreTransferState> = {}): CoreTransferState => {
  return {
    balance: { to: [mkAddress("0xaa"), mkAddress("0xbbb")], amount: ["1", "0"] },
    assetId: mkAddress(),
    channelAddress: mkAddress("0xccc"),
    transferId: mkBytes32("0xeeefff"),
    transferDefinition: mkAddress("0xdef"),
    initialStateHash: mkBytes32("0xabcdef"),
    transferTimeout: "1",
    initiator: mkAddress("0xaa"),
    responder: mkAddress("0xbbb"),
    ...overrides,
  };
};

export type TestHashlockTransferOptions = {
  assetId: string;
  preImage: string;
  expiry: string;
  meta: any;
  channelFactoryAddress: string;
  chainId: number;
  transferEncodings: string[];
  transferResolver: any;
  transferTimeout: string;
  transferState: any;
  initiatorIdentifier: string;
  responderIdentifier: string;
} & CoreTransferState;

export function createTestFullHashlockTransferState(
  overrides: Partial<TestHashlockTransferOptions> = {},
  channel?: FullChannelState,
): FullTransferState {
  // get overrides/defaults values
  const { assetId, preImage, expiry, meta, ...core } = overrides;

  // Taken from onchain defs
  const transferEncodings = [HashlockTransferStateEncoding, HashlockTransferResolverEncoding];
  const transferResolver = { preImage: preImage ?? getRandomBytes32() };
  const transferState = createTestHashlockTransferState({
    lockHash: soliditySha256(["bytes32"], [transferResolver.preImage]),
    expiry: expiry ?? "0",
  });

  // get default values
  const defaults = {
    assetId: assetId ?? mkAddress(),
    chainId: 2,
    channelAddress: mkAddress("0xccc"),
    channelFactoryAddress: mkAddress("0xaaaaddddffff"),
    balance: overrides.balance ?? { to: [mkAddress("0x111"), mkAddress("0x222")], amount: ["13", "0"] },
    initialStateHash: hashTransferState(transferState, transferEncodings[0]),
    meta: meta ?? { super: "cool stuff", routingId: mkHash("0xaabb") },
    transferDefinition: mkAddress("0xdef"),
    transferEncodings,
    transferId: getRandomBytes32(),
    transferResolver,
    transferState,
    transferTimeout: DEFAULT_TRANSFER_TIMEOUT.toString(),
    initiator: overrides.balance?.to[0] ?? mkAddress("0x111"),
    responder: overrides.balance?.to[1] ?? mkAddress("0x222"),
    inDispute: false,
    initiatorIdentifier: overrides.initiatorIdentifier ?? channel?.aliceIdentifier ?? mkPublicIdentifier("vector111"),
    responderIdentifier: overrides.responderIdentifier ?? channel?.bobIdentifier ?? mkPublicIdentifier("vector222"),
    channelNonce: channel?.nonce ?? 9,
  };

  const channelOverrides = channel
    ? {
        inDispute: channel.inDispute,
        aliceIdentifier: defaults.initiatorIdentifier,
        bobIdentifier: defaults.responderIdentifier,
        ...channel.networkContext,
        ...channel.latestUpdate,
      }
    : {};

  return {
    ...defaults,
    ...core,
    ...channelOverrides,
  };
}

export const createTestCrosschainTransferState = (
  overrides: Partial<CrosschainTransferState> = {},
): CrosschainTransferState => {
  return {
    callData: mkHash(),
    callTo: mkAddress(),
    data: mkBytes32(),
    fee: "0",
    initiator: mkAddress("0xA"),
    responder: mkAddress("0xB"),
    initiatorSignature: mkSig(),
    lockHash: mkBytes32("0xaaa"),
    nonce: "1",
    ...overrides,
  };
};

export function createTestFullCrosschainTransferState(
  overrides: Partial<TestHashlockTransferOptions> = {},
  channel?: FullChannelState,
): FullTransferState {
  // get overrides/defaults values
  const { assetId, preImage, expiry, meta, ...core } = overrides;

  // Taken from onchain defs
  const transferEncodings = [CrosschainTransferStateEncoding, CrosschainTransferResolverEncoding];
  const transferResolver = { preImage: preImage ?? getRandomBytes32() };
  const transferState = createTestCrosschainTransferState({
    lockHash: soliditySha256(["bytes32"], [transferResolver.preImage]),
  });

  // get default values
  const defaults = {
    assetId: assetId ?? mkAddress(),
    chainId: 2,
    channelAddress: mkAddress("0xccc"),
    channelFactoryAddress: mkAddress("0xaaaaddddffff"),
    balance: overrides.balance ?? { to: [mkAddress("0x111"), mkAddress("0x222")], amount: ["13", "0"] },
    initialStateHash: hashTransferState(transferState, transferEncodings[0]),
    meta: meta ?? { super: "cool stuff", routingId: mkHash("0xaabb") },
    transferDefinition: mkAddress("0xdef"),
    transferEncodings,
    transferId: getRandomBytes32(),
    transferResolver,
    transferState,
    transferTimeout: DEFAULT_TRANSFER_TIMEOUT.toString(),
    initiator: overrides.balance?.to[0] ?? mkAddress("0x111"),
    responder: overrides.balance?.to[1] ?? mkAddress("0x222"),
    inDispute: false,
    initiatorIdentifier: overrides.initiatorIdentifier ?? channel?.aliceIdentifier ?? mkPublicIdentifier("vector111"),
    responderIdentifier: overrides.responderIdentifier ?? channel?.bobIdentifier ?? mkPublicIdentifier("vector222"),
    channelNonce: channel?.nonce ?? 9,
  };

  const channelOverrides = channel
    ? {
        inDispute: channel.inDispute,
        aliceIdentifier: defaults.initiatorIdentifier,
        bobIdentifier: defaults.responderIdentifier,
        ...channel.networkContext,
        ...channel.latestUpdate,
      }
    : {};

  return {
    ...defaults,
    ...core,
    ...channelOverrides,
  };
}
