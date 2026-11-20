import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { AgentEventChannels } from "../src/agent/events";
import { ToolRegistry } from "../src/tools/registry";
import { AgentEventType, AgentStatus } from "../src/types/agent";
import type { ContextManager, PreparedContext } from "../src/types/context";
import type { Model } from "../src/types/model";

const stepStart = {
  type: AgentEventType.StepStart,
  step: 1,
} as const;

describe("agent event channels", () => {
  test("interceptors run serially, can rewrite, then observers see the result", async () => {
    const channels = new AgentEventChannels();
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    channels.intercept(async (event) => {
      order.push("first:start");
      await gate;
      order.push("first:end");
      return { ...event, step: 2 };
    });
    channels.intercept((event) => {
      const step = event.type === AgentEventType.StepStart ? event.step : -1;
      order.push(`second:${step}`);
      return event;
    });
    channels.subscribe((event) => {
      const step = event.type === AgentEventType.StepStart ? event.step : -1;
      order.push(`observer:${step}`);
    });

    const dispatch = channels.emit(stepStart);
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    release();
    await dispatch;
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:2",
      "observer:2",
    ]);
  });

  test("the first block wins and skips later interceptors and observers", async () => {
    const channels = new AgentEventChannels();
    const calls: string[] = [];

    channels.intercept(() => {
      calls.push("blocking");
      return { kind: "block", reason: "policy" };
    });
    channels.intercept(() => {
      calls.push("later");
      return stepStart;
    });
    channels.subscribe(() => {
      calls.push("observer");
    });

    await channels.emit(stepStart);
    expect(calls).toEqual(["blocking"]);
  });

  test("observer errors are logged, non-blocking, and never propagated", async () => {
    const errors: unknown[] = [];
    const channels = new AgentEventChannels({
      onError: (error) => errors.push(error),
    });
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    channels.subscribe(() => {
      throw new Error("sync observer");
    });
    channels.subscribe(async () => {
      await gate;
      order.push("late");
      throw new Error("async observer");
    });

    await channels.emit(stepStart);
    expect(order).toEqual([]);
    expect(errors.map((error) => (error as Error).message)).toContain(
      "sync observer",
    );

    release();
    await gate;
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["late"]);
    expect(errors.map((error) => (error as Error).message)).toContain(
      "async observer",
    );
  });

  test("handlers added mid-dispatch affect only later dispatches", async () => {
    const channels = new AgentEventChannels();
    const calls: string[] = [];
    const late = (): void => {
      calls.push("late");
    };

    channels.intercept((event) => {
      channels.subscribe(late);
      return event;
    });
    channels.subscribe(() => {
      calls.push("first");
    });

    await channels.emit(stepStart);
    expect(calls).toEqual(["first"]);

    await channels.emit(stepStart);
    expect(calls).toEqual(["first", "first", "late"]);
  });

  test("subscribe and intercept both return idempotent unsubscribe functions", async () => {
    const channels = new AgentEventChannels();
    const calls: string[] = [];
    const unsubscribeObserver = channels.subscribe(() => {
      calls.push("observer");
    });
    const unsubscribeInterceptor = channels.intercept((event) => {
      calls.push("interceptor");
      return event;
    });

    unsubscribeObserver();
    unsubscribeObserver();
    unsubscribeInterceptor();
    unsubscribeInterceptor();
    await channels.emit(stepStart);
    expect(calls).toEqual([]);
  });

  test("Agent awaits interceptors before completing a run", async () => {
    const model: Model = {
      async generate() {
        return { text: "done", toolCalls: [] };
      },
    };
    const context: ContextManager = {
      async prepare({ messages }): Promise<PreparedContext> {
        return { messages: [...messages], compacted: false, tokensEstimated: 1 };
      },
      observe() {},
    };
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new Agent({
      model,
      instructions: "",
      tools: new ToolRegistry([]),
      context,
      cwd: process.cwd(),
      interceptors: [
        async (event) => {
          if (event.type === AgentEventType.Stop) {
            await gate;
            order.push("intercepted-stop");
          }
          return event;
        },
      ],
    });
    agent.subscribe((event) => {
      if (event.type === AgentEventType.Stop) order.push("observed-stop");
    });

    const run = agent.run("hello");
    await Promise.resolve();
    expect(order).toEqual([]);

    release();
    const result = await run;
    expect(result.status).toBe(AgentStatus.Completed);
    expect(order).toEqual(["intercepted-stop", "observed-stop"]);
  });
});
