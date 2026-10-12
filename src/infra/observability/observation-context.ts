import { AsyncLocalStorage } from 'node:async_hooks';

export interface ObservationContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const observationStorage = new AsyncLocalStorage<ObservationContext>();

export function runWithObservationContext<T>(
  context: ObservationContext,
  callback: () => T,
): T {
  return observationStorage.run(context, callback);
}

export function getObservationContext(): ObservationContext | undefined {
  return observationStorage.getStore();
}

export function addObservationFields(
  fields: Partial<Omit<ObservationContext, 'correlationId'>>,
): void {
  const context = observationStorage.getStore();
  if (context) {
    Object.assign(context, fields);
  }
}
