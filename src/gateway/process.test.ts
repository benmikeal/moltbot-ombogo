import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findExistingMoltbotProcess, ensureMoltbotGateway } from './process';
import type { Sandbox, Process } from '@cloudflare/sandbox';
import { createMockSandbox, createMockEnv, suppressConsole } from '../test-utils';

// Mock sync-direct module
vi.mock('./sync-direct', () => ({
  restoreFromR2Direct: vi.fn(),
  getLastSyncDirect: vi.fn(),
}));

import { restoreFromR2Direct, getLastSyncDirect } from './sync-direct';

// Helper to create a full mock process (with methods needed for process tests)
function createFullMockProcess(overrides: Partial<Process> = {}): Process {
  return {
    id: 'test-id',
    command: 'openclaw gateway',
    status: 'running',
    startTime: new Date(),
    endTime: undefined,
    exitCode: undefined,
    waitForPort: vi.fn(),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides,
  } as Process;
}

describe('findExistingMoltbotProcess', () => {
  it('returns null when no processes exist', async () => {
    const { sandbox } = createMockSandbox({ processes: [] });
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when only CLI commands are running', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw devices list --json', status: 'running' }),
      createFullMockProcess({ command: 'openclaw --version', status: 'completed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns gateway process when running', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: 'openclaw gateway --port 18789', 
      status: 'running' 
    });
    const processes = [
      createFullMockProcess({ command: 'openclaw devices list', status: 'completed' }),
      gatewayProcess,
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns gateway process when starting', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh', 
      status: 'starting' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('ignores completed gateway processes', async () => {
    const processes = [
      createFullMockProcess({ command: 'openclaw gateway', status: 'completed' }),
      createFullMockProcess({ command: 'start-moltbot.sh', status: 'failed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('handles listProcesses errors gracefully', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as Sandbox;
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('matches start-moltbot.sh command', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh', 
      status: 'running' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns first matching gateway process', async () => {
    const firstGateway = createFullMockProcess({
      id: 'gateway-1',
      command: 'openclaw gateway',
      status: 'running'
    });
    const secondGateway = createFullMockProcess({
      id: 'gateway-2',
      command: 'start-moltbot.sh',
      status: 'starting'
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([firstGateway, secondGateway]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result?.id).toBe('gateway-1');
  });
});

describe('ensureMoltbotGateway', () => {
  beforeEach(() => {
    suppressConsole();
    vi.clearAllMocks();
  });

  it('restores from R2 before starting new gateway when backup exists', async () => {
    // Setup: no existing process, R2 backup exists
    const { sandbox, listProcessesMock, startProcessMock } = createMockSandbox({ processes: [] });
    const env = createMockEnv();

    vi.mocked(getLastSyncDirect).mockResolvedValue('2026-02-06T12:00:00Z');
    vi.mocked(restoreFromR2Direct).mockResolvedValue({ success: true, filesBackedUp: 5 });

    // Mock process startup
    const mockProcess = createFullMockProcess({ id: 'new-gateway', status: 'running' });
    mockProcess.waitForPort = vi.fn().mockResolvedValue(undefined);
    startProcessMock.mockResolvedValue(mockProcess);

    await ensureMoltbotGateway(sandbox, env);

    expect(getLastSyncDirect).toHaveBeenCalledWith(env);
    expect(restoreFromR2Direct).toHaveBeenCalledWith(sandbox, env);
  });

  it('skips restore when no R2 backup exists', async () => {
    const { sandbox, startProcessMock } = createMockSandbox({ processes: [] });
    const env = createMockEnv();

    vi.mocked(getLastSyncDirect).mockResolvedValue(null);

    // Mock process startup
    const mockProcess = createFullMockProcess({ id: 'new-gateway', status: 'running' });
    mockProcess.waitForPort = vi.fn().mockResolvedValue(undefined);
    startProcessMock.mockResolvedValue(mockProcess);

    await ensureMoltbotGateway(sandbox, env);

    expect(getLastSyncDirect).toHaveBeenCalled();
    expect(restoreFromR2Direct).not.toHaveBeenCalled();
  });

  it('continues startup even if restore fails', async () => {
    const { sandbox, startProcessMock } = createMockSandbox({ processes: [] });
    const env = createMockEnv();

    vi.mocked(getLastSyncDirect).mockResolvedValue('2026-02-06T12:00:00Z');
    vi.mocked(restoreFromR2Direct).mockResolvedValue({ success: false, error: 'Network error' });

    // Mock process startup
    const mockProcess = createFullMockProcess({ id: 'new-gateway', status: 'running' });
    mockProcess.waitForPort = vi.fn().mockResolvedValue(undefined);
    startProcessMock.mockResolvedValue(mockProcess);

    // Should not throw
    const result = await ensureMoltbotGateway(sandbox, env);

    expect(result).toBeTruthy();
    expect(result.id).toBe('new-gateway');
  });

  it('does not restore when reusing existing process', async () => {
    // Setup: existing running process
    const existingProcess = createFullMockProcess({
      id: 'existing-gateway',
      command: 'openclaw gateway',
      status: 'running'
    });
    existingProcess.waitForPort = vi.fn().mockResolvedValue(undefined);

    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([existingProcess]);
    const env = createMockEnv();

    const result = await ensureMoltbotGateway(sandbox, env);

    // Should reuse existing process without calling restore
    expect(result.id).toBe('existing-gateway');
    expect(getLastSyncDirect).not.toHaveBeenCalled();
    expect(restoreFromR2Direct).not.toHaveBeenCalled();
  });
});
