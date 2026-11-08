import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import type { JobStarter } from "../ports";

/** Starts one Standard execution per job ID; a repeated start with the same name is a no-op. */
export class StepFunctionsJobStarter implements JobStarter {
  constructor(
    private readonly client: SFNClient,
    private readonly stateMachineArn: string,
  ) {}
  async start(input: {
    jobId: string;
    owner: string;
    dayId: string;
    inputRevision: number;
  }): Promise<void> {
    try {
      await this.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.stateMachineArn,
          name: input.jobId,
          // References only: no image, calendar or user text enters execution history.
          input: JSON.stringify({
            schemaVersion: 1,
            jobId: input.jobId,
            owner: input.owner,
            dayId: input.dayId,
            inputRevision: input.inputRevision,
          }),
        }),
      );
    } catch (error) {
      if (error instanceof ExecutionAlreadyExists) return;
      throw error;
    }
  }
}
