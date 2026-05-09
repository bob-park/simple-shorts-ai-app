import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock useNavigate from react-router-dom so components calling it outside a
// Router context do not throw during unit tests.  Tests that need real routing
// behaviour should wrap their render in <MemoryRouter>.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

// Node 24's bundled undici (node:internal/deps/undici/undici) validates the `signal`
// option of `new Request()` against its own private AbortSignal reference, which is
// captured before any environment setup. jsdom replaces globalThis.AbortController with
// its own class; signals produced by that class are rejected by undici even though they
// pass an instanceof check against globalThis.AbortSignal.
//
// react-router-dom v6 creates `new Request(url, { signal })` during every navigation,
// which causes an unhandled rejection and prevents the route from updating in tests.
//
// Fix: wrap globalThis.Request in a Proxy that silently drops the `signal` option.
// Signal cancellation is irrelevant for unit tests; removing it lets navigation complete
// and React re-render with the new page.
const OriginalRequest = globalThis.Request;
globalThis.Request = new Proxy(OriginalRequest, {
  construct(Target: typeof Request, [input, init]: [RequestInfo | URL, RequestInit | undefined]) {
    if (init && 'signal' in init) {
      const { signal: omittedSignal, ...safeInit } = init;
      void omittedSignal;
      return new Target(input, safeInit);
    }
    return new Target(input, init);
  },
}) as typeof Request;
