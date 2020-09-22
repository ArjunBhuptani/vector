import { FullChannelState, IVectorProtocol } from "@connext/vector-types";
import { constants } from "ethers";

import { expect, getTestLoggers } from "../utils";
import { createTransfer, getFundedChannel } from "../utils/channel";

const testName = "Create Integrations";
const { log } = getTestLoggers(testName);
describe(testName, () => {
  let alice: IVectorProtocol;
  let bob: IVectorProtocol;

  let preCreateChannel: FullChannelState;

  beforeEach(async () => {
    const setup = await getFundedChannel(testName, [
      {
        assetId: constants.AddressZero,
        amount: ["100", "100"],
      },
    ]);
    alice = setup.alice;
    bob = setup.bob;
    preCreateChannel = setup.channel;

    log.info({
      alice: alice.publicIdentifier,
      bob: bob.publicIdentifier,
    });
  });

  it("should create an eth transfer from alice -> bob", async () => {
    // Set test constants
    const assetId = constants.AddressZero;
    const transferAmount = "7";

    const { channel, transfer } = await createTransfer(
      preCreateChannel.channelAddress,
      alice,
      bob,
      assetId,
      transferAmount,
    );

    const { transferResolver, ...toCompare } = transfer;

    expect(await alice.getChannelState(channel.channelAddress)).to.containSubset(channel);
    expect(await alice.getTransferState(transfer.transferId)).to.containSubset(toCompare);
    expect(await bob.getChannelState(channel.channelAddress)).to.containSubset(channel);
    expect(await bob.getTransferState(transfer.transferId)).to.containSubset(toCompare);
  });

  it.skip("should work for Alice paying Bob", async () => {});
  it.skip("should work for Bob paying Alice", async () => {});
  it.skip("should work for many concurrent transfers with multiple parties", async () => {});
});
