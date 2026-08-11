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

  it('allows owner approval and rejection transitions', () => {
    expect(() => assertValidProposalTransition('PENDING_APPROVAL', 'APPROVED')).not.toThrow();
    expect(() => assertValidProposalTransition('PENDING_APPROVAL', 'OWNER_REJECTED')).not.toThrow();
  });

  it('rejects terminal-state cancellation', () => {
    expect(() => assertValidProposalTransition('RISK_REJECTED', 'CANCELLED')).toThrow(
      InvalidStateTransitionError,
    );
  });
});
