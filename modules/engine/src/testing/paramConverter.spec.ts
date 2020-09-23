import { ChainAddresses, ConditionalTransferParams, ConditionalTransferType, ContractAddresses, CreateTransferParams, DEFAULT_TRANSFER_TIMEOUT, FullChannelState, FullTransferState, LinkedTransferParams, LinkedTransferResolver, LinkedTransferResolverEncoding, LinkedTransferStateEncoding, ResolveConditionParams, ResolveTransferParams } from "@connext/vector-types";
import { convertConditionalTransferParams, convertResolveConditionParams } from "../paramConverter";
import { env } from "./env";

import { createTestChannelState, createTestFullLinkedTransferState, getRandomBytes32, mkAddress, mkHash, stringify } from "@connext/vector-utils";
import { expect } from "chai";
import { InvalidTransferType } from "../errors";

describe.only("ParamConverter", () => {
    const chainId = parseInt(Object.keys(env.chainProviders)[0]);
    const providerUrl = env.chainProviders[chainId];
    const chainAddresses = env.chainAddresses[chainId]
    const contractAddresses: ChainAddresses = {
        [chainId]: {
            channelFactoryAddress: chainAddresses.ChannelFactory.address,
            channelMastercopyAddress: chainAddresses.ChannelMastercopy.address,
            linkedTransferDefinition: chainAddresses.LinkedTransfer.address,
            withdrawDefinition: chainAddresses.Withdraw.address
        }
    }
    describe("convertConditionalTransferParams", () => {
        const generateParams = (): ConditionalTransferParams<"LinkedTransfer"> => {
            return {
                channelAddress: mkAddress("0xa"),
                amount: "8",
                assetId: mkAddress("0x0"),
                recipient: mkAddress("0xb"),
                conditionType: ConditionalTransferType.LinkedTransfer,
                routingId: mkHash("0xtest"),
                details: {
                    linkedHash: getRandomBytes32()
                } as LinkedTransferParams,
                meta: {
                    message: "test"
                }
            }
        }

        it("should work", async () => {
            const params = generateParams()
            const channelState: FullChannelState = createTestChannelState("setup", {
                channelAddress: params.channelAddress,
                networkContext: {
                    ...contractAddresses[chainId],
                    chainId,
                    providerUrl
                }
            });
            const ret: CreateTransferParams = (convertConditionalTransferParams(params, channelState)).getValue()
            expect(ret).to.deep.eq({
                channelAddress: channelState.channelAddress,
                amount: params.amount,
                assetId: params.assetId,
                transferDefinition: channelState.networkContext.linkedTransferDefinition,
                transferInitialState: {
                    balance: {
                        amount: [params.amount, "0"],
                        to: channelState.participants
                    },
                    linkedHash: params.details.linkedHash
                },
                timeout: DEFAULT_TRANSFER_TIMEOUT.toString(),
                encodings: [LinkedTransferStateEncoding, LinkedTransferResolverEncoding],
                meta: {
                    routingId: params.routingId,
                    recipient: params.recipient,
                    meta: params.meta
                }
            })
        })

        it("should fail if invalid type", async () => {
            let params = generateParams()
            // Set incorrect type
            //@ts-ignore
            params.conditionType = "FailingTest";
            const channelState: FullChannelState = createTestChannelState("setup", {
                channelAddress: params.channelAddress,
                networkContext: {
                    ...contractAddresses[chainId],
                    chainId,
                    providerUrl
                }
            });
            const ret = convertConditionalTransferParams(params, channelState)
            expect(ret.isError).to.be.true;
            expect(ret.getError()).to.contain(new InvalidTransferType(params.conditionType))
        })
    })

    describe("convertResolveConditionParams", () => {
        const generateParams = (): ResolveConditionParams<"LinkedTransfer"> => {
            return {
                channelAddress: mkAddress("0xa"),
                conditionType: ConditionalTransferType.LinkedTransfer,
                routingId: mkHash("0xtest"),
                details: {
                    preImage: getRandomBytes32()
                } as LinkedTransferResolver,
                meta: {
                    message: "test"
                }
            }
        }

        it("should work", async () => {
            const params = generateParams()
            const transferState: FullTransferState = createTestFullLinkedTransferState({
                channelAddress: params.channelAddress,
            });
            const ret: ResolveTransferParams = (convertResolveConditionParams(params, transferState)).getValue();
            expect(ret).to.deep.eq({
                channelAddress: params.channelAddress,
                transferId: transferState.transferId,
                transferResolver: {
                    preImage: params.details.preImage
                },
                meta: {
                    routingId: params.routingId,
                    meta: params.meta
                }
            })
        })

        it("should fail if invalid type", async () => {
            let params = generateParams()
            // Set incorrect type
            //@ts-ignore
            params.conditionType = "FailingTest";
            const transferState: FullTransferState = createTestFullLinkedTransferState({
                channelAddress: params.channelAddress,
            });
            const ret = convertResolveConditionParams(params, transferState)
            expect(ret.isError).to.be.true;
            expect(ret.getError()).to.contain(new InvalidTransferType(params.conditionType))
        })
    })

    describe("convertWithdrawParams", () => {
        const generateParams = () => {
            return {
                channelAddress: mkAddress("0xa"),
                amount: "8",
                assetId: mkAddress("0x0"),
                recipient: mkAddress("0xb"),
            }
        }

        it.skip("should work", () => {
            const params = generateParams();

        })
    })
})