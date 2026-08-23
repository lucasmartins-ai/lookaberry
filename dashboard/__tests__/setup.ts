import '@testing-library/jest-dom/vitest';

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe() {
    this.callback([{ contentRect: { width: 800, height: 320 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
}
