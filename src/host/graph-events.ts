import { EventEmitter } from "node:events";
import type { Entity, Edge } from "./graph-engine.js";

export type GraphEvents = {
  "entity:created": [entity: Entity];
  "entity:updated": [entity: Entity];
  "entity:invalidated": [entityId: string];
  "edge:created": [edge: Edge];
  "edge:updated": [edge: Edge];
  "edge:invalidated": [edgeId: string];
  "communities:detected": [communityCount: number];
  // S8 observability events
  "search:executed": [mode: string, resultCount: number, cached: boolean];
  "context:packed": [tokens: number, budget: number];
  "proposal:created": [proposalId: string, targetEntityId: string];
  "proposal:resolved": [proposalId: string, decision: "approved" | "rejected"];
};

export class GraphEventEmitter extends EventEmitter {
  emit<K extends keyof GraphEvents>(event: K, ...args: GraphEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof GraphEvents>(event: K, listener: (...args: GraphEvents[K]) => void): this {
    return super.on(event, listener);
  }

  off<K extends keyof GraphEvents>(event: K, listener: (...args: GraphEvents[K]) => void): this {
    return super.off(event, listener);
  }
}
