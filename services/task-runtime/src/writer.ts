import {
  encodeRuntimeMessage,
  runtimeFrameSchema,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import type { Writable } from "node:stream";

import type { RuntimeFrameSink } from "./engine";
import { maximumRuntimeFrameBytes } from "./program";

export class NodeRuntimeFrameWriter implements RuntimeFrameSink {
  readonly #output: Writable;
  #pending = Promise.resolve();

  constructor(output: Writable) {
    this.#output = output;
  }

  write(frame: RuntimeFrame): void {
    const encoded = encodeRuntimeMessage(
      runtimeFrameSchema,
      frame,
      maximumRuntimeFrameBytes,
    );
    this.#pending = this.#pending.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.#output.write(encoded, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
  }

  async finish(): Promise<void> {
    await this.#pending;
  }
}
