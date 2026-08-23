import '@testing-library/jest-dom';

// jsdom does not implement EventSource at all — several pages (Dashboard,
// TerminalView) subscribe to SSE streams on mount. A no-op stub lets those
// effects run without crashing tests that don't care about live updates.
if (typeof (globalThis as any).EventSource === 'undefined') {
  class EventSourceStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  (globalThis as any).EventSource = EventSourceStub;
}

// jsdom has no PointerEvent, so fireEvent.pointer* falls back to a bare Event
// and drops clientX/clientY. Back it with MouseEvent so pointer-driven UIs
// (sidebar resize, tab drag) get real coordinates in tests.
// Guard on MouseEvent because some test files run under @vitest-environment node
// (e.g., viteProxyTarget.test.ts to load vite.config), where MouseEvent is undefined.
// This guard is a no-op under jsdom.
if (typeof (globalThis as any).PointerEvent === 'undefined' && typeof MouseEvent !== 'undefined') {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (globalThis as any).PointerEvent = PointerEventStub;
}

// jsdom 24 does not implement File.prototype.arrayBuffer; polyfill via Node Blob
if (typeof File !== 'undefined' && typeof File.prototype.arrayBuffer === 'undefined') {
  File.prototype.arrayBuffer = function () {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
