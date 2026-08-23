import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { CadenceGovernor, resetCadenceGovernor, getCadenceGovernor } from '../../src/core/execution/cadenceGovernor.js';

function makeGovernor(overrides: Partial<{
  globalMaxPerMinute: number;
  globalMaxPerHour: number;
  perChannelMaxPerMinute: number;
}> = {}) {
  return new CadenceGovernor({
    globalMaxPerMinute: overrides.globalMaxPerMinute ?? 60,
    globalMaxPerHour: overrides.globalMaxPerHour ?? 1000,
    perChannelMaxPerMinute: overrides.perChannelMaxPerMinute ?? 20,
  });
}

describe('CadenceGovernor', () => {
  beforeEach(() => {
    resetCadenceGovernor();
  });

  afterEach(() => {
    resetCadenceGovernor();
  });

  describe('acquireSendSlot', () => {
    it('allows sends up to per-channel limit', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 3 });

      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(false); // 4th blocked
    });

    it('blocks when global per-minute limit reached', () => {
      const gov = makeGovernor({ globalMaxPerMinute: 2, perChannelMaxPerMinute: 10 });

      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('linkedin').allowed).toBe(true);
      expect(gov.acquireSendSlot('whatsapp').allowed).toBe(false); // global limit hit
    });

    it('blocks when global per-hour limit reached', () => {
      const gov = makeGovernor({ globalMaxPerHour: 2, perChannelMaxPerMinute: 10 });

      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(false); // global hour limit
    });

    it('returns retryAfterMs when blocked', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 1 });

      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      const blocked = gov.acquireSendSlot('email');
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it('different channels have independent limits', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 2 });

      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(false); // email limit

      expect(gov.acquireSendSlot('linkedin').allowed).toBe(true); // separate channel
      expect(gov.acquireSendSlot('linkedin').allowed).toBe(true);
      expect(gov.acquireSendSlot('linkedin').allowed).toBe(false);
    });
  });

  describe('commitSendSlot / releaseSendSlot', () => {
    it('commit permanently consumes the slot', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 2 });

      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');

      // One committed, one reserved for the second call
      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');

      // Third call: blocked (2 committed)
      expect(gov.acquireSendSlot('email').allowed).toBe(false);
    });

    it('release frees the slot for reuse', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 1 });

      gov.acquireSendSlot('email');
      gov.releaseSendSlot('email');

      // Should be available again
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
    });

    it('reservations decrement correctly after release', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 2 });

      // Reserve 2
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(true);

      // Release both
      gov.releaseSendSlot('email');
      gov.releaseSendSlot('email');

      // Should be available again
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
    });
  });

  describe('getGlobalState', () => {
    it('reports accurate global state', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 2, globalMaxPerMinute: 3 });

      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');

      const state = gov.getGlobalState();

      expect(state.globalSlots.usedPerMinute).toBe(1);
      expect(state.globalSlots.limitPerMinute).toBe(3);
      expect(state.globalSlots.available).toBe(true);
    });

    it('reports blocked state when limits reached', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 1, globalMaxPerMinute: 1 });

      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');

      const state = gov.getGlobalState();

      expect(state.globalSlots.available).toBe(false);
      expect(state.nextAvailableMs).toBeGreaterThan(0);
    });

    it('reports per-channel state', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 5 });

      gov.acquireSendSlot('email');
      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');
      gov.commitSendSlot('email');

      const state = gov.getGlobalState();
      expect(state.channelSlots['email']?.used).toBe(2);
      expect(state.channelSlots['email']?.limit).toBe(5);
    });
  });

  describe('reset', () => {
    it('resets all counters', () => {
      const gov = makeGovernor({ perChannelMaxPerMinute: 2 });

      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');
      gov.acquireSendSlot('email');
      gov.commitSendSlot('email');

      expect(gov.acquireSendSlot('email').allowed).toBe(false);

      gov.reset();

      expect(gov.acquireSendSlot('email').allowed).toBe(true);
    });
  });

  describe('sliding window', () => {
    it('uses backdated timestamps for sliding window (future: real-time)', () => {
      // This test verifies the structure works — real sliding window happens
      // with actual timestamps. Since we use Date.now(), it's always fresh.
      const gov = makeGovernor({ perChannelMaxPerMinute: 10 });

      for (let i = 0; i < 10; i++) {
        expect(gov.acquireSendSlot('email').allowed).toBe(true);
      }
      expect(gov.acquireSendSlot('email').allowed).toBe(false);

      // After reset, should work again
      gov.reset();
      expect(gov.acquireSendSlot('email').allowed).toBe(true);
    });
  });
});

describe('singleton getCadenceGovernor', () => {
  afterEach(() => {
    resetCadenceGovernor();
  });

  it('returns the same instance on repeated calls', () => {
    const g1 = getCadenceGovernor();
    const g2 = getCadenceGovernor();
    expect(g1).toBe(g2);
  });

  it('resetCadenceGovernor creates a fresh instance on next call', () => {
    const g1 = getCadenceGovernor();
    resetCadenceGovernor();
    const g2 = getCadenceGovernor();
    expect(g1).not.toBe(g2);
  });
});