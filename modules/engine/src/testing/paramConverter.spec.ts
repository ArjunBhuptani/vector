import {
  CreateTransferParams,
  DEFAULT_TRANSFER_TIMEOUT,
  EngineParams,
  FullChannelState,
  FullTransferState,
  HashlockTransferState,
  RegisteredTransfer,
  ResolveTransferParams,
  Result,
  TransferNames,
  ChainError,
  UpdateType,
  jsonifyError,
  DEFAULT_CHANNEL_TIMEOUT,
  SetupParams,
  IVectorChainReader,
  IEngineStore,
  IChannelSigner,
} from "@connext/vector-types";
import {
  createTestChannelState,
  createTestChannelStateWithSigners,
  createTestFullHashlockTransferState,
  getRandomAddress,
  getRandomBytes32,
  getRandomIdentifier,
  mkAddress,
  ChannelSigner,
  NatsMessagingService,
  mkPublicIdentifier,
  MemoryStoreService,
  createTestFullCrosschainTransferState,
  getRandomChannelSigner,
  mkSig,
} from "@connext/vector-utils";
import { expect } from "chai";
import Sinon, { SinonStub, stub } from "sinon";
import { VectorChainReader, WithdrawCommitment } from "@connext/vector-contracts";
import { getAddress } from "@ethersproject/address";
import { AddressZero } from "@ethersproject/constants";

import {
  convertConditionalTransferParams,
  convertResolveConditionParams,
  convertSetupParams,
  convertWithdrawParams,
} from "../paramConverter";
import { ParameterConversionError } from "../errors";
import * as listeners from "../listeners";

import { env } from "./env";

describe("ParamConverter", () => {
  const chainId = parseInt(Object.keys(env.chainProviders)[0]);
  const providerUrl = env.chainProviders[chainId];
  const chainAddresses = { ...env.chainAddresses };
  const withdrawRegisteredInfo: RegisteredTransfer = {
    definition: mkAddress("0xdef"),
    resolverEncoding: "resolve",
    stateEncoding: "state",
    name: TransferNames.Withdraw,
    encodedCancel: "encodedCancel",
  };
  const transferRegisteredInfo: RegisteredTransfer = {
    definition: mkAddress("0xdef"),
    resolverEncoding: "resolve",
    stateEncoding: "state",
    name: TransferNames.HashlockTransfer,
    encodedCancel: "encodedCancel",
  };
  let chainReader: Sinon.SinonStubbedInstance<VectorChainReader>;
  let signerA: Sinon.SinonStubbedInstance<ChannelSigner>;
  let signerB: Sinon.SinonStubbedInstance<ChannelSigner>;
  let messaging: Sinon.SinonStubbedInstance<NatsMessagingService>;
  let store: Sinon.SinonStubbedInstance<IEngineStore>;

  const setDefaultStubs = (registryInfo: RegisteredTransfer = transferRegisteredInfo) => {
    chainReader = Sinon.createStubInstance(VectorChainReader);
    signerA = Sinon.createStubInstance(ChannelSigner);
    signerB = Sinon.createStubInstance(ChannelSigner);
    messaging = Sinon.createStubInstance(NatsMessagingService);
    store = Sinon.createStubInstance(MemoryStoreService);
    store.getTransferState.resolves(createTestFullHashlockTransferState());
    store.getChannelState.resolves(createTestChannelState("create").channel);

    signerA.signMessage.resolves("success");
    signerB.signMessage.resolves("success");
    signerA.publicIdentifier = mkPublicIdentifier("vectorAAA");
    signerB.publicIdentifier = mkPublicIdentifier("vectorBBB");
    signerA.address = mkAddress("0xaaa");
    signerB.address = mkAddress("0xeee");

    chainReader.getBlockNumber.resolves(Result.ok<number>(110));
    chainReader.getRegisteredTransferByName.resolves(Result.ok<RegisteredTransfer>(registryInfo));
    chainReader.getRegisteredTransferByDefinition.resolves(Result.ok<RegisteredTransfer>(registryInfo));
  };

  afterEach(() => Sinon.restore());

  describe("convertSetupParams", () => {
    const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
      channelAddress: mkAddress("0xa"),
      networkContext: {
        ...chainAddresses[chainId],
        chainId,
        providerUrl,
      },
    });

    const generateParams = (): EngineParams.Setup => {
      return {
        counterpartyIdentifier: channelState.aliceIdentifier,
        chainId: chainId,
        timeout: DEFAULT_CHANNEL_TIMEOUT.toString(),
        meta: undefined,
      };
    };

    const runTest = (params: EngineParams.Setup, result: SetupParams) => {
      // Check results of a test run, making sure the result conforms to desirable SetupParams
      // based on input EngineParams.Setup.
      expect(result).to.containSubset({
        counterpartyIdentifier: params.counterpartyIdentifier,
        timeout: params.timeout,
        networkContext: {
          channelFactoryAddress: chainAddresses[params.chainId].channelFactoryAddress,
          transferRegistryAddress: chainAddresses[params.chainId].transferRegistryAddress,
          chainId: params.chainId,
        },
        meta: params.meta,
      });
    };

    it("should work with provided params.timeout", async () => {
      const params = { ...generateParams(), timeout: "100000" };
      const result = await convertSetupParams(params, chainAddresses);
      runTest(params, result.getValue());
    });

    it("should work with default params.timeout", async () => {
      // Set timeout to undefined in actual passed params.
      const params = { ...generateParams(), timeout: undefined };
      const result = await convertSetupParams(params, chainAddresses);
      // Now that we've run the method, overwrite timeout to use the default value, and pass
      // these expected params into our check method.
      const expectedParams = { ...params, timeout: DEFAULT_CHANNEL_TIMEOUT.toString() };
      runTest(expectedParams, result.getValue());
    });
  });

  describe("convertConditionalTransferParams", () => {
    const transferFee = "5";

    const generateParams = (bIsRecipient = false): EngineParams.ConditionalTransfer => {
      setDefaultStubs();
      const hashlockState: Omit<HashlockTransferState, "balance"> = {
        lockHash: getRandomBytes32(),
        expiry: "45000",
      };
      const params = {
        channelAddress: mkAddress("0xa"),
        amount: "8",
        assetId: mkAddress("0x0"),
        recipient: bIsRecipient ? signerB.publicIdentifier : getRandomIdentifier(),
        recipientChainId: chainId,
        recipientAssetId: mkAddress("0x1"),
        type: TransferNames.HashlockTransfer,
        details: hashlockState,
        timeout: DEFAULT_TRANSFER_TIMEOUT.toString(),
        meta: {
          message: "test",
          routingId: getRandomBytes32(),
        },
      };
      setMessagingStub(params, !bIsRecipient);
      return params;
    };

    const setMessagingStub = (submittedParams, isUserA = false) => {
      messaging.sendTransferQuoteMessage.resolves(
        Result.ok({
          routerIdentifier: signerA.publicIdentifier,
          chainId,
          amount: submittedParams.amount,
          assetId: submittedParams.assetId,
          recipient: submittedParams.recipient ?? (isUserA ? signerA.publicIdentifier : signerB.publicIdentifier),
          recipientChainId: submittedParams.recipientChainId ?? chainId,
          recipientAssetId: submittedParams.recipientAssetId ?? submittedParams.assetId,
          fee: transferFee,
          expiry: (Date.now() + 30_000).toString(),
          signature: "success",
        }),
      );
    };

    it("should fail if params.type is a name and chainReader.getRegisteredTransferByName fails", async () => {
      const params = generateParams();
      const chainErr = new ChainError("Failure");
      chainReader.getRegisteredTransferByName.resolves(Result.fail(chainErr));
      // Set incorrect type
      params.type = "FailingTest";
      const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      const ret = await convertConditionalTransferParams(
        params,
        signerA,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );
      expect(ret.isError).to.be.true;
      const err = ret.getError();
      expect(err?.message).to.be.eq(ParameterConversionError.reasons.FailedToGetRegisteredTransfer);
      expect(err?.context.channelAddress).to.be.eq(channelState.channelAddress);
      expect(err?.context.publicIdentifier).to.be.eq(signerA.publicIdentifier);
      expect(err?.context.params).to.be.deep.eq(params);
      expect(err?.context.registryError).to.be.deep.eq(jsonifyError(chainErr));
    });

    it("should fail if bob is sending and cannot get quote from alice", async () => {
      const params = generateParams();
      const err = new Error("fail");
      messaging.sendTransferQuoteMessage.resolves(Result.fail(err) as any);
      const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      const ret = await convertConditionalTransferParams(
        params,
        signerA,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );
      expect(ret.isError).to.be.true;
      expect(ret.getError()?.message).to.be.eq(ParameterConversionError.reasons.CouldNotGetQuote);
      expect(ret.getError()?.context.quoteError.message).to.be.eq("fail");
    });

    it("should use the params.quote if it is provided", async () => {
      const params = generateParams();
      const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      params.quote = {
        signature: undefined,
        chainId,
        routerIdentifier: channelState.aliceIdentifier,
        amount: params.amount,
        assetId: params.assetId,
        recipient: params.recipient!,
        recipientChainId: params.recipientChainId!,
        recipientAssetId: params.recipientAssetId!,
        fee: "0",
        expiry: (Date.now() + 30_000).toString(),
      };
      const ret = await convertConditionalTransferParams(
        params,
        signerA,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );
      expect(ret.isError).to.be.false;
      expect(ret.getValue().meta.quote).to.be.deep.eq(params.quote);
      expect(messaging.sendTransferQuoteMessage.callCount).to.be.eq(0);
    });

    it("should return an unsigned quote if requester is channel.aliceIdentifier", async () => {
      const params = generateParams();
      const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      signerA.publicIdentifier = channelState.aliceIdentifier;
      const ret = await convertConditionalTransferParams(
        params,
        signerA,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );
      expect(ret.isError).to.be.false;
      expect(ret.getValue().meta.quote).to.containSubset({
        signature: undefined,
        chainId: channelState.networkContext.chainId,
        routerIdentifier: signerA.publicIdentifier,
        amount: params.amount,
        assetId: params.assetId,
        recipient: params.recipient!,
        recipientChainId: params.recipientChainId!,
        recipientAssetId: params.recipientAssetId!,
        fee: "0",
      });
      expect(messaging.sendTransferQuoteMessage.callCount).to.be.eq(0);
    });

    it("should fail if quote.fee is larger than transfer amount", async () => {
      const params = generateParams();
      const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      params.quote = {
        signature: undefined,
        chainId,
        routerIdentifier: channelState.aliceIdentifier,
        amount: params.amount,
        assetId: params.assetId,
        recipient: params.recipient!,
        recipientChainId: params.recipientChainId!,
        recipientAssetId: params.recipientAssetId!,
        fee: "10000000",
        expiry: (Date.now() + 30_000).toString(),
      };
      const ret = await convertConditionalTransferParams(
        params,
        signerA,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );
      expect(ret.isError).to.be.true;
      expect(ret.getError()?.message).to.be.eq(ParameterConversionError.reasons.FeeGreaterThanAmount);
    });

    it("should fail if params.type is an address and chainReader.getRegisteredTransferByDefinition fails", async () => {
      const params = generateParams();
      const chainErr = new ChainError("Failure");
      chainReader.getRegisteredTransferByDefinition.resolves(Result.fail(chainErr));
      // Set incorrect type
      params.type = getRandomAddress();
      const { channel: channelState } = createTestChannelState(UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      const ret = await convertConditionalTransferParams(
        params,
        signerA,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );
      expect(ret.isError).to.be.true;
      const err = ret.getError();
      expect(err?.message).to.be.eq(ParameterConversionError.reasons.FailedToGetRegisteredTransfer);
      expect(err?.context.channelAddress).to.be.eq(channelState.channelAddress);
      expect(err?.context.publicIdentifier).to.be.eq(signerA.publicIdentifier);
      expect(err?.context.params).to.be.deep.eq(params);
      expect(err?.context.registryError).to.be.deep.eq(jsonifyError(chainErr));
    });

    it("should fail if initiator is receiver for same chain/network", async () => {
      const params = generateParams(true);
      const channelState: FullChannelState = createTestChannelStateWithSigners([signerA, signerB], "deposit", {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });

      const ret = await convertConditionalTransferParams(
        params,
        signerB,
        channelState,
        chainReader as IVectorChainReader,
        messaging,
      );

      expect(ret.isError).to.be.true;
      const err = ret.getError();
      expect(err?.message).to.be.eq(ParameterConversionError.reasons.CannotSendToSelf);
      expect(err?.context.channelAddress).to.be.eq(channelState.channelAddress);
      expect(err?.context.publicIdentifier).to.be.eq(signerB.publicIdentifier);
      expect(err?.context.params).to.be.deep.eq(params);
    });

    const runTest = (params: any, result: CreateTransferParams, isUserA: boolean) => {
      expect(result).to.containSubset({
        channelAddress: params.channelAddress,
        balance: {
          amount: [params.amount, "0"],
          to: isUserA ? [signerA.address, signerB.address] : [signerB.address, signerA.address],
        },
        assetId: getAddress(params.assetId),
        transferDefinition: transferRegisteredInfo.definition,
        transferInitialState: {
          lockHash: params.details.lockHash,
          expiry: params.details.expiry,
        },
        timeout: params.timeout,
        meta: {
          requireOnline: true,
          routingId: params.meta!.routingId,
          path: [
            {
              recipientAssetId: params.recipientAssetId,
              recipientChainId: params.recipientChainId,
              recipient: params.recipient,
            },
          ],
          quote: {
            fee: isUserA ? "0" : transferFee,
            routerIdentifier: signerA.publicIdentifier,
            amount: params.amount,
            assetId: params.assetId,
            chainId,
            recipientAssetId: params.recipientAssetId,
            recipientChainId: params.recipientChainId,
            recipient: params.recipient,
            signature: isUserA ? undefined : "success",
          },
          ...params.meta!,
        },
      });
    };

    const testSetup = async (params: any, isUserA: boolean) => {
      const channelState: FullChannelState = createTestChannelStateWithSigners([signerA, signerB], UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      setMessagingStub(params, isUserA);

      const result = isUserA
        ? await convertConditionalTransferParams(
            params,
            signerA,
            channelState,
            chainReader as IVectorChainReader,
            messaging,
          )
        : await convertConditionalTransferParams(
            params,
            signerB,
            channelState,
            chainReader as IVectorChainReader,
            messaging,
          );

      return result;
    };

    const users = ["A", "B"];
    for (const user of users) {
      let isUserA = false;
      if (user === "A") {
        isUserA = true;
      }

      describe(`should work for ${user}`, () => {
        it("should work with provided params.recipientChainId", async () => {
          const params = { ...generateParams(), recipientChainId: 2 };

          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });

        it("should work with default params.recipientChainId", async () => {
          const params = { ...generateParams(), recipientChainId: undefined };

          const result = await testSetup(params, isUserA);

          const expectedParams = { ...params, recipientChainId: chainId };
          runTest(expectedParams, result.getValue(), isUserA);
        });
        it("should work with provided params.timeout", async () => {
          const params = { ...generateParams(), timeout: "100000" };
          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work with default params.timeout", async () => {
          const params = { ...generateParams(), timeout: undefined };

          const result = await testSetup(params, isUserA);

          const expectedParams = { ...params, timeout: DEFAULT_TRANSFER_TIMEOUT.toString() };
          runTest(expectedParams, result.getValue(), isUserA);
        });
        it("should work with provided params.recipientAssetId", async () => {
          const params = { ...generateParams(), recipientAssetId: AddressZero };

          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work with provided params.assetId", async () => {
          const params = { ...generateParams(), assetId: AddressZero };
          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work with in-channel recipient", async () => {
          const params = { ...generateParams() };
          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work with out-of-channel recipient", async () => {
          const params = generateParams(false);

          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work for A with out-of-channel recipient and given routingId", async () => {
          let params = generateParams(false);
          params = {
            ...params,
            recipient: getRandomIdentifier(),
            meta: { ...params.meta, routingId: getRandomBytes32() },
          };

          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work when params.type is a name", async () => {
          const params = { ...generateParams(), type: TransferNames.Withdraw };

          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
        it("should work when params.type is an address (transferDefinition)", async () => {
          const params = { ...generateParams(), type: getRandomBytes32() };

          const result = await testSetup(params, isUserA);
          runTest(params, result.getValue(), isUserA);
        });
      });
    }
  });

  describe("convertResolveConditionParams", () => {
    let isCrosschainTransfer: SinonStub;
    const generateParams = (): EngineParams.ResolveTransfer => {
      setDefaultStubs();
      return {
        channelAddress: mkAddress("0xa"),
        transferId: getRandomBytes32(),
        transferResolver: {
          preImage: getRandomBytes32(),
        },
        meta: {
          message: "test",
        },
      };
    };

    beforeEach(() => {
      isCrosschainTransfer = stub(listeners, "isCrosschainTransfer");
      isCrosschainTransfer.resolves(Result.ok(false));
    });

    it("should work", async () => {
      const params = generateParams();
      const transferState: FullTransferState = createTestFullHashlockTransferState({
        channelAddress: params.channelAddress,
      });
      const ret: ResolveTransferParams = (
        await convertResolveConditionParams(params, transferState, signerA, chainAddresses, chainReader as any, store)
      ).getValue();
      expect(ret).to.deep.eq({
        channelAddress: params.channelAddress,
        transferId: transferState.transferId,
        transferResolver: {
          preImage: params.transferResolver.preImage,
        },
        meta: {
          ...transferState.meta,
          ...params.meta,
        },
      });
    });

    describe("is crosschain transfer", () => {
      let transfer: FullTransferState<any>;
      let channel: FullChannelState;
      let alice: IChannelSigner;
      let bob: ChannelSigner;
      let defaultParams: any;
      let responderSignature: string;
      let initiatorSignature: string;
      beforeEach(async () => {
        defaultParams = generateParams();
        isCrosschainTransfer.resolves(Result.ok(true));
        alice = getRandomChannelSigner();
        bob = getRandomChannelSigner();
        channel = createTestChannelState("create").channel;
        channel.alice = alice.address;
        channel.bob = bob.address;
        transfer = createTestFullCrosschainTransferState();

        const commitment = new WithdrawCommitment(
          channel.channelAddress,
          channel.alice,
          channel.bob,
          channel.bob,
          transfer.assetId,
          transfer.balance.amount[0],
          "1",
        );
        console.log("commitment:", commitment.toJson());
        initiatorSignature = await alice.signMessage(commitment.hashToSign());
        responderSignature = await bob.signMessage(commitment.hashToSign());

        transfer.transferState.initiatorSignature = initiatorSignature;
        transfer.transferState.callData = undefined;
        transfer.transferState.callTo = undefined;
        transfer.transferState.data = commitment.hashToSign();
        transfer.transferState.initiator = channel.alice;
        transfer.transferState.responder = channel.bob;

        store.getTransferState.resolves(transfer);
        store.getChannelState.resolves(channel);
      });

      it("should fail if get channel errors", async () => {
        store.getChannelState.rejects("Blah");

        const res = await convertResolveConditionParams(
          {
            transferId: getRandomBytes32(),
            channelAddress: mkAddress(),
            transferResolver: { preImage: getRandomBytes32() },
          },
          transfer,
          alice,
          chainAddresses,
          chainReader as any,
          store,
        );
        expect(res.isError).to.be.true;
        expect(res.getError()?.message).to.eq(ParameterConversionError.reasons.ChannelNotFound);
      });

      it("should fail if channel not found", async () => {
        store.getChannelState.resolves(undefined);
        const res = await convertResolveConditionParams(
          {
            transferId: getRandomBytes32(),
            channelAddress: mkAddress(),
            transferResolver: { preImage: getRandomBytes32() },
          },
          transfer,
          alice,
          chainAddresses,
          chainReader as any,
          store,
        );
        expect(res.isError).to.be.true;
        expect(res.getError()?.message).to.eq(ParameterConversionError.reasons.ChannelNotFound);
      });

      it("should use provided resolver sig if it's valid", async () => {
        const preImage = getRandomBytes32();

        const res = await convertResolveConditionParams(
          {
            transferId: getRandomBytes32(),
            channelAddress: mkAddress(),
            transferResolver: { preImage, responderSignature },
          },
          transfer,
          bob,
          chainAddresses,
          chainReader as any,
          store,
        );

        expect(res.isError).to.be.false;
        expect(res.getValue()).to.deep.contain({ transferResolver: { preImage, responderSignature } });
      });

      it("should use regenerate resolver sig if it's not valid", async () => {
        const preImage = getRandomBytes32();

        const res = await convertResolveConditionParams(
          {
            transferId: getRandomBytes32(),
            channelAddress: mkAddress(),
            transferResolver: { preImage, responderSignature: mkSig() },
          },
          transfer,
          bob,
          chainAddresses,
          chainReader as any,
          store,
        );

        expect(res.isError).to.be.false;
        expect(res.getValue()).to.deep.contain({ transferResolver: { preImage, responderSignature } });
      });
    });
  });

  describe("convertWithdrawParams", () => {
    const quoteFee = "3";
    const generateParams = () => {
      setDefaultStubs(withdrawRegisteredInfo);
      const params = {
        channelAddress: mkAddress("0xa"),
        amount: "8",
        assetId: mkAddress("0x0"),
        recipient: mkAddress("0xb"),
        callTo: AddressZero,
        callData: "0x",
      };
      return params;
    };

    const generateChainData = (params, channel, isUserA) => {
      const commitment = new WithdrawCommitment(
        channel.channelAddress,
        channel.alice,
        channel.bob,
        params.recipient,
        params.assetId,
        params.amount,
        channel.nonce.toString(),
      );
      return commitment.hashToSign();
    };

    const testSetup = async (params: any, isUserA: boolean) => {
      const channelState = createTestChannelStateWithSigners([signerA, signerB], UpdateType.deposit, {
        channelAddress: params.channelAddress,
        networkContext: {
          ...chainAddresses[chainId],
          chainId,
          providerUrl,
        },
      });
      const result = isUserA
        ? await convertWithdrawParams(
            params,
            signerA,
            channelState,
            chainAddresses,
            chainReader as IVectorChainReader,
            messaging,
          )
        : await convertWithdrawParams(
            params,
            signerB,
            channelState,
            chainAddresses,
            chainReader as IVectorChainReader,
            messaging,
          );

      return { channelState, result };
    };

    const runTest = async (
      params: any,
      channelState: FullChannelState,
      result: CreateTransferParams,
      isUserA: boolean,
    ) => {
      const withdrawHash = generateChainData(params, channelState, isUserA);
      const signature = isUserA ? await signerA.signMessage(withdrawHash) : await signerB.signMessage(withdrawHash);
      expect(result).to.containSubset({
        channelAddress: channelState.channelAddress,
        balance: {
          amount: [params.amount, "0"],
          to: isUserA
            ? [getAddress(params.recipient), channelState.bob]
            : [getAddress(params.recipient), channelState.alice],
        },
        assetId: getAddress(params.assetId),
        transferDefinition: withdrawRegisteredInfo.definition,
        transferInitialState: {
          initiatorSignature: signature,
          initiator: isUserA ? signerA.address : signerB.address,
          responder: isUserA ? signerB.address : signerA.address,
          data: withdrawHash,
          nonce: channelState.nonce.toString(),
          fee: "0",
          callTo: params.callTo ?? AddressZero,
          callData: params.callData ?? "0x",
        },
        timeout: params.timeout ?? DEFAULT_TRANSFER_TIMEOUT.toString(),
      });
      expect(result.meta).to.containSubset({
        initiatorSubmits: false,
        withdrawNonce: channelState.nonce.toString(),
        quote: {
          channelAddress: params.channelAddress,
          amount: params.amount,
          assetId: params.assetId,
          fee: "0",
        },
      });
      if (!isUserA) {
        // expect(result.meta.quote.signature).to.be.ok;
      }
    };

    it("should fail if signer fails to sign message", async () => {
      const params = generateParams();
      signerA.signMessage.rejects(new Error("fail"));
      const { result } = await testSetup(params, true);

      expect(result.isError).to.be.true;
      expect(result.getError()).to.contain(new Error(`${signerA.publicIdentifier} failed to sign: fail`));
    });

    it("should fail if it cannot get registry information", async () => {
      const params = generateParams();
      const chainErr = new ChainError("Failure");
      chainReader.getRegisteredTransferByName.resolves(Result.fail(chainErr));
      const { channelState, result } = await testSetup(params, true);

      expect(result.isError).to.be.true;
      const err = result.getError();
      expect(err?.message).to.be.eq(ParameterConversionError.reasons.FailedToGetRegisteredTransfer);
      expect(err?.context.channelAddress).to.be.eq(channelState.channelAddress);
      expect(err?.context.publicIdentifier).to.be.eq(signerA.publicIdentifier);
      expect(err?.context.params).to.be.deep.eq(params);
      expect(err?.context.registryError).to.be.deep.eq(jsonifyError(chainErr));
    });

    const users = ["A", "B"];
    for (const user of users) {
      const isUserA = user === "A";

      describe(`should work for ${user}`, () => {
        it("should work with provided params.callTo", async () => {
          const params = { ...generateParams(), callTo: AddressZero };

          const { channelState, result } = await testSetup(params, isUserA);

          await runTest(params, channelState, result.getValue(), isUserA);
        });

        it("should work without provided params.callTo", async () => {
          const params = { ...generateParams(), callTo: undefined };

          const { channelState, result } = await testSetup(params, isUserA);
          const expectedParams = { ...generateParams(), callTo: AddressZero };
          await runTest(expectedParams, channelState, result.getValue(), isUserA);
        });

        it("should work with provided params.callData", async () => {
          const params = { ...generateParams(), callData: "0x" };

          const { channelState, result } = await testSetup(params, isUserA);

          await runTest(params, channelState, result.getValue(), isUserA);
        });

        it("should work without provided params.callData", async () => {
          const params = { ...generateParams(), callData: undefined };

          const { channelState, result } = await testSetup(params, isUserA);

          const expectedParams = { ...generateParams(), callData: "0x" };
          await runTest(expectedParams, channelState, result.getValue(), isUserA);
        });

        it("should work with provided params.timeout", async () => {
          const params = { ...generateParams(), timeout: "100000" };
          const { channelState, result } = await testSetup(params, isUserA);
          runTest(params, channelState, result.getValue(), isUserA);
        });

        it("should work with default params.timeout", async () => {
          const params = { ...generateParams(), timeout: undefined };
          const { channelState, result } = await testSetup(params, isUserA);
          const expectedParams = { ...params, timeout: DEFAULT_TRANSFER_TIMEOUT.toString() };
          runTest(expectedParams, channelState, result.getValue(), isUserA);
        });
      });
    }
  });
});
