import { getCreate2MultisigAddress, getRandomChannelSigner, ChannelSigner } from "@connext/vector-utils";
import { Contract, ContractFactory, Wallet, constants, BigNumber } from "ethers";

import { ChannelMastercopy, ChannelFactory } from "../artifacts";
import { VectorOnchainService } from "../onchainService";

import { expect, getOnchainTxService, provider } from "./utils";

describe("ChannelFactory", () => {
  let deployer: Wallet;
  let channelFactory: Contract;
  let channelMastercopy: Contract;
  let onchainService: VectorOnchainService;
  let chainId: number;

  beforeEach(async () => {
    deployer = provider.getWallets()[0];
    chainId = (await provider.getNetwork()).chainId;

    channelMastercopy = await new ContractFactory(ChannelMastercopy.abi, ChannelMastercopy.bytecode, deployer).deploy();
    await channelMastercopy.deployed();

    channelFactory = await new ContractFactory(ChannelFactory.abi, ChannelFactory.bytecode, deployer).deploy(
      channelMastercopy.address,
    );
    await channelFactory.deployed();
    onchainService = await getOnchainTxService(provider);
  });

  it("should deploy", async () => {
    expect(channelFactory.address).to.be.a("string");
  });

  it("should create a channel", async () => {
    const initiator = getRandomChannelSigner();
    const responder = getRandomChannelSigner();
    const created = new Promise(res => {
      channelFactory.once(channelFactory.filters.ChannelCreation(), res);
    });
    const tx = await channelFactory.createChannel(initiator.address, responder.address);
    expect(tx.hash).to.be.a("string");
    await tx.wait();
    const channelAddress = await created;
    const computedAddr = await getCreate2MultisigAddress(
      initiator.publicIdentifier,
      responder.publicIdentifier,
      chainId,
      channelFactory.address,
      channelMastercopy.address,
      onchainService,
    );
    expect(channelAddress).to.be.a("string");
    expect(channelAddress).to.be.eq(computedAddr.getValue());
  });

  it("should create a channel with a deposit", async () => {
    // Use funded account for initiator
    const initiator = new ChannelSigner(deployer.privateKey, provider);
    const responder = getRandomChannelSigner();
    const created = new Promise<string>(res => {
      channelFactory.once(channelFactory.filters.ChannelCreation(), data => {
        res(data);
      });
    });
    const value = BigNumber.from("1000");
    const tx = await channelFactory
      .connect(deployer)
      .createChannelAndDepositA(initiator.address, responder.address, constants.AddressZero, value, { value });
    expect(tx.hash).to.be.a("string");
    await tx.wait();
    const channelAddress = await created;
    const computedAddr = await getCreate2MultisigAddress(
      initiator.publicIdentifier,
      responder.publicIdentifier,
      chainId,
      channelFactory.address,
      channelMastercopy.address,
      onchainService,
    );
    expect(channelAddress).to.be.a("string");
    expect(channelAddress).to.be.eq(computedAddr.getValue());

    const balance = await provider.getBalance(channelAddress as string);
    expect(balance).to.be.eq(value);

    const code = await provider.getCode(channelAddress);
    expect(code).to.not.be.eq("0x");

    const latestDeposit = await new Contract(
      channelAddress,
      ChannelMastercopy.abi,
      deployer,
    ).latestDepositByAssetAddress(constants.AddressZero);
    expect(latestDeposit.nonce).to.be.eq(1);
    expect(latestDeposit.amount).to.be.eq(value);
  });
});
