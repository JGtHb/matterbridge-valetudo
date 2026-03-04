/**
 * Matterbridge Valetudo Plugin
 *
 * Exposes Valetudo-enabled robot vacuums to Matter-compatible smart home platforms.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { MatterbridgeDynamicPlatform, PlatformConfig, MatterbridgeEndpoint, contactSensor } from 'matterbridge';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { RvcCleanMode, RvcRunMode } from 'matterbridge/matter/clusters';

// Derive PlatformMatterbridge type from the parent class constructor to avoid
// import resolution issues across different npm dependency tree layouts.
type PlatformMatterbridge = ConstructorParameters<typeof MatterbridgeDynamicPlatform>[0];

import { ValetudoClient, BatteryStateAttribute, ValetudoConsumable, CachedMapLayers } from './valetudo-client.js';
import { ValetudoDiscovery } from './valetudo-discovery.js';

/**
 * VacuumInstance - Represents a single vacuum with its state and configuration
 */
interface VacuumInstance {
  id: string; // systemId from Valetudo
  ip: string;
  name: string;
  client: ValetudoClient;
  device: RoboticVacuumCleaner | null;
  pollingInterval: NodeJS.Timeout | null;

  // Per-vacuum state
  capabilities: string[];
  operationModes: string[];
  modeMap: Map<number, { fanSpeed?: string; waterUsage?: string; operationMode?: string }>;
  areaToSegmentMap: Map<number, { id: string; name: string }>;
  selectedSegmentIds: string[];
  selectedRoomNames: string[];
  consumableMap: Map<string, { endpoint?: MatterbridgeEndpoint; consumable: ValetudoConsumable; lastState?: boolean }>;
  mapLayersCache: CachedMapLayers | null;
  mapCacheValidUntil: number;
  lastCurrentArea: number | null;
  lastConsumablesCheck: number;

  // Change tracking
  lastBatteryLevel: number | null;
  lastBatteryChargeState: number | null;
  lastOperationalState: number | null;
  lastRunMode: number | null;
  initialStatePending: boolean; // Flag to set initial state on first poll

  // Metadata
  source: 'mdns' | 'manual';
  lastSeen: number;
  online: boolean;
}

/**
 * RvcRunMode values
 */
const enum RvcRunModeValue {
  Idle = 1,
  Cleaning = 2,
  Mapping = 3,
}

const RvcCleanModeBase = 5;

/**
 * Matter Operational State enum values
 */
const enum OperationalStateValue {
  Stopped = 0x00,
  Running = 0x01,
  Paused = 0x02,
  Error = 0x03,
  SeekingCharger = 0x40,
  Charging = 0x41,
  Docked = 0x42,
}

/**
 * Plugin initialization function - standard Matterbridge plugin interface.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance
 * @param {AnsiLogger} log - Logger for console and frontend output
 * @param {PlatformConfig} config - The platform configuration
 * @returns {ValetudoPlatform} - The initialized platform instance
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): ValetudoPlatform {
  return new ValetudoPlatform(matterbridge, log, config);
}

/**
 * ValetudoPlatform - Main plugin class for Valetudo vacuum integration.
 * Extends MatterbridgeDynamicPlatform for multi-device support.
 */
export class ValetudoPlatform extends MatterbridgeDynamicPlatform {
  private vacuums: Map<string, VacuumInstance> = new Map();
  private mdns: ValetudoDiscovery | null = null;
  private discoveryInterval: NodeJS.Timeout | null = null;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (!this.verifyMatterbridgeVersion?.('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing platform for multi-vacuum support...');
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    // Stop discovery interval
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }

    // Destroy mDNS instance
    if (this.mdns) {
      this.mdns.destroy();
      this.mdns = null;
    }

    // Stop polling for all vacuums
    for (const vacuum of this.vacuums.values()) {
      if (vacuum.pollingInterval) {
        clearInterval(vacuum.pollingInterval);
        vacuum.pollingInterval = null;
      }
    }

    // Clear vacuum map
    this.vacuums.clear();

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  /**
   * Load manually configured vacuums from config
   */
  private async loadManualVacuums(): Promise<void> {
    const config = this.config as {
      vacuums?: Array<{ ip: string; name?: string; enabled?: boolean; username?: string; password?: string }>;
    };

    const manualVacuums = config.vacuums || [];
    this.log.info(`Loading ${manualVacuums.length} manually configured vacuums...`);

    for (const vacuumConfig of manualVacuums) {
      if (vacuumConfig.enabled === false) {
        this.log.info(`Skipping disabled vacuum at ${vacuumConfig.ip}`);
        continue;
      }

      try {
        await this.addVacuum(vacuumConfig.ip, vacuumConfig.name, 'manual', vacuumConfig.username, vacuumConfig.password);
      } catch (error) {
        this.log.error(`Failed to add manual vacuum at ${vacuumConfig.ip}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Discover and add vacuums via mDNS
   */
  private async discoverAndAddVacuums(): Promise<void> {
    const config = this.config as {
      discovery?: { enabled?: boolean; timeout?: number };
    };

    const discoveryEnabled = config.discovery?.enabled !== false; // Default true
    if (!discoveryEnabled) {
      this.log.info('mDNS discovery is disabled');
      return;
    }

    this.log.info('Starting mDNS discovery for Valetudo vacuums...');

    try {
      this.mdns = new ValetudoDiscovery(this.log);
      const timeout = config.discovery?.timeout || 5000;
      const discovered = await this.mdns.discover(timeout);

      this.log.info(`mDNS discovery found ${discovered.length} vacuum(s)`);

      for (const vacuum of discovered) {
        try {
          // Check if already added manually
          const existing = Array.from(this.vacuums.values()).find((v) => v.ip === vacuum.ip);
          if (existing) {
            this.log.info(`Vacuum at ${vacuum.ip} already added manually, skipping mDNS entry`);
            continue;
          }

          await this.addVacuum(vacuum.ip, undefined, 'mdns');
        } catch (error) {
          this.log.error(`Failed to add discovered vacuum at ${vacuum.ip}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.log.error(`mDNS discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Clean up mDNS after discovery
      if (this.mdns) {
        this.mdns.destroy();
        this.mdns = null;
      }
    }
  }

  /**
   * Add a new vacuum to the system
   */
  private async addVacuum(ip: string, customName: string | undefined, source: 'mdns' | 'manual', username?: string, password?: string): Promise<void> {
    this.log.info(`Adding vacuum from ${source}: ${ip}${customName ? ` (${customName})` : ''}`);

    // Create Valetudo client
    const client = new ValetudoClient(ip, this.log, username, password);

    // Test connection
    const isConnected = await client.testConnection();
    if (!isConnected) {
      throw new Error(`Failed to connect to Valetudo at ${ip}`);
    }

    // Small delay before next call
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Fetch info to get systemId
    const info = await client.getInfo();
    if (!info) {
      throw new Error(`Failed to fetch Valetudo info from ${ip}`);
    }

    // Small delay before next call
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check for duplicate systemId
    const existing = this.vacuums.get(info.systemId);
    if (existing) {
      if (existing.ip !== ip) {
        this.log.warn(`Vacuum ${info.systemId} already exists at ${existing.ip}, now found at ${ip}. Updating IP address.`);
        existing.ip = ip;
        existing.client = client;
        existing.lastSeen = Date.now();
        return;
      } else {
        this.log.warn(`Vacuum ${info.systemId} at ${ip} already added, skipping`);
        return;
      }
    }

    // Determine device name
    let deviceName: string;
    if (customName) {
      deviceName = customName;
    } else {
      const customizations = await client.getCustomizations();
      if (customizations?.friendlyName) {
        deviceName = customizations.friendlyName;
      } else {
        // Fetch robot info
        // Only need to fetch info if no customName or friendlyName is set
        const robotInfo = await client.getRobotInfo();
        if (!robotInfo) {
          throw new Error(`Failed to fetch robot info from ${ip}`);
        }
        deviceName = `${robotInfo.manufacturer} ${robotInfo.modelName}`;
      }
    }

    // Create vacuum instance
    const vacuum: VacuumInstance = {
      id: info.systemId,
      ip,
      name: deviceName,
      client,
      device: null,
      pollingInterval: null,
      capabilities: [],
      operationModes: [],
      areaToSegmentMap: new Map(),
      modeMap: new Map(),
      selectedSegmentIds: [],
      selectedRoomNames: [],
      consumableMap: new Map(),
      mapLayersCache: null,
      mapCacheValidUntil: 0,
      lastCurrentArea: null,
      lastConsumablesCheck: 0,
      lastBatteryLevel: null,
      lastBatteryChargeState: null,
      lastOperationalState: null,
      lastRunMode: null,
      initialStatePending: true,
      source,
      lastSeen: Date.now(),
      online: true,
    };

    // Store vacuum
    this.vacuums.set(info.systemId, vacuum);

    this.log.info(`Added vacuum: ${deviceName} (ID: ${info.systemId}, IP: ${ip})`);

    // Initialize the vacuum (fetch capabilities, create device, etc.)
    await this.initializeVacuum(vacuum);
  }

  /**
   * Initialize a vacuum instance (fetch capabilities, create Matter device, start polling)
   */
  private async initializeVacuum(vacuum: VacuumInstance): Promise<void> {
    this.log.info(`Initializing vacuum: ${vacuum.name}`);

    try {
      // Fetch capabilities
      const capabilities = await vacuum.client.getCapabilities();
      if (capabilities) {
        vacuum.capabilities = capabilities;
        this.log.info(`  Capabilities: ${capabilities.join(', ')}`);
      }

      // Create Matter device for this vacuum
      await this.createDeviceForVacuum(vacuum);

      // Start polling for this vacuum
      this.startPollingForVacuum(vacuum);

      this.log.info(`Successfully initialized vacuum: ${vacuum.name}`);
    } catch (error) {
      this.log.error(`Failed to initialize vacuum ${vacuum.name}: ${error instanceof Error ? error.message : String(error)}`);
      vacuum.online = false;
    }
  }

  /**
   * Create Matter device for a vacuum
   */
  private async createDeviceForVacuum(vacuum: VacuumInstance): Promise<void> {
    this.log.info(`Creating Matter device for vacuum: ${vacuum.name}`);

    try {
      // Fetch robot info for device details
      const robotInfo = await vacuum.client.getRobotInfo();
      if (!robotInfo) {
        throw new Error('Failed to fetch robot information');
      }

      // Fetch map segments (rooms/areas) if supported
      let supportedAreas:
        | Array<{
            areaId: number;
            mapId: number | null;
            areaInfo: {
              locationInfo: {
                locationName: string;
                floorNumber: number | null;
                areaType: number | null;
              } | null;
              landmarkInfo: {
                landmarkTag: number;
                relativePositionTag: number | null;
              } | null;
            };
          }>
        | undefined;

      if (vacuum.capabilities.includes('MapSegmentationCapability')) {
        const segments = await vacuum.client.getMapSegments();
        if (segments && segments.length > 0) {
          const usedNames = new Map<string, number>();

          // Don't filter - accept all segments, even unnamed ones
          supportedAreas = segments.map((segment, index) => {
            // Use segment name if available, otherwise use segment ID
            let locationName = (segment.name && segment.name.trim()) || `Segment ${segment.id}`;

            // Handle duplicates
            if (usedNames.has(locationName)) {
              const count = (usedNames.get(locationName) ?? 0) + 1;
              usedNames.set(locationName, count);
              locationName = `${locationName} ${count}`;
            } else {
              usedNames.set(locationName, 1);
            }

            const areaId = index + 1;
            vacuum.areaToSegmentMap.set(areaId, { id: segment.id, name: locationName });

            return {
              areaId,
              mapId: null,
              areaInfo: {
                locationInfo: {
                  locationName,
                  floorNumber: 0,
                  areaType: null,
                },
                landmarkInfo: null,
              },
            };
          });

          if (supportedAreas && supportedAreas.length > 0) {
            this.log.info(`  Found ${supportedAreas.length} areas: ${supportedAreas.map((a) => a.areaInfo.locationInfo?.locationName || 'Unknown').join(', ')}`);
          }
        } else {
          this.log.info(`  No map segments found for ${vacuum.name}`);
        }
      } else {
        this.log.info(`  MapSegmentationCapability not supported for ${vacuum.name}`);
      }

      // Build run modes
      const supportedRunModes: Array<{ label: string; mode: number; modeTags: Array<{ value: number }> }> = [
        { label: 'Idle', mode: RvcRunModeValue.Idle, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
        { label: 'Cleaning', mode: RvcRunModeValue.Cleaning, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
      ];

      if (vacuum.capabilities.includes('MappingPassCapability')) {
        supportedRunModes.push({
          label: 'Mapping',
          mode: RvcRunModeValue.Mapping,
          modeTags: [{ value: RvcRunMode.ModeTag.Mapping }],
        });
      }

      // Build clean modes
      const supportedCleanModes: Array<{ label: string; mode: number; modeTags: Array<{ value: number }> }> = [];

      let fanSpeedPresets: string[] | null = null;
      let waterUsagePresets: string[] | null = null;
      const operatingModes = vacuum.capabilities.includes('OperationModeControlCapability') ? await vacuum.client.getOperationModePresets() : null;

      if (vacuum.capabilities.includes('FanSpeedControlCapability')) {
        const presets = await vacuum.client.getFanSpeedPresets();
        if (presets) {
          fanSpeedPresets = presets.filter((preset) => preset !== 'off');
        }
      }
      if (vacuum.capabilities.includes('WaterUsageControlCapability')) {
        const presets = await vacuum.client.getWaterUsagePresets();
        if (presets) {
          waterUsagePresets = presets.filter((preset) => preset !== 'off');
        }
      }
      const modeMapping = this.getModeMapping();
      const operationModeMap: Record<string, string | undefined> = {
        vacuum: operatingModes?.includes(modeMapping.vacuum) ? modeMapping.vacuum : undefined,
        mop: operatingModes?.includes(modeMapping.mop) ? modeMapping.mop : undefined,
        vacuumAndMop: operatingModes?.includes(modeMapping.vacuumAndMop) ? modeMapping.vacuumAndMop : undefined,
      };

      type OperationModeContext = 'vacuum' | 'mop' | 'vacuum_and_mop';

      const config = this.config as {
        customTags?: Array<{
          operationMode: Array<OperationModeContext>;
          fanSpeed: string;
          waterUsage: string;
          matterModeTag: number;
        }>;
      };

      const customTagMap: Record<OperationModeContext, Record<string, number>> = {
        vacuum: {},
        mop: {},
        vacuum_and_mop: {},
      };
      if (config.customTags && config.customTags.length > 0) {
        for (const customTag of config.customTags) {
          const modeTag = customTag.matterModeTag;
          const contexts: Array<OperationModeContext> = customTag.operationMode;
          for (const ctx of contexts) {
            if (customTag.fanSpeed) {
              customTagMap[ctx][customTag.fanSpeed] = modeTag;
            }
            if (customTag.waterUsage) {
              customTagMap[ctx][customTag.waterUsage] = modeTag;
            }
          }
        }
      }

      const presetToTagMap: Record<string, number> = {
        off: RvcCleanMode.ModeTag.Min,
        min: RvcCleanMode.ModeTag.Min,
        low: RvcCleanMode.ModeTag.Quiet,
        medium: RvcCleanMode.ModeTag.Auto,
        high: RvcCleanMode.ModeTag.Quick,
        max: RvcCleanMode.ModeTag.Max,
        turbo: RvcCleanMode.ModeTag.Max,
      };

      if (fanSpeedPresets) {
        const customTags = customTagMap['vacuum'];
        const modeIdBase = RvcCleanModeBase + vacuum.modeMap.size;
        fanSpeedPresets.forEach((preset, index) => {
          const tag = customTags[preset] ?? presetToTagMap[preset] ?? RvcCleanMode.ModeTag.Auto;
          const modeId = modeIdBase + index;
          const label = `Vacuum (${RvcCleanMode.ModeTag[tag]})`;
          supportedCleanModes.push({
            label: label,
            mode: modeId,
            modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: tag }],
          });

          vacuum.modeMap.set(modeId, {
            fanSpeed: preset,
            waterUsage: undefined,
            operationMode: operationModeMap['vacuum'],
          });
        });
      }
      if (operatingModes?.includes(modeMapping.mop)) {
        const customTags = customTagMap['mop'];
        const modeIdBase = RvcCleanModeBase + vacuum.modeMap.size;
        if (waterUsagePresets) {
          waterUsagePresets.forEach((preset, index) => {
            const tag = customTags[preset] ?? presetToTagMap[preset] ?? RvcCleanMode.ModeTag.Auto;
            const modeId = modeIdBase + index;
            const label = `Mop (${RvcCleanMode.ModeTag[tag]})`;
            supportedCleanModes.push({
              label: label,
              mode: modeId,
              modeTags: [{ value: RvcCleanMode.ModeTag.Mop }, { value: tag }],
            });

            vacuum.modeMap.set(modeId, {
              fanSpeed: undefined,
              waterUsage: preset,
              operationMode: operationModeMap['mop'],
            });
          });
        } else {
          supportedCleanModes.push({
            label: `Mop (Auto)`,
            mode: modeIdBase,
            modeTags: [{ value: RvcCleanMode.ModeTag.Mop }, { value: RvcCleanMode.ModeTag.Auto }],
          });
          vacuum.modeMap.set(modeIdBase, {
            fanSpeed: undefined,
            waterUsage: 'med',
            operationMode: operationModeMap['mop'],
          });
        }
      }
      if (operatingModes?.includes(modeMapping.vacuumAndMop)) {
        const customTags = customTagMap['vacuum_and_mop'];
        const modeIdBase = RvcCleanModeBase + vacuum.modeMap.size;
        if (fanSpeedPresets && waterUsagePresets) {
          const nFanSpeeds = fanSpeedPresets.length;
          const nWaterLevels = waterUsagePresets.length;
          for (let i = 0; i < Math.max(nFanSpeeds, nWaterLevels); i++) {
            const fanSpeed = fanSpeedPresets[i] ?? fanSpeedPresets[nFanSpeeds - 1];
            const waterUsage = waterUsagePresets[i] ?? waterUsagePresets[nWaterLevels - 1];
            const preset = fanSpeedPresets[i] ?? waterUsagePresets[i];
            const tag = customTags[preset] ?? presetToTagMap[preset];
            const modeId = modeIdBase + i;
            const label = `Vacuum & Mop (${RvcCleanMode.ModeTag[tag]})`;
            supportedCleanModes.push({
              label: label,
              mode: modeId,
              modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.Mop }, { value: tag }],
            });
            vacuum.modeMap.set(modeId, {
              fanSpeed: fanSpeed,
              waterUsage: waterUsage,
              operationMode: operationModeMap['vacuumAndMop'],
            });
          }
        }
      }

      if (supportedCleanModes.length === 0) {
        supportedCleanModes.push({
          label: 'Vacuum',
          mode: RvcCleanModeBase,
          modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.Auto }],
        });
        vacuum.modeMap.set(RvcCleanModeBase, {
          fanSpeed: undefined,
          waterUsage: undefined,
          operationMode: undefined,
        });
      }
      this.log.debug(`Supported clean modes: ${JSON.stringify(supportedCleanModes)}`);

      // Create Matter device
      const useServerMode = (this.config as { enableServerMode?: boolean }).enableServerMode === true;

      vacuum.device = new RoboticVacuumCleaner(
        vacuum.name,
        vacuum.id,
        useServerMode ? 'server' : undefined,
        RvcRunModeValue.Idle,
        supportedRunModes,
        supportedCleanModes[0].mode, // we already check .length > 0
        supportedCleanModes,
        null,
        null,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        undefined,
      );

      // Set up command handlers for this vacuum
      this.setupCommandHandlersForVacuum(vacuum);

      // Register device
      vacuum.device.softwareVersion = 1;
      vacuum.device.softwareVersionString = this.version || '1.0.0';
      vacuum.device.hardwareVersion = 1;
      vacuum.device.hardwareVersionString = this.matterbridge.matterbridgeVersion;

      if (!vacuum.device.mode) {
        vacuum.device.createDefaultBridgedDeviceBasicInformationClusterServer(
          vacuum.device.deviceName || vacuum.name,
          vacuum.device.serialNumber || vacuum.id,
          this.matterbridge.aggregatorVendorId,
          vacuum.device.vendorName || 'Valetudo',
          vacuum.device.productName || 'Robot Vacuum',
          vacuum.device.softwareVersion,
          vacuum.device.softwareVersionString,
          vacuum.device.hardwareVersion,
          vacuum.device.hardwareVersionString,
        );
      }

      // After registration, add areas and set currentArea
      await this.registerDevice(vacuum.device);

      this.log.info(`  Matter device created and registered successfully`);

      if (supportedAreas && supportedAreas.length > 0) {
        this.log.info(`  Setting ${supportedAreas.length} supported areas...`);
        this.log.info(`  Area names: ${supportedAreas.map((a) => a.areaInfo.locationInfo?.locationName).join(', ')}`);

        await vacuum.device.setAttribute('ServiceArea', 'supportedAreas', supportedAreas, this.log);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await vacuum.device.setAttribute('ServiceArea', 'currentArea', supportedAreas[0].areaId, this.log);
        vacuum.lastCurrentArea = supportedAreas[0].areaId;
        this.log.info(`  Initial currentArea set to: ${supportedAreas[0].areaId}`);
      } else {
        this.log.warn(`  No supportedAreas to set! supportedAreas is ${supportedAreas ? 'empty array' : 'undefined'}`);
      }

      // Set initial state AFTER registering and setting areas
      await this.setInitialVacuumState(vacuum);

      // Set up consumables for this vacuum
      await this.setupConsumablesForVacuum(vacuum);
    } catch (error) {
      throw new Error(`Failed to create device: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Start polling for a specific vacuum
   */
  private startPollingForVacuum(vacuum: VacuumInstance): void {
    const config = this.config as { pollingInterval?: number };
    const baseInterval = Math.max(5000, Math.min(60000, config.pollingInterval || 30000));

    // Add minimum 10 second delay before first poll to allow subscription to stabilize
    const MIN_INITIAL_DELAY = 10000;

    // Stagger polling intervals to avoid concurrent request spikes
    const vacuumIndex = Array.from(this.vacuums.keys()).indexOf(vacuum.id);
    const staggerOffset = vacuumIndex * 1000; // 1 second stagger per vacuum
    const totalDelay = MIN_INITIAL_DELAY + staggerOffset;

    setTimeout(async () => {
      // Trigger immediate first poll when starting
      try {
        this.log.info(`[${vacuum.name}] Running initial state update...`);
        await this.updateVacuumState(vacuum);
      } catch (error) {
        this.log.error(`[${vacuum.name}] Error in initial poll: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Then start the regular polling interval
      vacuum.pollingInterval = setInterval(async () => {
        try {
          await this.updateVacuumState(vacuum);
        } catch (error) {
          this.log.error(`Error polling vacuum ${vacuum.name}: ${error instanceof Error ? error.message : String(error)}`);
          vacuum.online = false;
        }
      }, baseInterval);

      this.log.info(`Started polling for ${vacuum.name} (${baseInterval}ms interval, ${totalDelay}ms initial delay)`);
    }, totalDelay);
  }

  /**
   * Set up command handlers for a specific vacuum
   */
  private setupCommandHandlersForVacuum(vacuum: VacuumInstance): void {
    if (!vacuum.device) return;

    this.log.info(`Setting up command handlers for vacuum: ${vacuum.name}`);

    // Identify command (locate robot)
    vacuum.device.addCommandHandler('identify', async () => {
      this.log.info(`[${vacuum.name}] Identify/Locate handler called`);
      const success = await vacuum.client.locate();
      if (success) {
        this.log.info(`[${vacuum.name}] Successfully triggered locate sound`);
      } else {
        this.log.error(`[${vacuum.name}] Failed to trigger locate sound`);
      }
    });

    // Change mode command (handles both run mode and clean mode)
    vacuum.device.addCommandHandler('changeToMode', async (data: { request: Record<string, unknown> }) => {
      this.log.info(`[${vacuum.name}] changeToMode called: ${JSON.stringify(data)}`);

      const request = data.request as { newMode: number };
      const isRunMode = request.newMode >= 1 && request.newMode <= 3;

      if (isRunMode) {
        // Run mode change
        if (request.newMode === 2) {
          // Start cleaning
          if (vacuum.selectedSegmentIds.length > 0) {
            this.log.info(`[${vacuum.name}] Starting room cleaning: ${vacuum.selectedRoomNames.join(', ')}`);
            const properties = await vacuum.client.getMapSegmentationProperties();
            await vacuum.client.cleanSegments(vacuum.selectedSegmentIds, 1, properties?.customOrderSupported ?? false);
          } else {
            this.log.info(`[${vacuum.name}] Starting full home cleaning`);
            await vacuum.client.startCleaning();
          }
        } else if (request.newMode === 1) {
          this.log.info(`[${vacuum.name}] Stopping cleaning`);
          await vacuum.client.stopCleaning();
          vacuum.selectedSegmentIds = [];
          vacuum.selectedRoomNames = [];
        }
      } else {
        // Clean mode change
        const modeConfig = vacuum.modeMap.get(request.newMode);
        const fanSpeed = modeConfig?.fanSpeed;
        const waterUsage = modeConfig?.waterUsage;

        if (modeConfig) {
          if (modeConfig.operationMode) {
            this.log.info(`[${vacuum.name}] Setting mode '${modeConfig.operationMode}'`);
            await vacuum.client.setOperationMode(modeConfig.operationMode);
          }

          if (fanSpeed && vacuum.capabilities.includes('FanSpeedControlCapability')) {
            this.log.info(`[${vacuum.name}] Setting fan '${fanSpeed}'`);
            await vacuum.client.setFanSpeed(fanSpeed);
          }

          if (waterUsage && vacuum.capabilities.includes('WaterUsageControlCapability')) {
            this.log.info(`[${vacuum.name}] Setting water '${waterUsage}'`);
            await vacuum.client.setWaterUsage(waterUsage);
          }
        }
      }
    });

    // Pause command
    vacuum.device.addCommandHandler('pause', async () => {
      this.log.info(`[${vacuum.name}] Pause called`);
      await vacuum.client.pauseCleaning();
    });

    // Resume command
    vacuum.device.addCommandHandler('resume', async () => {
      this.log.info(`[${vacuum.name}] Resume called`);
      await vacuum.client.startCleaning();
    });

    // Go home command
    vacuum.device.addCommandHandler('goHome', async () => {
      this.log.info(`[${vacuum.name}] GoHome called`);
      await vacuum.client.returnHome();
    });

    // Select areas command
    vacuum.device.addCommandHandler('selectAreas', async (data: { request: Record<string, unknown> }) => {
      this.log.info(`[${vacuum.name}] selectAreas called: ${JSON.stringify(data)}`);

      const request = data.request as { newAreas?: number[] };

      if (!request.newAreas || request.newAreas.length === 0) {
        vacuum.selectedSegmentIds = [];
        vacuum.selectedRoomNames = [];
        return;
      }

      const segmentIds: string[] = [];
      const roomNames: string[] = [];

      for (const areaId of request.newAreas) {
        const segmentInfo = vacuum.areaToSegmentMap.get(areaId);
        if (segmentInfo) {
          segmentIds.push(segmentInfo.id);
          roomNames.push(segmentInfo.name);
        }
      }

      vacuum.selectedSegmentIds = segmentIds;
      vacuum.selectedRoomNames = roomNames;

      this.log.info(`[${vacuum.name}] Selected rooms: ${roomNames.join(', ')}`);
    });
  }

  /**
   * Get the configured mode mapping with defaults
   */
  private getModeMapping(): { vacuum: string; mop: string; vacuumAndMop: string } {
    const config = this.config as { modeMapping?: { vacuum?: string; mop?: string; vacuumAndMop?: string } };
    return {
      vacuum: config.modeMapping?.vacuum || 'vacuum',
      mop: config.modeMapping?.mop || 'mop',
      vacuumAndMop: config.modeMapping?.vacuumAndMop || 'vacuum_and_mop',
    };
  }

  /**
   * Set up consumables for a specific vacuum
   */
  private async setupConsumablesForVacuum(vacuum: VacuumInstance): Promise<void> {
    const config = this.config as {
      consumables?: {
        enabled?: boolean;
        exposeAsContactSensors?: boolean;
        maxLifetimes?: Record<string, number>;
        warningThreshold?: number;
      };
    };

    if (!config.consumables?.enabled) {
      this.log.debug(`[${vacuum.name}] Consumable tracking disabled`);
      return;
    }

    if (!vacuum.capabilities.includes('ConsumableMonitoringCapability')) {
      this.log.warn(`[${vacuum.name}] ConsumableMonitoringCapability not supported`);
      return;
    }

    const consumables = await vacuum.client.getConsumables();
    if (!consumables || consumables.length === 0) {
      this.log.info(`[${vacuum.name}] No consumables found`);
      return;
    }

    this.log.info(`[${vacuum.name}] Found ${consumables.length} consumables`);

    const maxLifetimes = config.consumables?.maxLifetimes || {
      mainBrush: 18000,
      sideBrush: 12000,
      dustFilter: 9000,
      sensor: 1800,
    };

    const exposeAsContactSensors = config.consumables?.exposeAsContactSensors === true;

    const warningThreshold = config.consumables?.warningThreshold ?? 10;

    for (const consumable of consumables) {
      const name = this.getConsumableName(consumable);
      const maxLifetime = this.getMaxLifetime(consumable, maxLifetimes);
      const remainingMinutes = consumable.remaining.value;
      const lifePercent = Math.round((remainingMinutes / maxLifetime) * 100);
      const needsReplacement = lifePercent <= warningThreshold;

      this.log.info(`  ${name}: ${remainingMinutes}min (${lifePercent}%)`);

      if (exposeAsContactSensors) {
        // Create contact sensor for this consumable
        // Contact sensor: true (closed) = OK, false (open) = needs replacement
        const sensorName = `${vacuum.name} ${name}`;
        const sensorId = `${vacuum.id}-consumable-${consumable.type}-${consumable.subType}`.replace(/[^a-zA-Z0-9-]/g, '_');

        this.log.info(`  Creating contact sensor: ${sensorName} (ID: ${sensorId})`);

        const sensor = new MatterbridgeEndpoint(contactSensor, { id: sensorId }, this.config.debug as boolean);
        sensor.createDefaultBridgedDeviceBasicInformationClusterServer(sensorName, sensorId, this.matterbridge.aggregatorVendorId, 'Valetudo', name);
        sensor.createDefaultBooleanStateClusterServer(!needsReplacement); // true = closed = OK

        await this.registerDevice(sensor);

        vacuum.consumableMap.set(name, { endpoint: sensor, consumable, lastState: needsReplacement });
        this.log.info(`  Contact sensor registered: ${sensorName} (${needsReplacement ? 'OPEN - needs replacement' : 'CLOSED - OK'})`);
      } else {
        vacuum.consumableMap.set(name, { consumable });
      }
    }
  }

  /**
   * Set initial state for a vacuum before device registration
   * This is critical for Apple Home to avoid "updating" status
   */
  private async setInitialVacuumState(vacuum: VacuumInstance): Promise<void> {
    if (!vacuum.device) return;

    try {
      // Get initial state attributes
      const attributes = await vacuum.client.getStateAttributes();
      if (!attributes) {
        this.log.warn(`[${vacuum.name}] Failed to fetch initial state attributes`);
        return;
      }

      // Set initial battery state
      const battery = attributes.find((attr) => attr.__class === 'BatteryStateAttribute') as BatteryStateAttribute | undefined;
      if (battery) {
        const batPercentRemaining = Math.round(battery.level * 2);
        let batChargeState = 0;

        if (battery.flag === 'charging') {
          batChargeState = 1;
        } else if (battery.flag === 'charged') {
          batChargeState = 2;
        } else if (battery.flag === 'discharging' || battery.flag === 'none') {
          batChargeState = 3;
        }

        await vacuum.device.setAttribute('PowerSource', 'batPercentRemaining', batPercentRemaining, this.log);
        await vacuum.device.setAttribute('PowerSource', 'batChargeState', batChargeState, this.log);
        vacuum.lastBatteryLevel = batPercentRemaining;
        vacuum.lastBatteryChargeState = batChargeState;

        this.log.info(`  Initial battery: ${battery.level}% (${batPercentRemaining}/200), charge state: ${batChargeState}`);
      }

      // Set initial operational state and run mode
      const statusAttr = attributes.find((attr) => attr.__class === 'StatusStateAttribute') as { value: string; flag?: string } | undefined;
      const dockStatus = attributes.find((attr) => attr.__class === 'DockStatusStateAttribute') as { value: string } | undefined;

      if (statusAttr) {
        const operationalState = this.mapValetudoStatusToOperationalState(statusAttr.value, dockStatus?.value);
        await vacuum.device.setAttribute('RvcOperationalState', 'operationalState', operationalState, this.log);
        vacuum.lastOperationalState = operationalState;

        const runMode = this.mapValetudoStatusToRunMode(statusAttr.value);
        await vacuum.device.setAttribute('RvcRunMode', 'currentMode', runMode, this.log);
        vacuum.lastRunMode = runMode;

        this.log.info(`  Initial state: "${statusAttr.value}" (operational: ${operationalState}, run mode: ${runMode})`);
      }
    } catch (error) {
      this.log.error(`[${vacuum.name}] Error setting initial state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update state for a specific vacuum
   */
  private async updateVacuumState(vacuum: VacuumInstance): Promise<void> {
    if (!vacuum.device) return;

    try {
      // Get state attributes (single call for battery, status, dock status, etc.)
      const attributes = await vacuum.client.getStateAttributes();
      if (!attributes) {
        this.log.warn(`[${vacuum.name}] Failed to fetch state attributes`);
        return;
      }

      // Update battery state
      const battery = attributes.find((attr) => attr.__class === 'BatteryStateAttribute') as BatteryStateAttribute | undefined;
      if (battery) {
        const batPercentRemaining = Math.round(battery.level * 2);
        let batChargeState = 0;

        if (battery.flag === 'charging') {
          batChargeState = 1;
        } else if (battery.flag === 'charged') {
          batChargeState = 2;
        } else if (battery.flag === 'discharging' || battery.flag === 'none') {
          batChargeState = 3;
        }

        // Only send updates when values actually change or on initial state
        const batteryChanged = vacuum.lastBatteryLevel !== batPercentRemaining;
        const chargeStateChanged = vacuum.lastBatteryChargeState !== batChargeState;

        if (vacuum.initialStatePending || batteryChanged) {
          this.log.info(`[${vacuum.name}] Battery: ${battery.level}% (${batPercentRemaining}/200)`);
          await vacuum.device.setAttribute('PowerSource', 'batPercentRemaining', batPercentRemaining, this.log);
          vacuum.lastBatteryLevel = batPercentRemaining;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (vacuum.initialStatePending || chargeStateChanged) {
          this.log.info(`[${vacuum.name}] Battery charge state: ${batChargeState}`);
          await vacuum.device.setAttribute('PowerSource', 'batChargeState', batChargeState, this.log);
          vacuum.lastBatteryChargeState = batChargeState;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Delay before next attribute updates
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Extract status and dock status from the same attributes (no extra API call!)
      const statusAttr = attributes.find((attr) => attr.__class === 'StatusStateAttribute') as { value: string; flag?: string } | undefined;
      const dockStatus = attributes.find((attr) => attr.__class === 'DockStatusStateAttribute') as { value: string } | undefined;

      if (statusAttr) {
        const status = statusAttr;
        // Update operational state
        const operationalState = this.mapValetudoStatusToOperationalState(status.value, dockStatus?.value);
        const operationalStateChanged = vacuum.lastOperationalState !== operationalState;

        if (vacuum.initialStatePending || operationalStateChanged) {
          this.log.info(`[${vacuum.name}] Operational state: "${status.value}" → ${operationalState}`);
          await vacuum.device.setAttribute('RvcOperationalState', 'operationalState', operationalState, this.log);
          vacuum.lastOperationalState = operationalState;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        // Update run mode
        const runMode = this.mapValetudoStatusToRunMode(status.value);
        const runModeChanged = vacuum.lastRunMode !== runMode;

        if (vacuum.initialStatePending || runModeChanged) {
          this.log.info(`[${vacuum.name}] Run mode: ${status.value} → ${runMode === 1 ? 'Idle' : 'Cleaning'}`);
          await vacuum.device.setAttribute('RvcRunMode', 'currentMode', runMode, this.log);
          vacuum.lastRunMode = runMode;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Clear initial state pending flag after first successful update
      if (vacuum.initialStatePending) {
        vacuum.initialStatePending = false;
        this.log.debug(`[${vacuum.name}] Initial state set successfully`);
      }

      // Small delay before next API call to avoid overwhelming vacuum's HTTP server
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Position tracking with cached map layers
      const config = this.config as { positionTracking?: { enabled?: boolean } };
      if (config.positionTracking?.enabled !== false && vacuum.areaToSegmentMap.size > 0) {
        try {
          // Initialize or refresh cache if needed
          if (!vacuum.mapLayersCache || Date.now() > vacuum.mapCacheValidUntil) {
            await this.refreshMapCacheForVacuum(vacuum);
          }

          // Skip position tracking if cache still not available
          if (!vacuum.mapLayersCache) {
            this.log.debug(`[${vacuum.name}] Map cache not available, skipping position tracking`);
          } else {
            const positionData = await vacuum.client.getMapPositionData();
            if (positionData) {
              // Check map version
              if (positionData.metaData?.version !== undefined && positionData.metaData.version !== vacuum.mapLayersCache.version) {
                this.log.warn(`[${vacuum.name}] Map version changed, refreshing cache...`);
                await this.refreshMapCacheForVacuum(vacuum);
              }

              // Extract robot position
              const robotEntity = positionData.entities.find((entity) => entity.type === 'robot_position');
              if (robotEntity && robotEntity.points.length >= 2 && vacuum.mapLayersCache) {
                const robotPos = {
                  x: Math.round(robotEntity.points[0] / vacuum.mapLayersCache.pixelSize),
                  y: Math.round(robotEntity.points[1] / vacuum.mapLayersCache.pixelSize),
                };

                const currentSegment = vacuum.client.findSegmentAtPositionCached(vacuum.mapLayersCache, robotPos.x, robotPos.y);

                if (currentSegment) {
                  let foundAreaId: number | null = null;
                  for (const [areaId, segmentInfo] of vacuum.areaToSegmentMap.entries()) {
                    if (segmentInfo.id === currentSegment.metaData.segmentId) {
                      foundAreaId = areaId;
                      break;
                    }
                  }

                  if (foundAreaId !== null && vacuum.lastCurrentArea !== foundAreaId) {
                    const segmentInfo = vacuum.areaToSegmentMap.get(foundAreaId);
                    this.log.info(`[${vacuum.name}] Location: ${segmentInfo?.name || 'Unknown'} (area ${foundAreaId})`);
                    await vacuum.device.setAttribute('ServiceArea', 'currentArea', foundAreaId, this.log);
                    vacuum.lastCurrentArea = foundAreaId;
                  }
                }
              }
            }
          }
        } catch (error) {
          this.log.debug(`[${vacuum.name}] Position tracking error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Update consumables if enabled
      if (vacuum.consumableMap.size > 0) {
        await this.updateConsumableStatesForVacuum(vacuum);
      }

      vacuum.lastSeen = Date.now();
      vacuum.online = true;
    } catch (error) {
      this.log.error(`[${vacuum.name}] Error updating state: ${error instanceof Error ? error.message : String(error)}`);
      vacuum.online = false;
    }
  }

  /**
   * Refresh map cache for a specific vacuum
   */
  private async refreshMapCacheForVacuum(vacuum: VacuumInstance): Promise<void> {
    const config = this.config as { mapCache?: { refreshIntervalHours?: number } };
    const refreshHours = Math.max(0.1, Math.min(24, config.mapCache?.refreshIntervalHours ?? 1));

    const mapData = await vacuum.client.getMapDataWithTimeout(60000);
    if (mapData) {
      vacuum.mapLayersCache = vacuum.client.createCachedLayers(mapData);
      vacuum.mapCacheValidUntil = Date.now() + refreshHours * 60 * 60 * 1000;
      this.log.debug(`[${vacuum.name}] Map cache refreshed`);
    }
  }

  /**
   * Update consumable states for a specific vacuum
   */
  private async updateConsumableStatesForVacuum(vacuum: VacuumInstance): Promise<void> {
    // Only check consumables every 5 minutes to reduce API load
    const CONSUMABLES_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    if (now - vacuum.lastConsumablesCheck < CONSUMABLES_CHECK_INTERVAL) {
      return; // Skip this check
    }

    vacuum.lastConsumablesCheck = now;

    const config = this.config as {
      consumables?: {
        maxLifetimes?: Record<string, number>;
        warningThreshold?: number;
      };
    };

    const maxLifetimes = config.consumables?.maxLifetimes || {
      mainBrush: 18000,
      sideBrush: 12000,
      dustFilter: 9000,
      sensor: 1800,
    };
    const warningThreshold = config.consumables?.warningThreshold || 10;

    try {
      const consumables = await vacuum.client.getConsumables();
      if (!consumables) return;

      for (const consumable of consumables) {
        const name = this.getConsumableName(consumable);
        const entry = vacuum.consumableMap.get(name);

        if (!entry) continue;

        const maxLifetime = this.getMaxLifetime(consumable, maxLifetimes);
        const remainingMinutes = consumable.remaining.value;
        const lifePercent = Math.round((remainingMinutes / maxLifetime) * 100);

        entry.consumable = consumable;
        const needsReplacement = lifePercent <= warningThreshold;

        // Log status change
        if (entry.lastState === undefined || entry.lastState !== needsReplacement) {
          const status = needsReplacement ? '⚠️ NEEDS REPLACEMENT' : '✓ OK';
          this.log.info(`[${vacuum.name}] ${name}: ${remainingMinutes}min (${lifePercent}%) - ${status}`);
          entry.lastState = needsReplacement;
        }

        // Update contact sensor if it exists
        if (entry.endpoint) {
          await entry.endpoint.setAttribute('BooleanState', 'stateValue', !needsReplacement, this.log);
        }
      }
    } catch (error) {
      this.log.debug(`[${vacuum.name}] Error updating consumables: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Map Valetudo status to Matter RVC Operational State
   */
  private mapValetudoStatusToOperationalState(status: string, dockStatus?: string): number {
    const statusLower = status.toLowerCase();

    const statusMap: Record<string, number> = {
      idle: OperationalStateValue.Docked,
      docked: OperationalStateValue.Docked,
      cleaning: OperationalStateValue.Running,
      returning: OperationalStateValue.SeekingCharger,
      manual_control: OperationalStateValue.Running,
      moving: OperationalStateValue.Docked,
      paused: OperationalStateValue.Paused,
      error: OperationalStateValue.Error,
      charging: OperationalStateValue.Charging,
    };

    const baseState = statusMap[statusLower] ?? OperationalStateValue.Stopped;

    if (dockStatus && (statusLower === 'docked' || statusLower === 'idle' || statusLower === 'charging')) {
      const dockStatusLower = dockStatus.toLowerCase();
      if (dockStatusLower === 'emptying' || dockStatusLower === 'drying' || dockStatusLower === 'cleaning') {
        return OperationalStateValue.Docked;
      }
    }

    return baseState;
  }

  /**
   * Map Valetudo status to RvcRunMode
   */
  private mapValetudoStatusToRunMode(status: string): number {
    const statusLower = status.toLowerCase();

    if (statusLower === 'cleaning') {
      return RvcRunModeValue.Cleaning;
    }

    return RvcRunModeValue.Idle;
  }

  /**
   * Get fan and water settings from mode number
   */
  /*
  private getIntensitySettings(mode: number): { fan: string; water: string } {
    let intensityKey: 'auto' | 'quiet' | 'quick' | 'max';
    let defaultFan: string;
    let defaultWater: string;

    if (mode >= RvcCleanModeValue.VacuumQuiet && mode <= RvcCleanModeValue.VacuumTurbo) {
      const offset = mode - RvcCleanModeValue.VacuumQuiet;
      const offsetMap: Record<number, { key: 'auto' | 'quiet' | 'quick' | 'max'; fan: string; water: string }> = {
        0: { key: 'quiet', fan: 'low', water: 'low' },
        1: { key: 'auto', fan: 'medium', water: 'medium' },
        2: { key: 'quick', fan: 'high', water: 'high' },
        3: { key: 'max', fan: 'max', water: 'high' },
        4: { key: 'max', fan: 'turbo', water: 'high' },
      };
      const mapping = offsetMap[offset] || offsetMap[1];
      intensityKey = mapping.key;
      defaultFan = mapping.fan;
      defaultWater = mapping.water;
    } else if (mode >= RvcCleanModeValue.MopMin && mode <= RvcCleanModeValue.MopHigh) {
      const modeMap: Record<number, { key: 'auto' | 'quiet' | 'quick' | 'max'; fan: string; water: string }> = {
        [RvcCleanModeValue.MopMin]: { key: 'auto', fan: 'medium', water: 'medium' },
        [RvcCleanModeValue.MopLow]: { key: 'quiet', fan: 'low', water: 'low' },
        [RvcCleanModeValue.MopMedium]: { key: 'quick', fan: 'high', water: 'high' },
        [RvcCleanModeValue.MopHigh]: { key: 'max', fan: 'max', water: 'high' },
      };
      const mapping = modeMap[mode] || modeMap[RvcCleanModeValue.MopMin];
      intensityKey = mapping.key;
      defaultFan = mapping.fan;
      defaultWater = mapping.water;
    } else if (mode >= RvcCleanModeValue.VacuumMopQuiet && mode <= RvcCleanModeValue.VacuumMopTurbo) {
      const offset = mode - RvcCleanModeValue.VacuumMopQuiet;
      const offsetMap: Record<number, { key: 'auto' | 'quiet' | 'quick' | 'max'; fan: string; water: string }> = {
        0: { key: 'quiet', fan: 'low', water: 'low' },
        1: { key: 'auto', fan: 'medium', water: 'medium' },
        2: { key: 'quick', fan: 'high', water: 'high' },
        3: { key: 'max', fan: 'max', water: 'high' },
        4: { key: 'max', fan: 'turbo', water: 'high' },
      };
      const mapping = offsetMap[offset] || offsetMap[1];
      intensityKey = mapping.key;
      defaultFan = mapping.fan;
      defaultWater = mapping.water;
    } else {
      return { fan: 'medium', water: 'medium' };
    }

    const config = this.config as {
      intensityPresets?: {
        auto?: { fanSpeed?: string; waterUsage?: string };
        quiet?: { fanSpeed?: string; waterUsage?: string };
        quick?: { fanSpeed?: string; waterUsage?: string };
        max?: { fanSpeed?: string; waterUsage?: string };
      };
    };

    const overrides = config.intensityPresets?.[intensityKey];

    return {
      fan: overrides?.fanSpeed || defaultFan,
      water: overrides?.waterUsage || defaultWater,
    };
  }
  */

  /**
   * Get friendly name for a consumable
   */
  private getConsumableName(consumable: ValetudoConsumable): string {
    const typeMap: Record<string, string> = {
      'brush-main': 'Main Brush',
      'brush-side_right': 'Side Brush',
      'brush-side_left': 'Side Brush Left',
      'filter-main': 'Dust Filter',
      'cleaning-sensor': 'Sensor',
      'cleaning-wheel': 'Wheel',
      'consumable-detergent': 'Detergent',
    };
    const key = `${consumable.type}-${consumable.subType}`;

    // Check for 'dock' in subType (e.g., "detergent dock")
    if (consumable.subType.includes('dock')) {
      return 'Detergent';
    }

    return typeMap[key] || `${consumable.type} ${consumable.subType}`;
  }

  /**
   * Get maximum lifetime for a consumable type from config
   */
  private getMaxLifetime(consumable: ValetudoConsumable, maxLifetimes: Record<string, number>): number {
    // Special handling for percentage-based consumables (detergent, etc.)
    // These have remaining values in 0-100 range representing percentage
    if (consumable.remaining.value <= 100 && consumable.remaining.value >= 0) {
      // Check if this looks like a percentage (detergent typically reports 0-100)
      const isPercentage = consumable.type === 'consumable' || consumable.subType.includes('detergent') || consumable.subType.includes('dock');
      if (isPercentage) {
        return 100; // Max is 100%
      }
    }

    let key: string;
    if (consumable.type === 'brush' && consumable.subType === 'main') {
      key = 'mainBrush';
    } else if (consumable.type === 'brush' && (consumable.subType === 'side_right' || consumable.subType === 'side_left')) {
      key = 'sideBrush';
    } else if (consumable.type === 'filter' && consumable.subType === 'main') {
      key = 'dustFilter';
    } else if (consumable.type === 'cleaning' && consumable.subType === 'sensor') {
      key = 'sensor';
    } else {
      return 10000;
    }

    return maxLifetimes[key] || 10000;
  }

  /**
   * Start periodic discovery if configured
   */
  private startPeriodicDiscovery(): void {
    const config = this.config as {
      discovery?: { enabled?: boolean; scanIntervalSeconds?: number };
    };

    // Don't start periodic discovery if mDNS discovery is disabled
    const discoveryEnabled = config.discovery?.enabled !== false;
    if (!discoveryEnabled) {
      this.log.debug('Periodic mDNS discovery not started (mDNS discovery is disabled)');
      return;
    }

    const intervalSeconds = config.discovery?.scanIntervalSeconds || 0;

    if (intervalSeconds > 0) {
      const intervalMs = intervalSeconds * 1000;
      this.log.info(`Starting periodic mDNS discovery (every ${intervalSeconds} seconds)`);

      this.discoveryInterval = setInterval(async () => {
        this.log.info('Running periodic mDNS discovery...');
        await this.discoverAndAddVacuums();
      }, intervalMs);
    }
  }

  private async discoverDevices() {
    this.log.info('Discovering Valetudo devices with multi-vacuum support...');

    // Load manually configured vacuums
    await this.loadManualVacuums();

    // Run mDNS discovery
    await this.discoverAndAddVacuums();

    if (this.vacuums.size === 0) {
      this.log.error('No vacuums found! Please configure vacuums manually or enable mDNS discovery.');
      return;
    }

    this.log.info(`Successfully configured ${this.vacuums.size} vacuum(s)`);

    // Start periodic discovery if configured
    this.startPeriodicDiscovery();
  }
}
