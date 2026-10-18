import { EventEmitter } from 'node:events';
import type { Level, RuleName } from './rules.js';

export interface DecisionEvent {
  accountId: number;
  userId: string;
  requestId: string;
  units: number;
  accepted: boolean;
  replayed: boolean;
  rejectedBy?: Level;
  rule?: RuleName;
}

export type DecisionListener = (event: DecisionEvent) => void;

export class DecisionEvents {
  private readonly emitter = new EventEmitter();

  subscribe(listener: DecisionListener): () => void {
    this.emitter.on('decision', listener);
    return () => this.emitter.off('decision', listener);
  }

  publish(event: DecisionEvent): void {
    for (const listener of this.emitter.listeners('decision') as DecisionListener[]) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }
}

export class DecisionCounters {
  accepted = 0;
  rejected = 0;
  replayed = 0;

  readonly listener: DecisionListener = (event) => {
    if (event.replayed) this.replayed += 1;
    else if (event.accepted) this.accepted += 1;
    else this.rejected += 1;
  };

  snapshot() {
    return { accepted: this.accepted, rejected: this.rejected, replayed: this.replayed };
  }
}
