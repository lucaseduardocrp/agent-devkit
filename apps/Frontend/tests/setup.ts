import { afterEach, beforeAll, expect } from 'vitest';
import { cleanup } from '@testing-library/react';

interface CustomMatchers<R = unknown> {
  toBeInTheDocument(): R;
  toHaveTextContent(expected: string | RegExp): R;
  toHaveAttribute(attr: string, expectedVal?: string): R;
  toHaveClass(className: string): R;
}

declare module 'vitest' {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends CustomMatchers<R> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

expect.extend({
  toBeInTheDocument(received: Element | null | undefined) {
    const pass =
      received !== null &&
      received !== undefined &&
      (document.body.contains(received) || Boolean(received.isConnected));
    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to be in the document`,
    };
  },
  toHaveTextContent(received: Element | null | undefined, expected: string | RegExp) {
    const content = received?.textContent ?? '';
    const pass = typeof expected === 'string' ? content.includes(expected) : expected.test(content);
    return {
      pass,
      message: () =>
        `expected element to have text content ${String(expected)}, but got ${content}`,
    };
  },
  toHaveAttribute(received: Element | null | undefined, attr: string, expectedVal?: string) {
    const hasAttr = received?.hasAttribute(attr) ?? false;
    const val = received?.getAttribute(attr);
    const pass = expectedVal !== undefined ? val === expectedVal : hasAttr;
    return {
      pass,
      message: () => `expected element to have attribute ${attr}=${expectedVal}, but got ${val}`,
    };
  },
  toHaveClass(received: Element | null | undefined, className: string) {
    const pass = received?.classList.contains(className) ?? false;
    return {
      pass,
      message: () => `expected element to have class ${className}, but got ${received?.className}`,
    };
  },
});

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  if (typeof window !== 'undefined') {
    if (!window.URL.createObjectURL) {
      window.URL.createObjectURL = () => 'blob:mock-url';
    }
    if (!window.URL.revokeObjectURL) {
      window.URL.revokeObjectURL = () => {};
    }
    window.HTMLAnchorElement.prototype.click = () => {};
    window.HTMLCanvasElement.prototype.getContext = (() => ({
      arc: () => {},
      beginPath: () => {},
      clearRect: () => {},
      fill: () => {},
      fillRect: () => {},
      fillText: () => {},
      lineTo: () => {},
      moveTo: () => {},
      restore: () => {},
      save: () => {},
      scale: () => {},
      setTransform: () => {},
      stroke: () => {},
      translate: () => {},
      fillStyle: '',
      font: '',
      lineWidth: 1,
      strokeStyle: '',
      textAlign: 'start',
    })) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
    globalThis.ResizeObserver = class ResizeObserver {
      readonly #callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }

      observe(target: Element) {
        this.#callback([{ target } as ResizeObserverEntry], this);
      }

      unobserve() {}

      disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
});
