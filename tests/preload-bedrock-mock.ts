import { mock } from "bun:test";

export interface BedrockMockState {
  config: unknown;
  commands: { input?: unknown }[];
  fail?: string;
}

const state: BedrockMockState = { config: undefined, commands: [] };
(globalThis as { __bedrockMock?: BedrockMockState }).__bedrockMock = state;

mock.module("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    constructor(config: unknown) {
      state.config = config;
      state.commands = [];
    }
    async send(command: { input?: unknown }) {
      state.commands.push(command);
      if (state.fail) {
        const message = state.fail;
        delete state.fail;
        throw new Error(message);
      }
      if (command?.constructor?.name === "ConverseStreamCommand") {
        return {
          stream: [
            { contentBlockDelta: { delta: { text: "ok" } } },
            { messageStop: { stopReason: "end_turn" } }
          ]
        };
      }
      return {
        stopReason: "end_turn",
        output: { message: { role: "assistant", content: [{ text: "ok" }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    }
  }
  class ConverseCommand {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  }
  class ConverseStreamCommand {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});
