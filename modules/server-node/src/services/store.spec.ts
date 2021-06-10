import {
  createTestChannelState,
  getRandomChannelSigner,
  mkAddress,
  mkHash,
  mkSig,
  testStore,
} from "@connext/vector-utils";

import { PrismaStore } from "./store";
import { config } from "../config";
import { expect } from "chai";
import { CreateUpdateDetails } from "@connext/vector-types";

const name = "PrismaStore";

testStore(name, () => new PrismaStore(config.dbUrl));

describe("Server node-specific methods", async () => {
  let store: PrismaStore;

  before(async () => {
    store = new PrismaStore(config.dbUrl);
  });

  beforeEach(async () => {
    await store.clear();
  });

  after(async () => {
    await store.disconnect();
  });

  describe("should handle disconnects", () => {
    it("should handle a disconnect during `create`", async () => {
      // Save channel
      const channel1 = mkAddress("0xaaa");
      const aliceCS = getRandomChannelSigner();
      const bobCS = getRandomChannelSigner();
      const createState1 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          merkleRoot: mkHash("0x111"),
          nonce: 8,
          latestUpdate: { nonce: 8 },
        },
        { transferId: mkHash("0x123"), meta: { routingId: mkHash("0x123") } },
      );
      await store.saveChannelState(createState1.channel, createState1.transfer);
      const transfer1 = await store.getTransferState(mkHash("0x123"));
      expect(transfer1).to.be.ok;

      const createState2 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          merkleRoot: mkHash("0x222"),
          nonce: 9,
          latestUpdate: { nonce: 9 },
        },
        { transferId: mkHash("0x456"), meta: { routingId: mkHash("0x456") } },
      );
      await Promise.all([
        new Promise(async (resolve) => {
          try {
            await store.saveChannelState(createState2.channel, createState2.transfer);
            resolve("");
          } catch (e) {
            resolve("");
          }
        }),
        store.disconnect(),
      ]);

      // Reconnect
      await store.connect();
      const channel = await store.getChannelState(channel1);
      const transfer2 = await store.getTransferState(mkHash("0x456"));
      expect(channel).to.be.deep.eq(createState1.channel);
      expect(transfer2).to.be.undefined;
    });
  });

  describe("getUnsubmittedWithdrawals", () => {
    it("should get resolved withdrawals by transfer definition which dont have tx hashes and are not canceled", async () => {
      const channel1 = mkAddress("0xaaa");
      const aliceCS = getRandomChannelSigner();
      const bobCS = getRandomChannelSigner();
      const withdrawalTransferDef = mkAddress("0xdef123456");

      // create withdrawal 1
      const createState1 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          latestUpdate: { details: { transferDefinition: withdrawalTransferDef } },
        },
        {
          transferId: mkHash("0xaaa"),
          meta: { routingId: mkHash("0x123") },
          transferDefinition: withdrawalTransferDef,
        },
      );
      await store.saveChannelState(createState1.channel, createState1.transfer);
      // resolve withdrawal 1
      const resolveState1 = createTestChannelState(
        "resolve",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 1,
          latestUpdate: {
            nonce: createState1.channel.nonce + 1,
          },
        },
        { transferId: mkHash("0xaaa"), transferDefinition: withdrawalTransferDef },
      );
      await store.saveChannelState(resolveState1.channel, resolveState1.transfer);

      // create withdrawal 2
      const createState2 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 2,
          latestUpdate: {
            nonce: createState1.channel.nonce + 2,
            details: { transferDefinition: withdrawalTransferDef },
          },
        },
        {
          transferId: mkHash("0xbbb"),
          meta: { routingId: mkHash("0x456") },
          transferDefinition: withdrawalTransferDef,
        },
      );
      await store.saveChannelState(createState2.channel, createState2.transfer);
      const resolveState2 = createTestChannelState(
        "resolve",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 3,
          latestUpdate: { nonce: createState1.channel.nonce + 3 },
        },
        { transferId: mkHash("0xbbb"), transferDefinition: withdrawalTransferDef },
      );
      await store.saveChannelState(resolveState2.channel, resolveState2.transfer);

      // different transfer def (transfer 3)
      const createState3 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 4,
          latestUpdate: { nonce: createState1.channel.nonce + 4 },
        },
        { transferId: mkHash("0xccc"), meta: { routingId: mkHash("0x567") } },
      );
      (createState3.channel.latestUpdate.details as CreateUpdateDetails).transferDefinition = mkAddress("0xeee");
      await store.saveChannelState(createState3.channel, createState3.transfer);
      const resolveState3 = createTestChannelState(
        "resolve",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 5,
          latestUpdate: {
            nonce: createState1.channel.nonce + 5,
            details: { transferDefinition: withdrawalTransferDef },
          },
        },
        { transferId: mkHash("0xccc"), transferDefinition: withdrawalTransferDef },
      );
      await store.saveChannelState(resolveState3.channel, resolveState3.transfer);

      // create cancelled withdrawal
      const createState4 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 6,
          latestUpdate: {
            nonce: createState1.channel.nonce + 6,
            details: { transferDefinition: withdrawalTransferDef },
          },
        },
        {
          transferId: mkHash("0xddd"),
          meta: { routingId: mkHash("0x678") },
          transferDefinition: withdrawalTransferDef,
        },
      );
      await store.saveChannelState(createState4.channel, createState4.transfer);
      const resolveState4 = createTestChannelState(
        "resolve",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 7,
          latestUpdate: {
            nonce: createState1.channel.nonce + 7,
            details: {
              transferResolver: {
                responderSignature: mkSig("0x0"),
              },
            },
          },
        },
        { transferId: mkHash("0xddd"), transferDefinition: withdrawalTransferDef },
      );
      await store.saveChannelState(resolveState4.channel, resolveState4.transfer);

      // submitted already
      const createState5 = createTestChannelState(
        "create",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 6,
          latestUpdate: {
            nonce: createState1.channel.nonce + 6,
            details: { transferDefinition: withdrawalTransferDef, transferId: mkHash("0xeee") },
          },
        },
        {
          transferId: mkHash("0xeee"),
          meta: { routingId: mkHash("0x789") },
          transferDefinition: withdrawalTransferDef,
        },
      );
      await store.saveChannelState(createState5.channel, createState5.transfer);
      const resolveState5 = createTestChannelState(
        "resolve",
        {
          channelAddress: channel1,
          aliceIdentifier: aliceCS.publicIdentifier,
          bobIdentifier: bobCS.publicIdentifier,
          nonce: createState1.channel.nonce + 7,
          latestUpdate: { nonce: createState1.channel.nonce + 7 },
        },
        { transferId: mkHash("0xeee"), transferDefinition: withdrawalTransferDef },
      );
      await store.saveChannelState(resolveState5.channel, resolveState5.transfer);
      await store.saveWithdrawalCommitment(resolveState5.transfer.transferId, {
        transactionHash: mkHash("0xfff"),
      } as any);

      const unsubmitted = await store.getUnsubmittedWithdrawals(channel1, withdrawalTransferDef);
      expect(unsubmitted.length).to.eq(2);
    });
  });
});
