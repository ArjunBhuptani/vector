import { utils, constants, providers, BigNumber} from "ethers";
import { getAddress } from "@ethersproject/address";
import {ChannelFactory} from '@connext/vector-contracts'
import {Contract} from "@ethersproject/contracts"
import { Wallet } from "@ethersproject/wallet";


import {env, fundIfBelow, getRandomIndex} from "../../utils";
import {
    DEFAULT_CHANNEL_TIMEOUT,
    EngineEvents,
    FullChannelState,
    INodeService,
    TransferNames
} from "@connext/vector-types";
import {getBalanceForAssetId, getRandomBytes32, RestServerNodeService} from "@connext/vector-utils";
import pino from "pino";
import {carolEvts} from "./setupServer";
import {
    chainId1, chainId2,
    deposit, provider2,
    setup,
    wallet1,
    wallet2,
} from "../../utils/channel";

import * as docker_api from './dockerNodeMgmt'
import {
    d_net_create,
    swarm_init,
    d_start_router,
    spawn_n_routers,
    start_messaging,
    test_process
} from "./dockerNodeMgmt";
const logger = pino({ level: env.logLevel });

//??is there a difference between doug and carol ?

const testName:string = 'Router Load Test'
const rogerURL:string = "http://localhost:8014"

let routers:RestServerNodeService[] = [];
let nodes:RestServerNodeService[] = [];

async function setupRoger() {
    const routerIndex = getRandomIndex();
    //verify below
    // const routerIndex = 0;
    const events = undefined;

    const roger = await RestServerNodeService.connect(
        rogerURL,
        logger.child({testName, name:"roger"}),
        events,
        routerIndex
    )
    //fund roger
    // Default collateral is 0.1 ETH
    const provider2 = new providers.JsonRpcProvider("https://goerli.infura.io/v3/af2f28bdb95d40edb06226a46106f5f9");
    const w = Wallet.fromMnemonic('program biology gasp gentle describe boring suspect raven favorite uphold salon crater').connect(provider2);

    return roger
}
async function setupNode() {
    const routerIndex = getRandomIndex();
    //verify below
    // const routerIndex = 0;
    const events = undefined;
    const min = utils.parseEther("0.1");


    const roger = await RestServerNodeService.connect(
        rogerURL,
        logger.child({testName, name:"carol"}),
        carolEvts,
        routerIndex
    )
    //fund roger
    // Default collateral is 0.1 ETH
    await fundIfBelow(roger.signerAddress, constants.AddressZero, min.mul(15), wallet1);
    if (wallet2) {
        await fundIfBelow(roger.signerAddress, constants.AddressZero, min.mul(15), wallet2);
    }

    return roger
}
async function createRouters(num_routers:number){
    for(let i = 0; i <= num_routers; i++){
        const roger = await setupRoger()
        routers.push(roger);
    }
    return routers;
}
//non router nodes
async function createNode(num_nodes:number){
    for(let i = 0; i <= num_nodes; i++){
        const carol = await setupNode()
        nodes.push(carol);
    }
    return nodes;
}
//get two roters to setup together
const getRandomEntity = async function(entityArr:RestServerNodeService[], num_entities:number){
    const randEntities = entityArr.map(x => ({ x, r: Math.random() }))
        .sort((a, b) => a.r - b.r)
        .map(a => a.x)
        .slice(0, num_entities);
    return randEntities;
}
const setupChannelsBetweenNodesAndRouter = async function(nodes:RestServerNodeService[], router:RestServerNodeService) {
    const assetId = constants.AddressZero;
    const depositAmt = utils.parseEther("1");

    for (let i = 0; i < nodes.length; i++) {
        const setup_res = await setup(nodes[i], router[0], chainId1)
        await deposit(nodes[i], router[0], setup_res.channelAddress, assetId, depositAmt)
    }
}
async function start(){

    const transferAmt = utils.parseEther("0.1");

    const num_routers = 5;
    const num_nodes = 10;

    await createRouters(num_routers);

    await createNode(num_nodes);

    const randomRouter:RestServerNodeService = await getRandomEntity(routers,1)[0];
    const randomNodes:RestServerNodeService[] = await getRandomEntity(nodes, 3);

    const res = await setupChannelsBetweenNodesAndRouter(randomNodes, randomRouter)

    //setup channel between all carols and the random node
}

// d_net_create()
// swarm_init()
// d_start_router()
// spawn_n_routers(1)

const start_stack = async()=>{
    const messaging = start_messaging.exec();
    const router_a = test_process.exec();
}

const r0Address = '0x36e6dEdC5554b2e1fedFb1627Be4D703f0da2B6D'
const r1Address = '0xE3E44bd168C03393d9Ef2E8B304686023E2ca233';
const daveAddress = '0xA383539Ae895Db1ABF4F6381eB082455366CF93c';
const carolAddress = '0x6D9B09e55e6341B019eB5CB05067d51cb058D788';

const g_provider = new providers.JsonRpcProvider("https://goerli.infura.io/v3/af2f28bdb95d40edb06226a46106f5f9");
const r_provider = new providers.JsonRpcProvider("https://rinkeby.infura.io/v3/af2f28bdb95d40edb06226a46106f5f9");

const getBalances = async function(provider){
    const addressesToCheck = [r0Address,r1Address,daveAddress,carolAddress];

    let allAddressesHaveETH = true;
    for(let i=0; i<addressesToCheck.length; i++) {
        const bal = await g_provider.getBalance(addressesToCheck[i])
        if (bal.toString() === "0")
        {
            //compare balance to 0
            allAddressesHaveETH = false;
        }
        console.log(bal.toString())
    }
    return allAddressesHaveETH;
}
const carolNodeURL = '8004'
const daveNodeURL = '8005'
const r0NodeUrl = '8002'
const r1Nodeurl = '8014'

const timeout = (ms)=> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export const dynamicDeposit = async (
    depositor: INodeService,
    counterparty: INodeService,
    channelAddress: string,
    assetId: string,
    amount: BigNumber,
    provider: providers.Provider

): Promise<FullChannelState> => {
    const channelRes = await depositor.getStateChannel({ channelAddress });
    const channel = channelRes.getValue()! as FullChannelState;

    const chainId = await provider.getNetwork().then((p)=>{return p.chainId})

    //get depositor balance of asset
    const beforeDepositBalance = (channel:FullChannelState, assetId:string)=>{
        const assetIdx = channel.assetIds.findIndex((a) => getAddress(a) === getAddress(assetId));
        if (assetIdx === -1) {
            return "0";
        }
        //todo: should we be looking for 0 or 1?
        // return channel.balances[assetIdx].amount[participant === "alice" ? 0 : 1];
        return channel.balances[assetIdx].amount[1];
    }

    const beforeDepositBal = beforeDepositBalance(channel,assetId);

    console.log("doing a deposit for ", depositor.signerAddress)
    const tx = await depositor.sendDepositTx({
        amount: amount.toString(),
        assetId,
        chainId: chainId,
        channelAddress,
        publicIdentifier: depositor.publicIdentifier
    })

    const tx_receipt = await provider.waitForTransaction(tx.getValue().txHash)
    console.log("TX RECEIPT :", tx_receipt);

    const depositRes = await depositor.reconcileDeposit({
        assetId,
        channelAddress: channel.channelAddress,
        publicIdentifier: depositor.publicIdentifier,
    });

    console.log("Dep RES :", depositRes.getValue()!);

    const depositorChannel = (
        await depositor.getStateChannel({
            channelAddress: channel.channelAddress,
            publicIdentifier: depositor.publicIdentifier,
        })
    ).getValue()! as FullChannelState;

    const counterpartyChannel = (
        await counterparty.getStateChannel({
            channelAddress: channel.channelAddress,
            publicIdentifier: counterparty.publicIdentifier,
        })
    ).getValue()!;


    return depositorChannel

}

const main = async function(){

    const participantsHaveETH = await getBalances(g_provider)
    if(!participantsHaveETH){return;}

    const urlBase = "http://localhost:"

    const net = await g_provider.getNetwork()
    const chainId = net.chainId;

    const carolService = await RestServerNodeService.connect(
        urlBase + carolNodeURL,
        logger.child({testName, name:"Carol"}),
        undefined,
        1)

    const daveService = await RestServerNodeService.connect(
        urlBase + daveNodeURL,
        logger.child({testName, name:"Dave"}),
        undefined,
        1)

    const r0Service = await RestServerNodeService.connect(
        urlBase + r0NodeUrl,
        logger.child({ testName, name: "Roger" }),
        undefined,
        1)

    const carolSetup = await carolService.setup({
        counterpartyIdentifier: r0Service.publicIdentifier,
        chainId,
        timeout: DEFAULT_CHANNEL_TIMEOUT.toString()
    });

    const daveSetup = await daveService.setup({
        counterpartyIdentifier: r0Service.publicIdentifier,
        chainId: 4,
        timeout: DEFAULT_CHANNEL_TIMEOUT.toString()
    })

    const carolChannel = carolSetup.getValue();
    const daveChannel = daveSetup.getValue();

    //get carol's channel with self?
    const carolChan = await r0Service.getStateChannel({
        channelAddress: carolChannel.channelAddress,
        publicIdentifier: carolService.publicIdentifier,
    });

    // r0Service.getStateChannelByParticipants()
    const routerChan = await r0Service.getStateChannel({
        channelAddress: carolChannel.channelAddress,
        publicIdentifier: r0Service.publicIdentifier
    })

    const daveChan = await r0Service.getStateChannel({
        channelAddress: daveChannel.channelAddress,
        publicIdentifier: r0Service.publicIdentifier
    })

    //carol and router chan should deep euqal
    const carolSetupRes = routerChan.getValue()! as FullChannelState;
    const daveSetupRes = daveChan.getValue()! as FullChannelState;

    console.log("ROUTER CHAN ", carolSetupRes)

    const depositAmt = utils.parseEther(".1");

    const assetId = constants.AddressZero;

    const tx = await carolService.sendDepositTx({
        amount: depositAmt.toString(),
        assetId,
        chainId: chainId,
        channelAddress: carolChannel.channelAddress,
        publicIdentifier: carolService.publicIdentifier,
    })

    const tx_wait = g_provider.waitForTransaction(tx.getValue().txHash)
    console.log("DEPOSIT TX ", tx_wait)

    const depositRes = await carolService.reconcileDeposit({
        assetId,
        channelAddress: carolSetupRes.channelAddress,
        publicIdentifier: carolService.publicIdentifier,
    })

    const deposit = await depositRes.getValue()

    console.log("DEPOSIT RECON RES ", deposit)

    const preImage = getRandomBytes32();
    const lockHash = utils.soliditySha256(["bytes32"], [preImage]);

    const transferRes = await carolService.conditionalTransfer({
        amount: depositAmt.toString(),
        assetId: assetId,
        channelAddress: carolSetupRes.channelAddress,
        type: TransferNames.HashlockTransfer,
        details: {
            lockHash,
            expiry: "0",
        },
        recipient: daveService.publicIdentifier,
        recipientChainId: 4
    })

    console.log("Transfer Result Context", transferRes.getError()?.context.context)


    //get tx event
    // daveService.resolveTransfer(... lockHash)



}

async function run_all(){
    await start_stack();
    await timeout(45000)
    await main()
}
// start_stack()
// start_stack()

main()