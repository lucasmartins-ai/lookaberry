import type { BranchCondition } from './types.js';

/** Lightweight representation of a step with branching config */
export interface BranchableStep {
  branchOn: BranchCondition;
  branchStepIndex: number | null;
  stepOrder: number;
  delayHours: number;
}

/** State needed from the last message sent to this lead */
export interface LastMessageState {
  status: string;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  repliedAt: Date | null;
}

/** Full lead state for branching evaluation */
export interface LeadBranchState {
  lastMessage: LastMessageState | null;
  currentStep: BranchableStep;
  now?: Date;
}

/**
 * Evaluate the branch condition for the current step against the lead's state.
 *
 * Returns the target step index to jump to, or null to proceed linearly.
 */
export function evaluateBranch(state: LeadBranchState): number | null {
  const now = state.now ?? new Date();
  const branchOn = state.currentStep.branchOn;

  // No branch configured → linear progression
  if (!branchOn || branchOn === 'NONE') return null;

  // No message sent yet → can't evaluate
  if (!state.lastMessage) return null;

  const msg = state.lastMessage;

  switch (branchOn) {
    case 'OPENED':
      // Any evidence the lead opened/looked at the message
      if (msg.openedAt || msg.clickedAt || msg.repliedAt || msg.status === 'OPENED' || msg.status === 'CLICKED' || msg.status === 'REPLIED') {
        return state.currentStep.branchStepIndex;
      }
      return null;

    case 'NOT_OPENED': {
      // Lead has NOT opened AND the delay window has elapsed
      const isOpened = !!(msg.openedAt || msg.clickedAt || msg.repliedAt || msg.status === 'OPENED' || msg.status === 'CLICKED' || msg.status === 'REPLIED');
      if (isOpened) return null;

      // Check if delayHours have elapsed since sentAt
      if (msg.sentAt) {
        const elapsedMs = now.getTime() - msg.sentAt.getTime();
        const delayMs = state.currentStep.delayHours * 3_600_000;
        if (elapsedMs >= delayMs) {
          return state.currentStep.branchStepIndex;
        }
      }
      return null;
    }

    case 'REPLIED':
      if (msg.repliedAt || msg.status === 'REPLIED') {
        return state.currentStep.branchStepIndex;
      }
      return null;

    case 'NOT_REPLIED': {
      const hasReplied = !!(msg.repliedAt || msg.status === 'REPLIED');
      if (hasReplied) return null;

      if (msg.sentAt) {
        const elapsedMs = now.getTime() - msg.sentAt.getTime();
        const delayMs = state.currentStep.delayHours * 3_600_000;
        if (elapsedMs >= delayMs) {
          return state.currentStep.branchStepIndex;
        }
      }
      return null;
    }

    case 'CLICKED':
      if (msg.clickedAt || msg.status === 'CLICKED' || msg.status === 'REPLIED') {
        return state.currentStep.branchStepIndex;
      }
      return null;

    case 'BOUNCED':
      if (msg.status === 'BOUNCED' || msg.status === 'FAILED') {
        return state.currentStep.branchStepIndex;
      }
      return null;

    default:
      return null;
  }
}

/**
 * Validate that a step's branch configuration is consistent.
 * Throws on invalid config (for use during sequence creation/editing).
 */
export function validateBranchConfig(
  step: BranchableStep & { isLast: boolean },
): void {
  if (!step.branchOn || step.branchOn === 'NONE') return;

  if (step.isLast) {
    throw new Error(
      `Step with branchOn=${step.branchOn} cannot be the last step in the sequence (no step to branch to).`,
    );
  }

  if (step.branchStepIndex === null || step.branchStepIndex === undefined) {
    throw new Error(
      `Step with branchOn=${step.branchOn} must have branchStepIndex set.`,
    );
  }

  if (step.branchStepIndex <= step.stepOrder) {
    throw new Error(
      `branchStepIndex (${step.branchStepIndex}) must be greater than stepOrder (${step.stepOrder}).`,
    );
  }
}