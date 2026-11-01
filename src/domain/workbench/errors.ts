/** Stable domain errors; adapters translate these codes to their own transport. */
export class WorkbenchError extends Error {
  constructor(public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'WorkbenchError';
  }
}
