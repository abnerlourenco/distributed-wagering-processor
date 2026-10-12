import type { LoggerService, LogLevel } from '@nestjs/common';
import { getObservationContext } from './observation-context.js';

export type StructuredLogWriter = (
  stream: 'stdout' | 'stderr',
  line: string,
) => void;

export class StructuredLogger implements LoggerService {
  private enabledLevels = new Set<LogLevel>([
    'verbose',
    'debug',
    'log',
    'warn',
    'error',
    'fatal',
  ]);

  constructor(
    private readonly writer: StructuredLogWriter = (stream, line) => {
      if (stream === 'stderr') {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    },
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.enabledLevels = new Set(levels);
  }

  private write(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.enabledLevels.has(level)) {
      return;
    }

    const context = getObservationContext();
    const loggerContext = optionalParams.findLast(
      (parameter): parameter is string => typeof parameter === 'string',
    );
    const safeMessage =
      message instanceof Error
        ? `${message.name}: operation failed`
        : typeof message === 'string'
          ? message.slice(0, 500)
          : 'Structured application log';
    const record = {
      timestamp: new Date().toISOString(),
      level,
      context: loggerContext ?? 'Application',
      message: safeMessage,
      correlationId: context?.correlationId ?? null,
      messageId: context?.messageId ?? null,
      transactionId: context?.transactionId ?? null,
      walletId: context?.walletId ?? null,
      providerId: context?.providerId ?? null,
    };
    this.writer(
      level === 'error' || level === 'fatal' ? 'stderr' : 'stdout',
      `${JSON.stringify(record)}\n`,
    );
  }
}
