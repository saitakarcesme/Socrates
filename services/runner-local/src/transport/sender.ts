import type {
  RunnerEventAcknowledgementV1,
  RunnerEventSubmitResponseV1,
  RunnerEventV2,
  RunnerExecutionV1,
} from "@socrates/contracts";

export interface PendingEventSpool {
  pending(execution: RunnerExecutionV1): Promise<readonly RunnerEventV2[]>;
  acknowledge(
    execution: RunnerExecutionV1,
    acknowledgement: RunnerEventAcknowledgementV1,
  ): Promise<unknown>;
}

export interface RunnerEventTransport {
  submitEvent(
    event: RunnerEventV2,
    signal?: AbortSignal,
  ): Promise<RunnerEventSubmitResponseV1>;
}

export class RunnerDeliveryError extends Error {
  constructor(
    readonly code: "acknowledgement_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "RunnerDeliveryError";
  }
}

export type SendPendingEventResult =
  | { state: "idle" }
  | {
      state: "acknowledged";
      eventId: string;
      sequence: number;
      replay: boolean;
    };

function acknowledgementMatches(
  event: RunnerEventV2,
  response: RunnerEventSubmitResponseV1,
): boolean {
  const acknowledgement = response.acknowledgement;
  return (
    acknowledgement.eventId === event.eventId &&
    acknowledgement.attemptId === event.attemptId &&
    acknowledgement.acknowledgedSequence === event.sequence &&
    acknowledgement.expectedSequence === event.sequence + 1
  );
}

export class SequentialSpoolSender {
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly spool: PendingEventSpool,
    private readonly transport: RunnerEventTransport,
  ) {}

  sendNext(
    execution: RunnerExecutionV1,
    signal?: AbortSignal,
  ): Promise<SendPendingEventResult> {
    const operation = this.#operationTail.then(async () => {
      const event = (await this.spool.pending(execution))[0];
      if (!event) return { state: "idle" } as const;

      const response = await this.transport.submitEvent(event, signal);
      if (!acknowledgementMatches(event, response)) {
        throw new RunnerDeliveryError(
          "acknowledgement_mismatch",
          "The control-plane acknowledgement does not match the pending event.",
        );
      }
      await this.spool.acknowledge(execution, response.acknowledgement);
      return {
        state: "acknowledged",
        eventId: event.eventId,
        sequence: event.sequence,
        replay: response.replay,
      } as const;
    });
    this.#operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
