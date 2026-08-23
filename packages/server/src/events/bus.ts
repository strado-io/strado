import { EventEmitter } from 'node:events';

export type BusEvent = { type: string; data: unknown };

export type EventBus = {
  emit(channel: string, evt: BusEvent): void;
  on(channel: string, listener: (evt: BusEvent) => void): () => void;
};

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    emit(channel, evt) {
      emitter.emit(channel, evt);
    },
    on(channel, listener) {
      emitter.on(channel, listener);
      return () => emitter.off(channel, listener);
    },
  };
}
