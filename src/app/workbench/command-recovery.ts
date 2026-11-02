/** Safe local guidance for a known recovery state, separate from unknown transport errors. */
export class CommandRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'CommandRecoveryError'; }
}
