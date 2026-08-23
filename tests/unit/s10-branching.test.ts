import { describe, expect, it } from 'vitest';
import {
  evaluateBranch,
  validateBranchConfig,
} from '../../src/core/execution/branching.js';
import type { LeadBranchState, BranchableStep, LastMessageState } from '../../src/core/execution/branching.js';

function makeStep(overrides: Partial<BranchableStep> = {}): BranchableStep {
  return {
    branchOn: 'NONE',
    branchStepIndex: null,
    stepOrder: 0,
    delayHours: 24,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<LastMessageState> = {}): LastMessageState {
  return {
    status: 'SENT',
    sentAt: new Date('2026-08-20T10:00:00Z'),
    openedAt: null,
    clickedAt: null,
    repliedAt: null,
    ...overrides,
  };
}

// ─── evaluateBranch ───

describe('evaluateBranch', () => {
  it('returns null when branchOn is NONE', () => {
    const state: LeadBranchState = {
      lastMessage: makeMessage(),
      currentStep: makeStep({ branchOn: 'NONE', branchStepIndex: 2 }),
    };
    expect(evaluateBranch(state)).toBeNull();
  });

  it('returns null when no lastMessage', () => {
    const state: LeadBranchState = {
      lastMessage: null,
      currentStep: makeStep({ branchOn: 'OPENED', branchStepIndex: 2 }),
    };
    expect(evaluateBranch(state)).toBeNull();
  });

  describe('OPENED condition', () => {
    it('returns branchStepIndex when lead opened', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ openedAt: new Date('2026-08-21T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'OPENED', branchStepIndex: 3 }),
      };
      expect(evaluateBranch(state)).toBe(3);
    });

    it('returns branchStepIndex when lead clicked (implies opened)', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ clickedAt: new Date('2026-08-21T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'OPENED', branchStepIndex: 3 }),
      };
      expect(evaluateBranch(state)).toBe(3);
    });

    it('returns branchStepIndex when lead replied (implies opened)', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ repliedAt: new Date('2026-08-21T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'OPENED', branchStepIndex: 3 }),
      };
      expect(evaluateBranch(state)).toBe(3);
    });

    it('returns null when lead didn\'t open', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage(),
        currentStep: makeStep({ branchOn: 'OPENED', branchStepIndex: 3 }),
      };
      expect(evaluateBranch(state)).toBeNull();
    });
  });

  describe('NOT_OPENED condition', () => {
    it('returns branchStepIndex when not opened and delay elapsed', () => {
      const now = new Date('2026-08-22T10:00:00Z');
      const state: LeadBranchState = {
        lastMessage: makeMessage({ sentAt: new Date('2026-08-20T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'NOT_OPENED', branchStepIndex: 3, delayHours: 24 }),
        now,
      };
      expect(evaluateBranch(state)).toBe(3);
    });

    it('returns null when opened (should NOT branch)', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({
          openedAt: new Date('2026-08-21T10:00:00Z'),
          sentAt: new Date('2026-08-20T10:00:00Z'),
        }),
        currentStep: makeStep({ branchOn: 'NOT_OPENED', branchStepIndex: 3 }),
      };
      expect(evaluateBranch(state)).toBeNull();
    });

    it('returns null when delay not yet elapsed', () => {
      const now = new Date('2026-08-20T15:00:00Z');
      const state: LeadBranchState = {
        lastMessage: makeMessage({ sentAt: new Date('2026-08-20T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'NOT_OPENED', branchStepIndex: 3, delayHours: 24 }),
        now,
      };
      expect(evaluateBranch(state)).toBeNull();
    });
  });

  describe('REPLIED condition', () => {
    it('returns branchStepIndex when lead replied', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ repliedAt: new Date('2026-08-21T10:00:00Z'), status: 'REPLIED' }),
        currentStep: makeStep({ branchOn: 'REPLIED', branchStepIndex: 4 }),
      };
      expect(evaluateBranch(state)).toBe(4);
    });

    it('returns null when lead hasn\'t replied', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage(),
        currentStep: makeStep({ branchOn: 'REPLIED', branchStepIndex: 4 }),
      };
      expect(evaluateBranch(state)).toBeNull();
    });
  });

  describe('NOT_REPLIED condition', () => {
    it('returns branchStepIndex when not replied and delay elapsed', () => {
      const now = new Date('2026-08-23T10:00:00Z');
      const state: LeadBranchState = {
        lastMessage: makeMessage({ sentAt: new Date('2026-08-20T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'NOT_REPLIED', branchStepIndex: 4, delayHours: 48 }),
        now,
      };
      expect(evaluateBranch(state)).toBe(4);
    });

    it('returns null when lead already replied', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ repliedAt: new Date('2026-08-21T10:00:00Z') }),
        currentStep: makeStep({ branchOn: 'NOT_REPLIED', branchStepIndex: 4 }),
      };
      expect(evaluateBranch(state)).toBeNull();
    });
  });

  describe('CLICKED condition', () => {
    it('returns branchStepIndex when lead clicked', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ clickedAt: new Date('2026-08-21T10:00:00Z'), status: 'CLICKED' }),
        currentStep: makeStep({ branchOn: 'CLICKED', branchStepIndex: 5 }),
      };
      expect(evaluateBranch(state)).toBe(5);
    });

    it('returns null when lead didn\'t click', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage(),
        currentStep: makeStep({ branchOn: 'CLICKED', branchStepIndex: 5 }),
      };
      expect(evaluateBranch(state)).toBeNull();
    });
  });

  describe('BOUNCED condition', () => {
    it('returns branchStepIndex when message bounced', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ status: 'BOUNCED' }),
        currentStep: makeStep({ branchOn: 'BOUNCED', branchStepIndex: 6 }),
      };
      expect(evaluateBranch(state)).toBe(6);
    });

    it('returns branchStepIndex when message failed', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ status: 'FAILED' }),
        currentStep: makeStep({ branchOn: 'BOUNCED', branchStepIndex: 6 }),
      };
      expect(evaluateBranch(state)).toBe(6);
    });

    it('returns null when message was sent normally', () => {
      const state: LeadBranchState = {
        lastMessage: makeMessage({ status: 'SENT' }),
        currentStep: makeStep({ branchOn: 'BOUNCED', branchStepIndex: 6 }),
      };
      expect(evaluateBranch(state)).toBeNull();
    });
  });
});

// ─── validateBranchConfig ───

describe('validateBranchConfig', () => {
  it('does not throw for valid config', () => {
    expect(() => validateBranchConfig({
      ...makeStep({ branchOn: 'OPENED', branchStepIndex: 3, stepOrder: 1 }),
      isLast: false,
    })).not.toThrow();
  });

  it('throws when branch step is the last step', () => {
    expect(() => validateBranchConfig({
      ...makeStep({ branchOn: 'OPENED', branchStepIndex: 3, stepOrder: 2 }),
      isLast: true,
    })).toThrow('cannot be the last step');
  });

  it('throws when branchStepIndex is null', () => {
    expect(() => validateBranchConfig({
      ...makeStep({ branchOn: 'OPENED', branchStepIndex: null, stepOrder: 1 }),
      isLast: false,
    })).toThrow('must have branchStepIndex');
  });

  it('throws when branchStepIndex <= stepOrder', () => {
    expect(() => validateBranchConfig({
      ...makeStep({ branchOn: 'OPENED', branchStepIndex: 1, stepOrder: 3 }),
      isLast: false,
    })).toThrow('must be greater than stepOrder');
  });

  it('does not throw when branchOn is NONE (no validation needed)', () => {
    expect(() => validateBranchConfig({
      ...makeStep({ branchOn: 'NONE', branchStepIndex: null }),
      isLast: true,
    })).not.toThrow();
  });
});