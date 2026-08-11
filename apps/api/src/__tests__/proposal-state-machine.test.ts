import { describe, expect, it } from 'vitest';
import {
  assertValidProposalTransition,
  InvalidStateTransitionError,
} from '../services/proposal-state-machine';

describe('proposal state machine', () => {
  it('allows Phase 8 creation transitions', () => {
    expect(() => assertValidProposalTransition('RISK_CHECKING', 'PENDING_APPROVAL')).not.toThrow();
    expect(() => assertValidProposalTransition('RISK_CHECKING', 'RISK_REJECTED')).not.toThrow();
  });

  it('allows pre-approval cancellation', () => {
    expect(() => assertValidProposalTransition('PENDING_APPROVAL', 'CANCELLED')).not.toThrow();
  });

  it('rejects approval transitions in Phase 8', () => {
    expect(() => assertValidProposalTransition('PENDING_APPROVAL', 'APPROVED')).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('rejects terminal-state cancellation', () => {
    expect(() => assertValidProposalTransition('RISK_REJECTED', 'CANCELLED')).toThrow(
      InvalidStateTransitionError,
    );
  });
});
