import { SerializedQueue, SelfUpdate, OtherUpdate } from "../queue";
import { Result } from "@connext/vector-types";
import { getNextNonceForUpdate } from "../utils";
import { expect, delay } from "@connext/vector-utils";

type FakeUpdate = { nonce: number };

type Delayed = { __test_queue_delay__: number; error?: boolean };
type DelayedSelfUpdate = SelfUpdate & Delayed;
type DelayedOtherUpdate = OtherUpdate & Delayed;

class DelayedUpdater {
  readonly state: ["self" | "other", FakeUpdate][] = [];
  readonly isAlice: boolean;
  readonly initialUpdate: FakeUpdate;

  reentrant = false;

  constructor(isAlice: boolean, initialUpdate: FakeUpdate) {
    this.isAlice = isAlice;
    this.initialUpdate = initialUpdate;
  }

  // Asserts that the function is not re-entrant with itself or other invocations.
  // This verifies the "Serialized" in "SerializedQueue".
  private async notReEntrant<T>(f: () => Promise<T>): Promise<T> {
    expect(this.reentrant).to.be.false;
    this.reentrant = true;
    let result;
    try {
      result = await f();
    } finally {
      expect(this.reentrant).to.be.true;
      this.reentrant = false;
    }

    return result;
  }

  currentNonce(): number {
    if (this.state.length == 0) {
      return this.initialUpdate.nonce;
    }
    return this.state[this.state.length - 1][1].nonce;
  }

  private isCancelledAsync(cancel: Promise<unknown>, _delay: Delayed): Promise<boolean> {
    if (_delay.error) {
      throw new Error("Delay error");
    }
    return Promise.race([
      (async () => {
        await delay(_delay.__test_queue_delay__);
        return false;
      })(),
      (async () => {
        await cancel;
        return true;
      })(),
    ]);
  }

  selfUpdateAsync(value: SelfUpdate, cancel: Promise<unknown>): Promise<Result<void> | undefined> {
    return this.notReEntrant(async () => {
      if (await this.isCancelledAsync(cancel, value as DelayedSelfUpdate)) {
        return undefined;
      }
      let nonce = getNextNonceForUpdate(this.currentNonce(), this.isAlice);
      this.state.push(["self", { nonce }]);
      return Result.ok(undefined);
    });
  }

  otherUpdateAsync(value: OtherUpdate, cancel: Promise<unknown>): Promise<Result<void> | undefined> {
    return this.notReEntrant(async () => {
      if (value.update.nonce !== getNextNonceForUpdate(this.currentNonce(), !this.isAlice)) {
        return Result.fail({ name: "WrongNonce", message: "WrongNonce" });
      }

      if (await this.isCancelledAsync(cancel, value as DelayedOtherUpdate)) {
        return undefined;
      }

      this.state.push(["other", { nonce: value.update.nonce }]);
      return Result.ok(undefined);
    });
  }
}

function setup(initialUpdateNonce: number = 0, isAlice: boolean = true): [DelayedUpdater, SerializedQueue] {
  let updater = new DelayedUpdater(isAlice, { nonce: initialUpdateNonce });
  let queue = new SerializedQueue(
    isAlice,
    updater.selfUpdateAsync.bind(updater),
    updater.otherUpdateAsync.bind(updater),
    async () => updater.currentNonce(),
  );
  return [updater, queue];
}

function selfUpdate(delay: number): DelayedSelfUpdate {
  const delayed: Delayed = {
    __test_queue_delay__: delay,
  };
  return (delayed as unknown) as DelayedSelfUpdate;
}

function otherUpdate(delay: number, nonce: number): DelayedOtherUpdate {
  const delayed: Delayed & { update: FakeUpdate } = {
    __test_queue_delay__: delay,
    update: { nonce },
  };
  return (delayed as unknown) as DelayedOtherUpdate;
}

describe("Simple Updates", () => {
  it("Can update self when not interrupted and is the leader", async () => {
    let [updater, queue] = setup();
    let result = await queue.executeSelfAsync(selfUpdate(2));
    expect(result?.isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["self", { nonce: 1 }]]);
  });
  it("Can update self when not interrupted and is not the leader", async () => {
    let [updater, queue] = setup(1);
    let result = await queue.executeSelfAsync(selfUpdate(2));
    expect(result?.isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["self", { nonce: 4 }]]);
  });
  it("Can update other when not interrupted and is not the leader", async () => {
    let [updater, queue] = setup();
    let result = await queue.executeOtherAsync(otherUpdate(2, 2));
    expect(result?.isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["other", { nonce: 2 }]]);
  });
  it("Can update other when not interrupted and is the leader", async () => {
    let [updater, queue] = setup(1);
    let result = await queue.executeOtherAsync(otherUpdate(2, 2));
    expect(result?.isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["other", { nonce: 2 }]]);
  });
});

describe("Interruptions", () => {
  it("Re-applies own update after interruption", async () => {
    let [updater, queue] = setup();
    // Create an update with a delay of 10 ms
    let resultSelf = (async () => {
      await queue.executeSelfAsync(selfUpdate(10));
      return "self";
    })();
    // Wait 5 ms, then interrupt
    await delay(5);
    // Queue the other update, which will take longer.
    let resultOther = (async () => {
      await queue.executeOtherAsync(otherUpdate(15, 2));
      return "other";
    })();

    // See that the other update finishes first, and that it's promise completes first.
    let first = await Promise.race([resultSelf, resultOther]);
    expect(first).to.be.equal("other");
    expect(updater.state).to.be.deep.equal([["other", { nonce: 2 }]]);

    // See that our own update completes after.
    await resultSelf;
    expect(updater.state).to.be.deep.equal([
      ["other", { nonce: 2 }],
      ["self", { nonce: 4 }],
    ]);
  });
  it("Discards other update after interruption", async () => {
    let [updater, queue] = setup(2);
    let resultOther = queue.executeOtherAsync(otherUpdate(10, 3));
    await delay(5);
    let resultSelf = queue.executeSelfAsync(selfUpdate(5));

    expect((await resultOther).isError).to.be.true;
    expect((await resultSelf).isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["self", { nonce: 4 }]]);
  });
  it("Does not interrupt self for low priority other update", async () => {
    let [updater, queue] = setup(2);
    let resultSelf = queue.executeSelfAsync(selfUpdate(10));
    await delay(5);
    let resultOther = queue.executeOtherAsync(otherUpdate(5, 3));

    expect((await resultOther).isError).to.be.true;
    expect((await resultSelf).isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["self", { nonce: 4 }]]);
  });
  it("Does not interrupt for low priority self update", async () => {
    let [updater, queue] = setup();
    // Create an update with a delay of 10 ms
    // Queue the other update, which will take longer.
    let resultOther = (async () => {
      await queue.executeOtherAsync(otherUpdate(10, 2));
      return "other";
    })();
    // Wait 5 ms, then interrupt
    await delay(5);
    let resultSelf = (async () => {
      await queue.executeSelfAsync(selfUpdate(15));
      return "self";
    })();

    // See that the other update finishes first, and that it's promise completes first.
    let first = await Promise.race([resultSelf, resultOther]);
    expect(first).to.be.equal("other");
    expect(updater.state).to.be.deep.equal([["other", { nonce: 2 }]]);

    // See that our own update completes after.
    await resultSelf;
    expect(updater.state).to.be.deep.equal([
      ["other", { nonce: 2 }],
      ["self", { nonce: 4 }],
    ]);
  });
});

describe("Sequences", () => {
  it("Resolves promises at moment of resolution", async () => {
    let [updater, queue] = setup();
    for (let i = 0; i < 5; i++) {
      queue.executeSelfAsync(selfUpdate(0));
    }
    let sixth = queue.executeSelfAsync(selfUpdate(0));
    for (let i = 0; i < 3; i++) {
      queue.executeSelfAsync(selfUpdate(0));
    }
    let ninth = queue.executeSelfAsync(selfUpdate(0));
    expect((await sixth).isError).to.be.false;
    expect(updater.state).to.be.deep.equal([
      ["self", { nonce: 1 }],
      ["self", { nonce: 4 }],
      ["self", { nonce: 5 }],
      ["self", { nonce: 8 }],
      ["self", { nonce: 9 }],
      ["self", { nonce: 12 }],
    ]);
    expect((await ninth).isError).to.be.false;
    expect(updater.state).to.be.deep.equal([
      ["self", { nonce: 1 }],
      ["self", { nonce: 4 }],
      ["self", { nonce: 5 }],
      ["self", { nonce: 8 }],
      ["self", { nonce: 9 }],
      ["self", { nonce: 12 }],
      ["self", { nonce: 13 }],
      ["self", { nonce: 16 }],
      ["self", { nonce: 17 }],
      ["self", { nonce: 20 }],
    ]);
  });
});

describe("Errors", () => {
  it("Propagates errors", async () => {
    let [updater, queue] = setup();
    let first = queue.executeSelfAsync(selfUpdate(0));
    let throwing = selfUpdate(0);
    throwing.error = true;
    let throws = queue.executeSelfAsync(throwing);
    let second = queue.executeSelfAsync(selfUpdate(0));

    expect((await first).isError).to.be.false;
    expect(updater.state).to.be.deep.equal([["self", { nonce: 1 }]]);

    let reached = false;
    try {
      await throws;
      reached = true;
    } catch (err) {
      expect(err.message).to.be.equal("Delay error");
    }
    expect(reached).to.be.false;
    expect(updater.state).to.be.deep.equal([["self", { nonce: 1 }]]);

    await second;

    expect(updater.state).to.be.deep.equal([
      ["self", { nonce: 1 }],
      ["self", { nonce: 4 }],
    ]);
  });

  it("Gracefully handles timeout", async () => {
    let [updater, queue] = setup();

    // This update takes 50ms - too long!
    let willTimeout = queue.executeOtherAsync(otherUpdate(50, 2));
    // Timeout
    await delay(5);
    // Assume (wrongly) it's ok to make another update. Same nonce.
    let attemptToConflict = queue.executeOtherAsync(otherUpdate(5, 2));

    // We can await these in any order. The original update succeeds,
    // the conflicting nonce fails due to validation..
    expect((await willTimeout).isError).to.be.false;
    expect((await attemptToConflict).isError).to.be.true;

    // Shows only one succeeded because if not we would see two updates with
    // the same nonce here.
    expect(updater.state).to.be.deep.equal([
      ["other", { nonce: 2 }],
    ]);
  });
});
