import { ProposalStatus } from '../db/types';

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: ProposalStatus,
    public readonly to: ProposalStatus,
  ) {
    super(`Invalid proposal state transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

const ALLOWED_TRANSITIONS: ReadonlyMap<ProposalStatus, readonly ProposalStatus[]> = new Map([
  ['RISK_CHECKING', ['RISK_REJECTED', 'PENDING_APPROVAL', 'EXPIRED', 'CANCELLED']],
  ['PENDING_APPROVAL', ['APPROVED', 'OWNER_REJECTED', 'EXPIRED', 'CANCELLED']],
  ['APPROVED', ['REVALIDATING', 'EXPIRED']],
  ['REVALIDATING', ['RISK_REJECTED_AFTER_APPROVAL', 'SUBMITTING', 'EXPIRED']],
  ['SUBMITTING', ['SUBMITTED', 'EXECUTION_ERROR']],
  ['SUBMITTED', ['PARTIALLY_FILLED', 'FILLED', 'EXECUTION_REJECTED', 'EXECUTION_ERROR', 'CANCEL_PENDING']],
  ['PARTIALLY_FILLED', ['FILLED', 'CANCEL_PENDING', 'EXECUTION_ERROR']],
  ['CANCEL_PENDING', ['CANCELLED', 'FILLED']],
  ['EXECUTION_ERROR', ['SUBMITTING', 'CANCELLED']],
]);

export function assertValidProposalTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!ALLOWED_TRANSITIONS.get(from)?.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
