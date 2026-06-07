import path from 'node:path';

import { vi, describe, beforeEach, afterAll, it, expect } from 'vitest';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, SystemInformation } from 'matterbridge';
import { VendorId } from 'matterbridge/matter';
import { RvcOperationalState } from 'matterbridge/matter/clusters';

import { ValetudoPlatform } from '../src/module.ts';

const mockLog = {
  fatal: vi.fn((message: string, ...parameters: unknown[]) => {}),
  error: vi.fn((message: string, ...parameters: unknown[]) => {}),
  warn: vi.fn((message: string, ...parameters: unknown[]) => {}),
  notice: vi.fn((message: string, ...parameters: unknown[]) => {}),
  info: vi.fn((message: string, ...parameters: unknown[]) => {}),
  debug: vi.fn((message: string, ...parameters: unknown[]) => {}),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
  } as unknown as SystemInformation,
  rootDirectory: path.join('vitest', 'ValetudoPlugin'),
  homeDirectory: path.join('vitest', 'ValetudoPlugin'),
  matterbridgeDirectory: path.join('vitest', 'ValetudoPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('vitest', 'ValetudoPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('vitest', 'ValetudoPlugin', '.mattercert'),
  globalModulesDirectory: path.join('vitest', 'ValetudoPlugin', 'node_modules'),
  matterbridgeVersion: '3.4.0',
  matterbridgeLatestVersion: '3.4.0',
  matterbridgeDevVersion: '3.4.0',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',
  // Mocked methods
  addBridgedEndpoint: vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeBridgedEndpoint: vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeAllBridgedEndpoints: vi.fn(async (pluginName: string) => {}),
} as unknown as PlatformMatterbridge;

const mockConfig: PlatformConfig = {
  name: 'matterbridge-valetudo',
  type: 'DynamicPlatform',
  version: '1.0.0',
  debug: false,
  unregisterOnShutdown: false,
};

vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation(() => {});

describe('Matterbridge Valetudo Plugin', () => {
  let instance: ValetudoPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', async () => {
    mockMatterbridge.matterbridgeVersion = '2.0.0'; // Simulate an older version
    expect(() => new ValetudoPlatform(mockMatterbridge, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
    mockMatterbridge.matterbridgeVersion = '3.4.0';
  });

  it('should create an instance of the platform', async () => {
    instance = (await import('../src/module.ts')).default(mockMatterbridge, mockLog, mockConfig) as ValetudoPlatform;
    expect(instance).toBeInstanceOf(ValetudoPlatform);
    expect(instance.matterbridge).toBe(mockMatterbridge);
    expect(instance.log).toBe(mockLog);
    expect(instance.config).toBe(mockConfig);
    expect(instance.matterbridge.matterbridgeVersion).toBe('3.4.0');
    expect(mockLog.info).toHaveBeenCalledWith('Initializing platform for multi-vacuum support...');
  });

  it('should start', async () => {
    // onStart triggers mDNS discovery which can timeout, so we increase the timeout
    // With no vacuums configured and discovery enabled, it will attempt discovery
    await instance.onStart('Vitest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Vitest');
  }, 30000);

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
  });

  it('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should shutdown', async () => {
    await instance.onShutdown('Vitest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: Vitest');
  });

  it('should shutdown with unregister', async () => {
    // Mock the unregisterOnShutdown behavior
    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: none');
    // Note: removeAllBridgedEndpoints is called on the platform base class internally
    mockConfig.unregisterOnShutdown = false;
  });
});

// ============================================================================
// Status mapping, Dock & Empty / Locate buttons, consumables gating
// ============================================================================

// A minimal mock ValetudoClient exposing only the methods these tests exercise
function makeMockClient() {
  return {
    returnHome: vi.fn().mockResolvedValue(true),
    triggerAutoEmpty: vi.fn().mockResolvedValue(true),
    locate: vi.fn().mockResolvedValue(true),
    getConsumables: vi.fn().mockResolvedValue([]),
    getConsumablesProperties: vi.fn().mockResolvedValue([]),
  };
}

// A minimal VacuumInstance for exercising private logic without a real device/client
function makeVacuum(overrides: Record<string, unknown> = {}) {
  return {
    id: 'system-1',
    name: 'Test Vacuum',
    client: makeMockClient(),
    device: null,
    capabilities: [],
    consumableMap: new Map(),
    docked: false,
    pendingEmptyAt: null,
    ...overrides,
  };
}

describe('ValetudoPlatform — status mapping', () => {
  let platform: ValetudoPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatterbridge.matterbridgeVersion = '3.4.0';
    platform = new ValetudoPlatform(mockMatterbridge, mockLog, mockConfig);
  });

  it('maps Valetudo statuses to RVC operational states', () => {
    const map = (status: string, dock?: string, charging?: boolean) =>
      (platform as unknown as { mapValetudoStatusToOperationalState(s: string, d?: string, c?: boolean): number }).mapValetudoStatusToOperationalState(status, dock, charging);
    expect(map('cleaning')).toBe(RvcOperationalState.OperationalState.Running);
    expect(map('docked')).toBe(RvcOperationalState.OperationalState.Docked);
    expect(map('idle')).toBe(RvcOperationalState.OperationalState.Docked);
    expect(map('paused')).toBe(RvcOperationalState.OperationalState.Paused);
    expect(map('error')).toBe(RvcOperationalState.OperationalState.Error);
    expect(map('returning')).toBe(RvcOperationalState.OperationalState.SeekingCharger);
  });

  it('shows Charging when parked and the battery is charging', () => {
    const map = (status: string, dock?: string, charging?: boolean) =>
      (platform as unknown as { mapValetudoStatusToOperationalState(s: string, d?: string, c?: boolean): number }).mapValetudoStatusToOperationalState(status, dock, charging);
    expect(map('docked', undefined, true)).toBe(RvcOperationalState.OperationalState.Charging);
    expect(map('idle', undefined, true)).toBe(RvcOperationalState.OperationalState.Charging);
    // Not charging (e.g. fully charged) stays Docked
    expect(map('docked', undefined, false)).toBe(RvcOperationalState.OperationalState.Docked);
    // Dock actively servicing the robot takes precedence over charging
    expect(map('docked', 'emptying', true)).toBe(RvcOperationalState.OperationalState.Docked);
    // Charging flag does not affect an actively-cleaning robot
    expect(map('cleaning', undefined, true)).toBe(RvcOperationalState.OperationalState.Running);
  });

  it('maps Valetudo statuses to RVC run modes (idle vs cleaning)', () => {
    const map = (status: string) => (platform as unknown as { mapValetudoStatusToRunMode(s: string): number }).mapValetudoStatusToRunMode(status);
    expect(map('cleaning')).toBe(2); // RvcRunModeValue.Cleaning
    expect(map('idle')).toBe(1); // RvcRunModeValue.Idle
    expect(map('docked')).toBe(1);
  });
});

describe('ValetudoPlatform — handleDockAndEmpty', () => {
  let platform: ValetudoPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatterbridge.matterbridgeVersion = '3.4.0';
    platform = new ValetudoPlatform(mockMatterbridge, mockLog, mockConfig);
  });

  const handle = (vacuum: unknown) => (platform as unknown as { handleDockAndEmpty(v: unknown): Promise<void> }).handleDockAndEmpty(vacuum);

  it('empties immediately when already docked and auto-empty is supported', async () => {
    const vacuum = makeVacuum({ docked: true, capabilities: ['BasicControlCapability', 'AutoEmptyDockManualTriggerCapability'] });
    await handle(vacuum);
    expect(vacuum.client.triggerAutoEmpty).toHaveBeenCalledTimes(1);
    expect(vacuum.client.returnHome).not.toHaveBeenCalled();
    expect(vacuum.pendingEmptyAt).toBeNull();
  });

  it('returns to dock and defers the empty when away and auto-empty is supported', async () => {
    const vacuum = makeVacuum({ docked: false, capabilities: ['BasicControlCapability', 'AutoEmptyDockManualTriggerCapability'] });
    await handle(vacuum);
    expect(vacuum.client.returnHome).toHaveBeenCalledTimes(1);
    expect(vacuum.client.triggerAutoEmpty).not.toHaveBeenCalled();
    expect(typeof vacuum.pendingEmptyAt).toBe('number');
  });

  it('only returns to dock (no pending empty) when auto-empty is not supported', async () => {
    const vacuum = makeVacuum({ docked: false, capabilities: ['BasicControlCapability'] });
    await handle(vacuum);
    expect(vacuum.client.returnHome).toHaveBeenCalledTimes(1);
    expect(vacuum.client.triggerAutoEmpty).not.toHaveBeenCalled();
    expect(vacuum.pendingEmptyAt).toBeNull();
  });
});

describe('ValetudoPlatform — setupButtonsForVacuum gating', () => {
  let platform: ValetudoPlatform;
  let createButton: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatterbridge.matterbridgeVersion = '3.4.0';
    platform = new ValetudoPlatform(mockMatterbridge, mockLog, mockConfig);
    createButton = vi.spyOn(platform as unknown as { createMomentaryButton: () => Promise<void> }, 'createMomentaryButton').mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete (mockConfig as Record<string, unknown>).dockAndEmptyButton;
    delete (mockConfig as Record<string, unknown>).locateButton;
  });

  const setup = (vacuum: unknown) => (platform as unknown as { setupButtonsForVacuum(v: unknown): Promise<void> }).setupButtonsForVacuum(vacuum);

  it('creates a "Dock & Empty" button when enabled and the robot can auto-empty', async () => {
    (mockConfig as Record<string, unknown>).dockAndEmptyButton = true;
    (mockConfig as Record<string, unknown>).locateButton = false;
    await setup(makeVacuum({ capabilities: ['BasicControlCapability', 'AutoEmptyDockManualTriggerCapability'] }));
    expect(createButton).toHaveBeenCalledWith(expect.anything(), 'dock-empty', 'Dock & Empty', expect.any(Function));
  });

  it('labels the button "Return to Dock" when the robot cannot auto-empty', async () => {
    (mockConfig as Record<string, unknown>).dockAndEmptyButton = true;
    (mockConfig as Record<string, unknown>).locateButton = false;
    await setup(makeVacuum({ capabilities: ['BasicControlCapability'] }));
    expect(createButton).toHaveBeenCalledWith(expect.anything(), 'dock-empty', 'Return to Dock', expect.any(Function));
  });

  it('skips the Dock & Empty button without BasicControlCapability', async () => {
    (mockConfig as Record<string, unknown>).dockAndEmptyButton = true;
    (mockConfig as Record<string, unknown>).locateButton = false;
    await setup(makeVacuum({ capabilities: [] }));
    expect(createButton).not.toHaveBeenCalled();
  });

  it('creates a Locate button only when enabled and supported', async () => {
    (mockConfig as Record<string, unknown>).dockAndEmptyButton = false;
    (mockConfig as Record<string, unknown>).locateButton = true;
    await setup(makeVacuum({ capabilities: ['LocateCapability'] }));
    expect(createButton).toHaveBeenCalledWith(expect.anything(), 'locate', 'Locate', expect.any(Function));
  });

  it('creates no buttons when both flags are off', async () => {
    (mockConfig as Record<string, unknown>).dockAndEmptyButton = false;
    (mockConfig as Record<string, unknown>).locateButton = false;
    await setup(makeVacuum({ capabilities: ['BasicControlCapability', 'LocateCapability'] }));
    expect(createButton).not.toHaveBeenCalled();
  });
});

describe('ValetudoPlatform — consumables enabled default', () => {
  let platform: ValetudoPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatterbridge.matterbridgeVersion = '3.4.0';
    platform = new ValetudoPlatform(mockMatterbridge, mockLog, mockConfig);
  });

  afterAll(() => {
    delete (mockConfig as Record<string, unknown>).consumables;
  });

  const setup = (vacuum: unknown) => (platform as unknown as { setupConsumablesForVacuum(v: unknown): Promise<void> }).setupConsumablesForVacuum(vacuum);

  it('treats consumables as enabled by default (config key absent)', async () => {
    delete (mockConfig as Record<string, unknown>).consumables;
    // No ConsumableMonitoringCapability → it should pass the enabled gate and stop at the capability check
    await setup(makeVacuum({ capabilities: [] }));
    expect(mockLog.debug).not.toHaveBeenCalledWith('[Test Vacuum] Consumable tracking disabled');
    expect(mockLog.warn).toHaveBeenCalledWith('[Test Vacuum] ConsumableMonitoringCapability not supported');
  });

  it('disables consumables only when explicitly set to false', async () => {
    (mockConfig as Record<string, unknown>).consumables = { enabled: false };
    await setup(makeVacuum({ capabilities: ['ConsumableMonitoringCapability'] }));
    expect(mockLog.debug).toHaveBeenCalledWith('[Test Vacuum] Consumable tracking disabled');
  });
});
