import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

function networkError(): Error {
  const err = new Error('Network error calling Telegram deleteWebhook');
  err.name = 'NetworkError';
  return err;
}

function createFlakyAdapter(failures: number, failWith: () => Error = networkError) {
  let calls = 0;
  const adapter: ChannelAdapter & { calls: () => number } = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,
    calls: () => calls,
    async setup() {
      calls += 1;
      if (calls <= failures) throw failWith();
    },
    async teardown() {},
    isConnected: () => calls > failures,
    async deliver() {
      return undefined;
    },
  };
  return adapter;
}

const setupFn = (): ChannelSetup => ({
  onInbound() {},
  onInboundEvent() {},
  onMetadata() {},
  onAction() {},
});

const BOOT_ATTEMPTS = 4;

describe('channel adapter background recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    vi.useRealTimers();
  });

  async function boot(adapter: ChannelAdapter) {
    const reg = await import('./channel-registry.js');
    reg.registerChannelAdapter('telegram', { factory: () => adapter });
    const init = reg.initChannelAdapters(setupFn);
    await vi.advanceTimersByTimeAsync(20_000);
    await init;
    return reg;
  }

  it('keeps retrying every minute after the boot retries run out, then comes back', async () => {
    const adapter = createFlakyAdapter(BOOT_ATTEMPTS + 45);
    const reg = await boot(adapter);
    expect(reg.getChannelAdapterExact('telegram')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(reg.getChannelAdapterExact('telegram')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reg.getChannelAdapterExact('telegram')).toBe(adapter);
    expect(adapter.calls()).toBe(BOOT_ATTEMPTS + 46);
  });

  it('stops retrying on a non-network error', async () => {
    let failures = 0;
    const adapter = createFlakyAdapter(Infinity, () => (++failures > BOOT_ATTEMPTS ? new Error('401') : networkError()));
    const reg = await boot(adapter);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(adapter.calls()).toBe(BOOT_ATTEMPTS + 1);
    expect(reg.getChannelAdapterExact('telegram')).toBeUndefined();
  });

  it('stops retrying after teardown', async () => {
    const adapter = createFlakyAdapter(Infinity);
    const reg = await boot(adapter);

    await reg.teardownChannelAdapters();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(adapter.calls()).toBe(BOOT_ATTEMPTS);
  });
});
