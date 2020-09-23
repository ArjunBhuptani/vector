import {
  ChannelSigner,
  getRandomChannelSigner,
  createTestChannelUpdateWithSigners,
  createTestChannelStateWithSigners,
  createTestLinkedTransferState,
  createCoreTransferState,
  hashCoreTransferState,
  hashTransferState,
  getRandomBytes32,
  createTestUpdateParams,
  mkAddress,
  mkSig,
} from "@connext/vector-utils";
import {
  IVectorStore,
  IMessagingService,
  UpdateType,
  LinkedTransferStateEncoding,
  ChannelUpdate,
  InboundChannelUpdateError,
  LinkedTransferResolverEncoding,
  OutboundChannelUpdateError,
  Result,
  UpdateParams,
} from "@connext/vector-types";
import { BigNumber, constants } from "ethers";
import { expect } from "chai";
import { MerkleTree } from "merkletreejs";
import pino from "pino";
import Sinon from "sinon";
import { VectorOnchainService } from "@connext/vector-contracts";

// Import as full module for easy sinon function mocking
import * as vectorUpdate from "../update";
import { inbound, outbound } from "../sync";
import * as vectorUtils from "../utils";

import { MemoryStoreService } from "./services/store";
import { MemoryMessagingService } from "./services/messaging";
import { env } from "./utils";

// TODO: Sync todos:
// - signData should use a Result type

describe("inbound", () => {
  // FIXME: These are blocking tests!
  it.skip("should fail if there is no channel in store and it is not a setup update", async () => {});
  it.skip("should fail if there is no transfer in the store and it is a resolve update", async () => {});
  it.skip("should fail if you are 3+ states behind the update", async () => {});
  it.skip("should fail if validating the update fails", async () => {});
  it.skip("should fail if applying the update fails", async () => {});
  it.skip("should fail if signing the data fails", async () => {});
  it.skip("should fail if saving the data fails", async () => {});
  it.skip("IFF update is invalid and channel is out of sync, should fail on retry, but sync properly", async () => {});
  describe.skip("should sync channel and retry update IFF state nonce is behind by 2 updates", async () => {
    describe.skip("initiator trying deposit", () => {
      it("missed setup, should work", async () => {});
      it("missed deposit, should work", async () => {});
      it("missed create, should work", async () => {});
      it("missed resolve, should work", async () => {});
    });

    describe.skip("initiator trying create", () => {
      it("missed deposit, should work", async () => {});
      it("missed create, should work", async () => {});
      it("missed resolve, should work", async () => {});
    });

    describe.skip("initiator trying resolve", () => {
      it("missed deposit, should work", async () => {});
      it("missed create, should work", async () => {});
      it("missed resolve, should work", async () => {});
    });
  });

  const chainProviders = env.chainProviders;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [chainIdStr, providerUrl] = Object.entries(chainProviders)[0] as string[];
  const inbox = getRandomBytes32();
  const logger = pino().child({
    testName: "inbound",
  });

  let signers: ChannelSigner[];
  let store: IVectorStore;
  let messaging: IMessagingService;

  beforeEach(async () => {
    signers = Array(2)
      .fill(0)
      .map(() => getRandomChannelSigner(providerUrl));
    store = new MemoryStoreService();
    messaging = new MemoryMessagingService();
  });

  it("should work if there is no channel state stored and you are receiving a setup update", async () => {
    // Generate the update
    const update: ChannelUpdate<typeof UpdateType.setup> = createTestChannelUpdateWithSigners(
      signers,
      UpdateType.setup,
      {
        nonce: 1,
        signatures: [],
      },
    );
    const result = await inbound(update, update, inbox, store, messaging, signers[1], logger);
    expect(result.getError()).to.be.undefined;

    // Verify result
    const emptyChannel = {
      channelAddress: update.channelAddress,
      participants: signers.map(s => s.address),
      networkContext: update.details.networkContext,
      assetAddresss: [],
      balances: [],
      lockedBalance: [],
      merkleRoot: constants.HashZero,
      nonce: 0,
      publicIdentifiers: signers.map(s => s.publicIdentifier),
      timeout: update.details.timeout,
      latestUpdate: {} as any, // There is no latest update on setup
      latestDepositNonce: 0,
    };
    const expected = (await vectorUpdate.applyUpdate(update, emptyChannel, undefined)).getValue()!;
    expect(result.getValue()).to.containSubset(expected);
  });

  it("should return an error if the update does not advance state", async () => {
    // Load store with channel at nonce = 1
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });
    await store.saveChannelState(channel, {} as any);

    // Generate an update at nonce = 1
    const update = createTestChannelUpdateWithSigners(signers, UpdateType.setup, { nonce: 1 });

    const result = await inbound(update, channel.latestUpdate, inbox, store, messaging, signers[1], logger);
    expect(result.isError).to.be.true;
    const error = result.getError()!;
    expect(error.message).to.be.eq(InboundChannelUpdateError.reasons.StaleUpdate);
    expect(error.update).to.containSubset(channel.latestUpdate);

    // Make sure store was not updated
    const stored = await store.getChannelState(channel.channelAddress);
    expect(stored).to.containSubset(channel);
  });

  it("should work if stored state is behind (update nonce = stored nonce + 2)", async () => {
    // Load store with channel at nonce = 1
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });
    await store.saveChannelState(channel, {} as any);

    // Create the update to sync with (in this case, a deposit)
    const toSync = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, { nonce: 2 });

    // Create the update to propose (a create)
    const transferInitialState = createTestLinkedTransferState({
      balance: { to: signers.map(s => s.address), amount: ["1", "0"] },
    });
    const assetAddress = constants.AddressZero;
    const coreState = createCoreTransferState({
      initialStateHash: hashTransferState(transferInitialState, LinkedTransferStateEncoding),
    });
    const hash = Buffer.from(hashCoreTransferState(coreState));
    const tree = new MerkleTree([hash], hashCoreTransferState);
    const update = createTestChannelUpdateWithSigners(signers, UpdateType.create, {
      nonce: 3,
      assetAddress,
      balance: transferInitialState.balance,
      details: {
        ...coreState,
        transferEncodings: [LinkedTransferStateEncoding, LinkedTransferResolverEncoding],
        transferInitialState,
        merkleRoot: tree.getHexRoot(),
        merkleProofData: tree.getHexProof(hash),
      },
    });

    // Call `inbound`
    const result = await inbound(update, toSync, inbox, store, messaging, signers[1], logger);
    expect(result.isError).to.be.false;

    // Verify stored data
    // TODO: stronger assertions!
    const storedState = await store.getChannelState(update.channelAddress);
    const storedCommitment = await store.getChannelCommitment(update.channelAddress);
    expect(storedState?.latestUpdate).to.containSubset(update);
    expect(storedState?.nonce).to.be.eq(update.nonce);
    expect(storedCommitment).to.be.ok;
    expect(storedCommitment!.signatures.filter(x => !!x).length).to.be.eq(2);
  });

  it("should update if stored state is in sync", async () => {
    // Load store with channel at nonce = 1
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, { nonce: 1 });
    await store.saveChannelState(channel, {} as any);

    // Create the update to sync with (in this case, a deposit)
    const update = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
      nonce: 2,
    });

    // Call `inbound`
    const result = await inbound(update, update, inbox, store, messaging, signers[1], logger);
    expect(result.isError).to.be.false;

    // Make sure whats in the store lines up with whats emitted
    const storedState = await store.getChannelState(update.channelAddress);
    const storedCommitment = await store.getChannelCommitment(update.channelAddress);

    // TODO: stronger assertions!
    // Verify stored data
    expect(storedState?.nonce).to.be.eq(update.nonce);
    expect(storedCommitment).to.be.ok;
    expect(storedCommitment!.signatures.filter(x => !!x).length).to.be.eq(2);
  });
});

describe("outbound", () => {
  // FIXME: These are blocking tests!
  it.skip("should fail if resolving a transfer and none exists in store", async () => {});
  it.skip("should fail if signatures are invalid", async () => {});
  it.skip("should fail if update is single signed", async () => {});
  it.skip("should fail if the channel is not saved to store", async () => {});
  it.skip("IFF update is invalid and channel is out of sync, should fail on retry, but sync properly", async () => {});
  // .. see other skipped tests at bottom ..

  const chainProviders = env.chainProviders;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const providerUrl = Object.values(chainProviders)[0] as string;
  const logger = pino().child({
    testName: "inbound",
  });
  const channelAddress = mkAddress("0xccc");

  let signers: ChannelSigner[];
  let store: Sinon.SinonStubbedInstance<MemoryStoreService>;
  let messaging: Sinon.SinonStubbedInstance<MemoryMessagingService>;
  let chainService: Sinon.SinonStubbedInstance<VectorOnchainService>;

  beforeEach(async () => {
    signers = Array(2)
      .fill(0)
      .map(() => getRandomChannelSigner(providerUrl));

    // Create all the services stubs
    store = Sinon.createStubInstance(MemoryStoreService);
    messaging = Sinon.createStubInstance(MemoryMessagingService);
    chainService = Sinon.createStubInstance(VectorOnchainService);

    // Set the sig recovery mock (always valid sig recovery by default)
    Sinon.stub(vectorUtils, "validateChannelUpdateSignatures").resolves(undefined);
  });

  afterEach(() => {
    // Always restore stubs after tests
    Sinon.restore();
  });

  it("should fail if it fails to generate the update", async () => {
    const params = createTestUpdateParams(UpdateType.deposit, { channelAddress: "0xfail" });

    // Stub the generate update function
    const error = new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.InvalidParams, params);
    Sinon.stub(vectorUpdate, "generateUpdate").resolves(Result.fail(error));

    const res = await outbound(params, store, chainService, messaging, signers[0], logger);
    expect(res.isError).to.be.true;
    expect(res.getError()).to.be.deep.eq(error);
  });

  it("should fail if it counterparty update fails for some reason other than update being out of date", async () => {
    // Create a setup update
    const params = createTestUpdateParams(UpdateType.setup, {
      channelAddress,
      details: { counterpartyIdentifier: signers[1].publicIdentifier },
    });
    // Create a messaging service stub
    const counterpartyError = new InboundChannelUpdateError(InboundChannelUpdateError.reasons.RestoreNeeded, {} as any);
    messaging.sendProtocolMessage.resolves(Result.fail(counterpartyError));

    // Call the outbound function
    const res = await outbound(params, store, chainService, messaging, signers[0], logger);

    // Verify the error is returned as an outbound error
    const error = res.getError();
    expect(error?.message).to.be.eq(OutboundChannelUpdateError.reasons.CounterpartyFailure);
    expect(error?.context).to.deep.eq({ counterpartyError: counterpartyError.message });

    // Verify message only sent once by initiator
    expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
  });

  it("should successfully initiate an update if channels are in sync, or initiator is ahead by 1 (update nonce > state.nonce)", async () => {
    // Create the update (a user deposit on a setup channel)
    const assetAddress = constants.AddressZero;
    const depositBAmt = BigNumber.from(16);
    const params: UpdateParams<typeof UpdateType.deposit> = createTestUpdateParams(UpdateType.deposit, {
      channelAddress,
      details: { assetAddress },
    });

    // Create the channel and store mocks for the user
    const channel = createTestChannelStateWithSigners(signers, UpdateType.setup, {
      channelAddress,
      nonce: 1,
      balances: [],
      lockedBalance: [],
      assetAddresss: [],
      latestDepositNonce: 0,
      latestUpdate: { type: UpdateType.setup },
    });
    store.getChannelState.resolves(channel);

    // Set the onchain service mocks
    chainService.getChannelOnchainBalance.resolves(Result.ok(depositBAmt));
    chainService.getLatestDepositByAssetAddress.resolves(
      Result.ok({ nonce: BigNumber.from(0), amount: BigNumber.from(0) }),
    );

    // Generate the update from the params
    const doubleSigned = [mkSig("0xaaaaccccc"), mkSig("0xbbbbddddd")];
    const update = createTestChannelUpdateWithSigners(signers, params.type, {
      channelAddress,
      details: {
        latestDepositNonce: 0,
      },
      nonce: 2,
      signatures: ["", doubleSigned[1]],
      assetAddress: params.details.assetAddress,
      balance: { to: signers.map(s => s.address), amount: ["0", depositBAmt.toString()] },
    });

    // Set the messaging mocks to return the proper update from the counterparty
    messaging.sendProtocolMessage.resolves(
      Result.ok({ update: { ...update, signatures: doubleSigned }, previousUpdate: channel.latestUpdate }),
    );

    // Call the outbound function
    const res = await outbound(params, store, chainService, messaging, signers[0], logger);

    // Verify return values
    expect(res.getError()).to.be.undefined;
    expect(res.getValue()).to.containSubset({
      channelAddress,
      nonce: 2,
      latestUpdate: {
        type: params.type,
      },
    });

    // Verify message only sent once by initiator w/update to sync
    expect(messaging.sendProtocolMessage.callCount).to.be.eq(1);
    expect(messaging.sendProtocolMessage.firstCall.args[1]).to.containSubset(channel.latestUpdate);
  });

  describe("should sync channel and retry update IFF update nonce === state nonce", async () => {
    describe.skip("initiator trying setup", () => {
      it("missed setup, should sync without retrying", async () => {});
    });

    describe("initiator trying deposit", () => {
      // Assume the initiator is Alice, and she is always trying to reconcile
      // a deposit. Generate test constants
      const assetAddress = constants.AddressZero;
      const userBBalance = BigNumber.from(9);
      const missedUpdateNonce = 2;
      const depositAAmt = BigNumber.from(14);
      const depositANonce = BigNumber.from(1);
      const params: UpdateParams<typeof UpdateType.deposit> = createTestUpdateParams(UpdateType.deposit, {
        channelAddress,
        details: { assetAddress },
      });

      beforeEach(() => {
        // Set the chain service mock
        chainService.getLatestDepositByAssetAddress.resolves(Result.ok({ nonce: depositANonce, amount: depositAAmt }));

        chainService.getChannelOnchainBalance.resolves(Result.ok(userBBalance.add(depositAAmt)));
      });

      afterEach(() => {
        // Always restore stubs after tests
        Sinon.restore();
      });

      it("missed deposit, should work", async () => {
        // Assume initiator missed a user deposit
        // Create the missed update (user eth deposit of 7)
        const missedUpdate = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
          channelAddress,
          nonce: missedUpdateNonce,
          balance: { to: signers.map(s => s.address), amount: ["0", userBBalance.toString()] },
          assetAddress,
          details: { latestDepositNonce: depositANonce.sub(1).toNumber() },
          signatures: [mkSig("0xaaaaccccc"), mkSig("0xbbbbddddd")],
        });

        // Create the expected final double signed update state
        const signedUpdate = createTestChannelUpdateWithSigners(signers, UpdateType.deposit, {
          channelAddress,
          details: { latestDepositNonce: depositANonce.toNumber() },
          signatures: [mkSig("0xaaabbb"), mkSig("0xcccddd")],
          nonce: missedUpdateNonce + 1,
          assetAddress,
          balance: { to: signers.map(s => s.address), amount: [depositAAmt.toString(), userBBalance.toString()] },
        });

        // Set messaging mocks:
        // - first call should return an error
        // - second call should return a final channel state
        const counterpartyError = new InboundChannelUpdateError(
          InboundChannelUpdateError.reasons.StaleUpdate,
          missedUpdate,
        );
        messaging.sendProtocolMessage.onCall(0).resolves(Result.fail(counterpartyError));
        messaging.sendProtocolMessage
          .onCall(1)
          .resolves(Result.ok({ update: signedUpdate, previousUpdate: missedUpdate }));

        // Generate the initiators stale channel, and set store mock
        const staleChannel = createTestChannelStateWithSigners(signers, UpdateType.setup, {
          channelAddress,
          nonce: missedUpdateNonce - 1,
          latestDepositNonce: 0,
          latestUpdate: {},
          balances: [],
          lockedBalance: [],
          assetAddresss: [],
        });
        store.getChannelState.resolves(staleChannel);

        // Call the outbound function
        const res = await outbound(params, store, chainService, messaging, signers[0], logger);

        // Verify the update was successfully sent + retried
        expect(res.getError()).to.be.undefined;
        expect(res.getValue()).to.be.containSubset({
          nonce: signedUpdate.nonce,
          latestUpdate: signedUpdate,
          channelAddress,
        });
        expect(messaging.sendProtocolMessage.callCount).to.be.eq(2);
        expect(messaging.sendProtocolMessage.secondCall.args[1]).to.be.deep.eq(missedUpdate);
      });

      it.skip("missed create, should work", async () => {});
      it.skip("missed resolve, should work", async () => {});
    });

    describe.skip("initiator trying create", () => {
      it("missed deposit, should work", async () => {});
      it("missed create, should work", async () => {});
      it("missed resolve, should work", async () => {});
    });

    describe.skip("initiator trying resolve", () => {
      it("missed deposit, should work", async () => {});
      it("missed create, should work", async () => {});
      it("missed resolve, should work", async () => {});
    });
  });
});
