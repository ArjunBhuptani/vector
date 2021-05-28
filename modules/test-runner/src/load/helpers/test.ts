import { delay, getRandomBytes32, RestServerNodeService } from "@connext/vector-utils";
import { constants } from "ethers";
import PriorityQueue from "p-queue";

import { env } from "../../utils";

import { config } from "./config";
import { AgentManager } from "./agent";
import { carolEvts, logger } from "./setupServer";

export const cyclicalTransferTest = async (): Promise<void> => {
  const agentService = await RestServerNodeService.connect(
    env.carolUrl,
    logger.child({ module: "RestServerNodeService" }),
    carolEvts,
    0,
  );
  const manager = await AgentManager.connect(agentService);
  // console.log(manager)

  const killSwitch = await manager.startCyclicalTransfers();

  setTimeout(async () => {
    logger.warn({}, "Killing test");
    await killSwitch();
    // wait 2s just in case
    await delay(2_000);
    process.exit(0);
  }, config.testDuration);
};

/**
 * Should create many transfers in a channel without ever
 * resolving them.
 */
export const channelBandwidthTest = async (): Promise<void> => {
  const agentService = await RestServerNodeService.connect(
    env.carolUrl,
    logger.child({ module: "RestServerNodeService" }),
    carolEvts,
    0,
  );
  const manager = await AgentManager.connect(agentService, false);

  const killSwitch = await manager.createMultipleTransfersWithSameParties();

  setTimeout(async () => {
    logger.warn({}, "Killing test");
    await killSwitch();
    process.exit(0);
  }, config.testDuration);
};

// Should create a bunch of transfers in the queue, with an
// increasing concurrency
export const concurrencyTest = async (): Promise<void> => {
  // Set test params
  const maxConcurrency = config.maxConcurrency;
  const queuedPayments = config.queuedPayments; // added to queue

  // Get agent manager
  let agentService: RestServerNodeService;
  try {
    agentService = await RestServerNodeService.connect(
      env.carolUrl,
      logger.child({ module: "AgentService" }),
      carolEvts,
    );
  } catch (e) {
    logger.error({ ...e }, "Failed to connect agent service");
    process.exit(1);
  }
  logger.info({ agentUrl: env.carolUrl }, "Agent service connected");
  let manager: AgentManager;
  try {
    manager = await AgentManager.connect(agentService);
  } catch (e) {
    logger.error({ ...e }, "Failed to connect manager service");
    process.exit(1);
  }

  // Preload manager with preImages + routingIds for payments
  const createPaymentData = () =>
    Array(queuedPayments)
      .fill(0)
      .map((_) => {
        const [routingId, preImage] = [getRandomBytes32(), getRandomBytes32()];
        manager.transferInfo[routingId] = { ...(manager.transferInfo[routingId] ?? {}), preImage };
        return [routingId, preImage];
      });

  // Create tasks to fill queue with (25 random payments)
  const createTasks = () => {
    const paymentData = createPaymentData();
    return Array(queuedPayments)
      .fill(0)
      .map((_, idx) => {
        return async () => {
          // Get random sender + receiver
          const sender = manager.getRandomAgent();
          const receiver = manager.getRandomAgent(sender);

          // Save payment secrets to manager before creating
          // payment
          const [routingId, preImage] = paymentData[idx];
          await sender.createHashlockTransfer(receiver.publicIdentifier, constants.AddressZero, preImage, routingId);
          // NOTE: receiver will automatically resolve
        };
      });
  };
  let concurrency = 1;
  for (const _ of Array(maxConcurrency).fill(0)) {
    // For loop runs one iteration of the test, with increasing
    // concurrency
    logger.info({ concurrency }, "Beginning concurrency test");
    // Create a queue
    const queue = new PriorityQueue({ concurrency });
    concurrency += 1;

    const promises = createTasks().map((t) => queue.add(t));

    await Promise.all(promises);
    logger.info({}, "Test complete, increasing concurrency");
  }
  logger.info({ concurrency: maxConcurrency, queuedPayments }, "Tests finished");
  process.exit(0);
};
