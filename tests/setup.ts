const pgQueryQueueWarning =
  "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.";

const originalEmitWarning = process.emitWarning.bind(process) as (
  warning: string | Error,
  typeOrOptions?: string | NodeJS.EmitWarningOptions,
  code?: string,
  ctor?: (...args: unknown[]) => unknown,
) => void;

process.emitWarning = ((
  warning: string | Error,
  typeOrOptions?: string | NodeJS.EmitWarningOptions,
  code?: string,
  ctor?: (...args: unknown[]) => unknown,
) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeOrOptions?.type ?? (warning instanceof Error ? warning.name : undefined);

  if (type === "DeprecationWarning" && message === pgQueryQueueWarning) {
    return;
  }

  return originalEmitWarning(warning, typeOrOptions, code, ctor);
}) as typeof process.emitWarning;
