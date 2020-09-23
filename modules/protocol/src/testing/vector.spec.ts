import { VectorOnchainService } from "@connext/vector-contracts";
import {
  getRandomChannelSigner,
  mkAddress,
  mkBytes32,
  mkPublicIdentifier,
  createTestLinkedTransferState,
  createTestChannelState,
  createTestUpdateParams,
  mkHash,
} from "@connext/vector-utils";
import pino from "pino";
import {
  LinkedTransferResolverEncoding,
  LinkedTransferStateEncoding,
  OutboundChannelUpdateError,
  IVectorOnchainService,
  ILockService,
  IMessagingService,
  IVectorStore,
  UpdateType,
  Result,
} from "@connext/vector-types";
import Sinon from "sinon";

import { Vector } from "../vector";
import * as vectorSync from "../sync";

import { MemoryMessagingService } from "./services/messaging";
import { MemoryLockService } from "./services/lock";
import { MemoryStoreService } from "./services/store";
import { expect } from "./utils";

let chainService: Sinon.SinonStubbedInstance<IVectorOnchainService>;
let lockService: Sinon.SinonStubbedInstance<ILockService>;
let messagingService: Sinon.SinonStubbedInstance<IMessagingService>;
let storeService: Sinon.SinonStubbedInstance<IVectorStore>;

beforeEach(async () => {
  chainService = Sinon.createStubInstance(VectorOnchainService);
  chainService.getChannelFactoryBytecode.resolves(Result.ok(mkHash()));
  lockService = Sinon.createStubInstance(MemoryLockService);
  messagingService = Sinon.createStubInstance(MemoryMessagingService);
  storeService = Sinon.createStubInstance(MemoryStoreService);
  storeService.getChannelStates.resolves([]);
  // Mock sync outbound
  Sinon.stub(vectorSync, "outbound").resolves(Result.ok(createTestChannelState(UpdateType.setup)));
});

afterEach(() => {
  Sinon.restore();
});

describe("Vector.connect", () => {
  it("should work", async () => {
    const signer = getRandomChannelSigner();
    const node = await Vector.connect(messagingService, lockService, storeService, signer, chainService, pino());
    expect(node).to.be.instanceOf(Vector);
    expect(node.publicIdentifier).to.be.eq(signer.publicIdentifier);
    expect(node.signerAddress).to.be.eq(signer.address);

    // Verify that the messaging service callback was registered
    expect(messagingService.onReceiveProtocolMessage.callCount).to.eq(1);

    // Verify sync was tried
    expect(storeService.getChannelStates.callCount).to.eq(1);
  });
});

type ParamValidationTest = {
  name: string;
  params: any;
  error: string;
};

describe("Vector.setup", () => {
  let vector: Vector;
  const counterpartyIdentifier = "indra6LkSoBv6QD5BKZ5vZQnVsd8cq6Tyb2oi93s62sTvW6xUUQg8PC";

  beforeEach(async () => {
    const signer = getRandomChannelSigner();
    storeService.getChannelStates.resolves([]);
    vector = await Vector.connect(messagingService, lockService, storeService, signer, chainService, pino());
  });

  it("should work", async () => {
    const { details } = createTestUpdateParams(UpdateType.setup, {
      details: { counterpartyIdentifier },
    });
    const result = await vector.setup(details);
    expect(result.getError()).to.be.undefined;
    expect(lockService.acquireLock.callCount).to.be.eq(1);
    expect(lockService.releaseLock.callCount).to.be.eq(1);
  });

  it("should fail if it fails to generate the create2 address", async () => {
    // Sinon has issues mocking out modules, we could use `proxyquire` but that
    // seems a bad choice since we use the utils within the tests
    // Instead, force a create2 failure by forcing a chainService failure
    chainService.getChannelFactoryBytecode.resolves(Result.fail(new Error("fail")));
    const { details } = createTestUpdateParams(UpdateType.setup);
    const result = await vector.setup(details);
    expect(result.getError()?.message).to.be.eq(OutboundChannelUpdateError.reasons.Create2Failed);
  });

  describe("should validate parameters", () => {
    const network = {
      chainId: 2,
      providerUrl: "http://eth.com",
      channelFactoryAddress: mkAddress("0xccc"),
      channelMastercopyAddress: mkAddress("0xeee"),
    };
    const validParams = {
      counterpartyIdentifier: mkPublicIdentifier(),
      networkContext: { ...network },
      timeout: "1000",
    };
    const tests: ParamValidationTest[] = [
      {
        name: "should fail if there is no counterparty",
        params: { ...validParams, counterpartyIdentifier: undefined },
        error: "should have required property 'counterpartyIdentifier'",
      },
      {
        name: "should fail if there is an invalid counterparty",
        params: { ...validParams, counterpartyIdentifier: "fail" },
        error: 'should match pattern "^indra([a-zA-Z0-9]{50})$"',
      },
      {
        name: "should fail if there is no chainId",
        params: { ...validParams, networkContext: { ...network, chainId: undefined } },
        error: "should have required property 'chainId'",
      },
      {
        name: "should fail if there is an invalid chainId (is a string)",
        params: { ...validParams, networkContext: { ...network, chainId: "fail" } },
        error: "should be number",
      },
      {
        name: "should fail if the chainId is below the minimum",
        params: { ...validParams, networkContext: { ...network, chainId: 0 } },
        error: "should be >= 1",
      },
      {
        name: "should fail if there is no providerUrl",
        params: { ...validParams, networkContext: { ...network, providerUrl: undefined } },
        error: "should have required property 'providerUrl'",
      },
      {
        name: "should fail if there is an invalid providerUrl",
        params: { ...validParams, networkContext: { ...network, providerUrl: 0 } },
        error: "should be string",
      },
      {
        name: "should fail if there is no channelFactoryAddress",
        params: { ...validParams, networkContext: { ...network, channelFactoryAddress: undefined } },
        error: "should have required property 'channelFactoryAddress'",
      },
      {
        name: "should fail if there is an invalid channelFactoryAddress",
        params: { ...validParams, networkContext: { ...network, channelFactoryAddress: "fail" } },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if there is no channelMastercopyAddress",
        params: { ...validParams, networkContext: { ...network, channelMastercopyAddress: undefined } },
        error: "should have required property 'channelMastercopyAddress'",
      },
      {
        name: "should fail if there is an invalid channelMastercopyAddress",
        params: { ...validParams, networkContext: { ...network, channelMastercopyAddress: "fail" } },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if there is no timeout",
        params: { ...validParams, timeout: undefined },
        error: "should have required property 'timeout'",
      },
      {
        name: "should fail if there is an invalid timeout",
        params: { ...validParams, timeout: "fail" },
        error: 'should match pattern "^([0-9])*$"',
      },
    ];
    for (const t of tests) {
      it(t.name, async () => {
        const ret = await vector.setup(t.params);
        expect(ret.isError).to.be.true;
        const error = ret.getError();
        expect(error?.message).to.be.eq(OutboundChannelUpdateError.reasons.InvalidParams);
        expect(error?.context?.errors).to.include(t.error);
      });
    }
  });
});

describe("Vector.deposit", () => {
  let vector: Vector;

  beforeEach(async () => {
    const signer = getRandomChannelSigner();

    vector = await Vector.connect(messagingService, lockService, storeService, signer, chainService, pino());
  });

  it("should work", async () => {
    const { details } = createTestUpdateParams(UpdateType.deposit);
    const result = await vector.deposit(details);
    expect(result.getError()).to.be.undefined;
    expect(lockService.acquireLock.callCount).to.be.eq(1);
    expect(lockService.releaseLock.callCount).to.be.eq(1);
  });

  describe("should validate parameters", () => {
    const validParams = {
      channelAddress: mkAddress("0xccc"),
      amount: "12039",
      assetAddress: mkAddress("0xaaa"),
    };

    const tests: ParamValidationTest[] = [
      {
        name: "should fail if channelAddress is undefined",
        params: { ...validParams, channelAddress: undefined },
        error: "should have required property 'channelAddress'",
      },
      {
        name: "should fail if channelAddress is invalid",
        params: { ...validParams, channelAddress: "fail" },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if assetAddress is undefined",
        params: { ...validParams, assetAddress: undefined },
        error: "should have required property 'assetAddress'",
      },
      {
        name: "should fail if assetAddress is invalid",
        params: { ...validParams, assetAddress: "fail" },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
    ];

    for (const { params, name, error } of tests) {
      it(name, async () => {
        const ret = await vector.deposit(params);
        expect(ret.isError).to.be.true;
        const err = ret.getError();
        expect(err?.message).to.be.eq(OutboundChannelUpdateError.reasons.InvalidParams);
        expect(err?.context?.errors).to.include(error);
      });
    }
  });
});

describe("Vector.create", () => {
  let vector: Vector;

  beforeEach(async () => {
    const signer = getRandomChannelSigner();

    vector = await Vector.connect(messagingService, lockService, storeService, signer, chainService, pino());
  });

  it("should work", async () => {
    const { details } = createTestUpdateParams(UpdateType.create);
    console.log("details", details);
    const result = await vector.create(details);
    expect(result.getError()).to.be.undefined;
    expect(lockService.acquireLock.callCount).to.be.eq(1);
    expect(lockService.releaseLock.callCount).to.be.eq(1);
  });

  describe("should validate parameters", () => {
    const validParams = {
      channelAddress: mkAddress("0xccc"),
      amount: "123214",
      assetAddress: mkAddress("0xaaa"),
      transferDefinition: mkAddress("0xdef"),
      transferInitialState: createTestLinkedTransferState(),
      timeout: "133215",
      encodings: [LinkedTransferStateEncoding, LinkedTransferResolverEncoding],
    };

    const tests: ParamValidationTest[] = [
      {
        name: "should fail if channelAddress is undefined",
        params: { ...validParams, channelAddress: undefined },
        error: "should have required property 'channelAddress'",
      },
      {
        name: "should fail if channelAddress is invalid",
        params: { ...validParams, channelAddress: "fail" },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if amount is undefined",
        params: { ...validParams, amount: undefined },
        error: "should have required property 'amount'",
      },
      {
        name: "should fail if amount is invalid",
        params: { ...validParams, amount: "fail" },
        error: 'should match pattern "^([0-9])*$"',
      },
      {
        name: "should fail if assetAddress is undefined",
        params: { ...validParams, assetAddress: undefined },
        error: "should have required property 'assetAddress'",
      },
      {
        name: "should fail if assetAddress is invalid",
        params: { ...validParams, assetAddress: "fail" },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if transferDefinition is undefined",
        params: { ...validParams, transferDefinition: undefined },
        error: "should have required property 'transferDefinition'",
      },
      {
        name: "should fail if transferDefinition is invalid",
        params: { ...validParams, transferDefinition: "fail" },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if transferInitialState is undefined",
        params: { ...validParams, transferInitialState: undefined },
        error: "should have required property 'transferInitialState'",
      },
      {
        name: "should fail if transferInitialState is invalid",
        params: { ...validParams, transferInitialState: {} },
        error:
          "should have required property 'balance',should have required property 'balance',should match exactly one schema in oneOf",
      },
      {
        name: "should fail if timeout is undefined",
        params: { ...validParams, timeout: undefined },
        error: "should have required property 'timeout'",
      },
      {
        name: "should fail if timeout is invalid",
        params: { ...validParams, timeout: "fail" },
        error: 'should match pattern "^([0-9])*$"',
      },
      {
        name: "should fail if encodings is undefined",
        params: { ...validParams, encodings: undefined },
        error: "should have required property 'encodings'",
      },
      {
        name: "should fail if encodings is invalid",
        params: { ...validParams, encodings: [] },
        error: "should match exactly one schema in oneOf",
      },
    ];

    for (const { params, name, error } of tests) {
      it(name, async () => {
        const ret = await vector.create(params);
        expect(ret.isError).to.be.true;
        const err = ret.getError();
        expect(err?.message).to.be.eq(OutboundChannelUpdateError.reasons.InvalidParams);
        expect(err?.context?.errors).to.include(error);
      });
    }
  });
});

describe("Vector.resolve", () => {
  let vector: Vector;

  beforeEach(async () => {
    const signer = getRandomChannelSigner();

    vector = await Vector.connect(messagingService, lockService, storeService, signer, chainService, pino());
  });

  it("should work", async () => {
    const { details } = createTestUpdateParams(UpdateType.resolve);
    const result = await vector.resolve(details);
    expect(result.getError()).to.be.undefined;
    expect(lockService.acquireLock.callCount).to.be.eq(1);
    expect(lockService.releaseLock.callCount).to.be.eq(1);
  });

  describe("should validate parameters", () => {
    const validParams = {
      channelAddress: mkAddress("0xccc"),
      transferId: mkBytes32("0xaaabbb"),
      transferResolver: {
        preImage: mkBytes32("0xeeeeffff"),
      },
    };

    const tests: ParamValidationTest[] = [
      {
        name: "should fail if channelAddress is undefined",
        params: { ...validParams, channelAddress: undefined },
        error: "should have required property 'channelAddress'",
      },
      {
        name: "should fail if channelAddress is invalid",
        params: { ...validParams, channelAddress: "fail" },
        error: 'should match pattern "^0x[a-fA-F0-9]{40}$"',
      },
      {
        name: "should fail if transferId is undefined",
        params: { ...validParams, transferId: undefined },
        error: "should have required property 'transferId'",
      },
      {
        name: "should fail if transferId is invalid",
        params: { ...validParams, transferId: "fail" },
        error: 'should match pattern "^0x([a-fA-F0-9]{64})$"',
      },
      {
        name: "should fail if transferResolver is undefined",
        params: { ...validParams, transferResolver: undefined },
        error: "should have required property 'transferResolver'",
      },
      {
        name: "should fail if transferResolver is invalid",
        params: { ...validParams, transferResolver: { test: "fail" } },
        error:
          "should have required property 'preImage',should have required property 'responderSignature',should match exactly one schema in oneOf",
      },
    ];

    for (const { params, name, error } of tests) {
      it(name, async () => {
        const ret = await vector.resolve(params);
        expect(ret.isError).to.be.true;
        const err = ret.getError();
        expect(err?.message).to.be.eq(OutboundChannelUpdateError.reasons.InvalidParams);
        expect(err?.context?.errors).to.include(error);
      });
    }
  });
});
