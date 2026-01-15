/**
 * Valetudo API Client
 *
 * @file valetudo-client.ts
 * @description Client for communicating with Valetudo REST API
 */

import * as http from 'node:http';

import { AnsiLogger } from 'matterbridge/logger';

// ============================================================================
// Type Definitions
// ============================================================================

export interface ValetudoInfo {
  embedded: boolean;
  systemId: string;
  welcomeDialogDismissed: boolean;
}

export interface ValetudoRobotInfo {
  manufacturer: string;
  modelName: string;
  modelDetails: {
    supportedAttachments: ('dustbin' | 'watertank' | 'mop')[];
  };
  implementation: string;
}

export type BatteryFlag = 'none' | 'charging' | 'discharging' | 'charged';
export type AttachmentType = 'dustbin' | 'watertank' | 'mop';
export type PresetType = 'fan_speed' | 'water_grade' | 'operation_mode';
export type PresetValue = 'off' | 'min' | 'low' | 'medium' | 'high' | 'max' | 'turbo' | 'custom' | 'vacuum' | 'mop' | 'vacuum_and_mop' | 'vacuum_then_mop';

export interface BatteryStateAttribute {
  __class: 'BatteryStateAttribute';
  type: 'BatteryStateAttribute';
  level: number;
  flag: BatteryFlag;
}

export interface AttachmentStateAttribute {
  __class: 'AttachmentStateAttribute';
  type: AttachmentType;
  attached: boolean;
}

export interface PresetSelectionStateAttribute {
  __class: 'PresetSelectionStateAttribute';
  type: PresetType;
  value: PresetValue;
  customValue?: number;
}

export interface StatusStateAttribute {
  __class: 'StatusStateAttribute';
  type: 'StatusStateAttribute';
  value: string;
  flag?: string;
}

export interface DockStatusStateAttribute {
  __class: 'DockStatusStateAttribute';
  type: 'DockStatusStateAttribute';
  value: 'docked' | 'undocked' | 'emptying' | 'drying' | 'cleaning';
}

export type StateAttribute = BatteryStateAttribute | AttachmentStateAttribute | PresetSelectionStateAttribute | StatusStateAttribute | DockStatusStateAttribute;

export interface MapSegment {
  id: string;
  name: string;
  metaData: Record<string, unknown>;
}

export interface ConsumableRemaining {
  value: number;
  unit: 'percent' | 'minutes';
}

export interface ValetudoConsumable {
  __class: 'ValetudoConsumable';
  type: string;
  subType: string;
  remaining: ConsumableRemaining;
}

export interface ValetudoDataPoint {
  timestamp: string;
  type: 'time' | 'area' | 'count';
  value: number;
  metaData?: Record<string, unknown>;
}

export interface MapSegmentationProperties {
  iterationCount: {
    min: number;
    max: number;
  };
  customOrderSupported: boolean;
}

export interface MapEntity {
  __class: string;
  metaData?: Record<string, unknown>;
  points: number[];
  type: string;
}

export interface MapLayerDimensions {
  x: {
    min: number;
    max: number;
    mid: number;
    avg: number;
  };
  y: {
    min: number;
    max: number;
    mid: number;
    avg: number;
  };
  pixelCount: number;
}

export interface MapLayer {
  __class: string;
  metaData: {
    segmentId: string;
    active?: boolean;
    source?: string;
    name?: string;
    area?: number;
  };
  type: string;
  pixels: number[];
  dimensions: MapLayerDimensions;
  compressedPixels: number[];
}

export interface MapData {
  __class: string;
  metaData: {
    version: number;
  };
  size: {
    x: number;
    y: number;
  };
  pixelSize: number;
  layers: MapLayer[];
  entities: MapEntity[];
}

/**
 * Cached map layers for efficient position tracking
 * Contains only the segment boundary data needed for position lookups
 */
export interface CachedMapLayers {
  layers: MapLayer[];
  size: { x: number; y: number };
  pixelSize: number;
  timestamp: number; // When cache was created
  version: number; // Map version from metaData
}

/**
 * Lightweight position-only map response
 * Contains only entities for position tracking
 */
export interface MapPositionData {
  entities: MapEntity[];
  metaData?: { version: number };
}

// ============================================================================
// Valetudo Client
// ============================================================================

export class ValetudoClient {
  private baseUrl: string;
  private log: AnsiLogger;
  private authUsername: string | undefined = undefined;
  private authPassword: string | undefined = undefined;

  constructor(ip: string, log: AnsiLogger, username?: string, password?: string) {
    this.baseUrl = `http://${ip}`;
    this.log = log;
    this.authUsername = username;
    this.authPassword = password;
  }

  /**
   * Get the Authorization header for HTTP basic auth
   * @returns Headers object with Authorization header if credentials are set, or empty headers
   */
  private getAuthHeaders(): Record<string, string> {
    if (this.authUsername && this.authPassword) {
      const credentials = Buffer.from(`${this.authUsername}:${this.authPassword}`).toString('base64');
      return {
        'Authorization': `Basic ${credentials}`,
        'accept': 'application/json',
      };
    }
    return {
      'accept': 'application/json',
    };
  }

  // ==========================================================================
  // General Information
  // ==========================================================================

  /**
   * Fetch basic Valetudo information
   */
  async getInfo(): Promise<ValetudoInfo | null> {
    try {
      const url = `${this.baseUrl}/api/v2/valetudo`;
      this.log.debug(`Fetching Valetudo info from: ${url}`);

      const data = await this.httpGet(url);
      this.log.debug(`Valetudo info received: ${JSON.stringify(data)}`);
      return data as ValetudoInfo;
    } catch (error) {
      this.log.error(`Error fetching Valetudo info: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Get robot information
   */
  async getRobotInfo(): Promise<ValetudoRobotInfo | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot`);
      return data as ValetudoRobotInfo;
    } catch (error) {
      this.log.error(`Error fetching robot info: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Get supported capabilities
   */
  async getCapabilities(): Promise<string[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities`);
      return data as string[];
    } catch (error) {
      this.log.error(`Error fetching capabilities: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ==========================================================================
  // State Monitoring
  // ==========================================================================

  /**
   * Get robot state attributes (battery, attachments, presets)
   */
  async getStateAttributes(): Promise<StateAttribute[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/state/attributes`);
      return data as StateAttribute[];
    } catch (error) {
      this.log.error(`Error fetching state attributes: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ==========================================================================
  // Basic Control
  // ==========================================================================

  /**
   * Execute basic control command
   *
   * @param action
   */
  async executeBasicControl(action: 'start' | 'stop' | 'pause' | 'home'): Promise<boolean> {
    try {
      const result = await this.httpPut(`${this.baseUrl}/api/v2/robot/capabilities/BasicControlCapability`, {
        action,
      });
      return result !== null;
    } catch (error) {
      this.log.error(`Error executing basic control (${action}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Start cleaning
   */
  async start(): Promise<boolean> {
    return this.executeBasicControl('start');
  }

  /**
   * Stop cleaning
   */
  async stop(): Promise<boolean> {
    return this.executeBasicControl('stop');
  }

  /**
   * Pause cleaning
   */
  async pause(): Promise<boolean> {
    return this.executeBasicControl('pause');
  }

  /**
   * Return to dock
   */
  async home(): Promise<boolean> {
    return this.executeBasicControl('home');
  }

  /**
   * Start cleaning (alias for start)
   */
  async startCleaning(): Promise<boolean> {
    return this.start();
  }

  /**
   * Stop cleaning (alias for stop)
   */
  async stopCleaning(): Promise<boolean> {
    return this.stop();
  }

  /**
   * Pause cleaning (alias for pause)
   */
  async pauseCleaning(): Promise<boolean> {
    return this.pause();
  }

  /**
   * Return home (alias for home)
   */
  async returnHome(): Promise<boolean> {
    return this.home();
  }

  // ==========================================================================
  // Preset Controls
  // ==========================================================================

  /**
   * Get available fan speed presets
   */
  async getFanSpeedPresets(): Promise<string[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities/FanSpeedControlCapability/presets`);
      return data as string[];
    } catch (error) {
      this.log.error(`Error fetching fan speed presets: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Set fan speed preset
   *
   * @param preset
   */
  async setFanSpeed(preset: string): Promise<boolean> {
    try {
      const result = await this.httpPut(`${this.baseUrl}/api/v2/robot/capabilities/FanSpeedControlCapability/preset`, {
        name: preset,
      });
      return result !== null;
    } catch (error) {
      this.log.error(`Error setting fan speed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Get available water usage presets
   */
  async getWaterUsagePresets(): Promise<string[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities/WaterUsageControlCapability/presets`);
      return data as string[];
    } catch (error) {
      this.log.error(`Error fetching water usage presets: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Set water usage preset
   *
   * @param preset
   */
  async setWaterUsage(preset: string): Promise<boolean> {
    try {
      const result = await this.httpPut(`${this.baseUrl}/api/v2/robot/capabilities/WaterUsageControlCapability/preset`, {
        name: preset,
      });
      return result !== null;
    } catch (error) {
      this.log.error(`Error setting water usage: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Get available operation mode presets
   */
  async getOperationModePresets(): Promise<string[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities/OperationModeControlCapability/presets`);
      return data as string[];
    } catch (error) {
      this.log.error(`Error fetching operation mode presets: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Set operation mode preset (vacuum, mop, vacuum_and_mop, etc.)
   *
   * @param preset
   */
  async setOperationMode(preset: string): Promise<boolean> {
    try {
      const result = await this.httpPut(`${this.baseUrl}/api/v2/robot/capabilities/OperationModeControlCapability/preset`, {
        name: preset,
      });
      return result !== null;
    } catch (error) {
      this.log.error(`Error setting operation mode: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // ==========================================================================
  // Segment/Room Cleaning
  // ==========================================================================

  /**
   * Get available map segments (rooms)
   */
  async getMapSegments(): Promise<MapSegment[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities/MapSegmentationCapability`);
      return data as MapSegment[];
    } catch (error) {
      this.log.error(`Error fetching map segments: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Get map segmentation properties (iteration support, custom order support)
   */
  async getMapSegmentationProperties(): Promise<MapSegmentationProperties | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities/MapSegmentationCapability/properties`);
      return data as MapSegmentationProperties;
    } catch (error) {
      this.log.error(`Error fetching map segmentation properties: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Clean specific segments/rooms
   *
   * @param segmentIds
   * @param iterations
   * @param customOrder
   */
  async cleanSegments(segmentIds: string[], iterations = 1, customOrder = false): Promise<boolean> {
    try {
      const payload = {
        action: 'start_segment_action',
        segment_ids: segmentIds,
        iterations,
        customOrder,
      };
      this.log.debug(`cleanSegments: ${JSON.stringify(payload)}`);
      const result = await this.httpPut(`${this.baseUrl}/api/v2/robot/capabilities/MapSegmentationCapability`, payload);
      return result !== null;
    } catch (error) {
      this.log.error(`Error cleaning segments: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Get full map data with extended timeout for initial caching
   * Used during startup to populate the map cache
   *
   * @param timeoutMs - Timeout in milliseconds
   * @returns Map data or null if fetch fails
   */
  async getMapDataWithTimeout(timeoutMs: number): Promise<MapData | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/state/map`, timeoutMs);
      return data as MapData;
    } catch (error) {
      this.log.error(`Error fetching map data: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Get only position data from map (still calls full endpoint but extracts only entities)
   * In the future, this could be optimized if Valetudo adds a position-only endpoint
   *
   * @returns Position data with entities and metadata version
   */
  async getMapPositionData(): Promise<MapPositionData | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/state/map`);
      const mapData = data as MapData;

      // Return only what we need for position tracking
      return {
        entities: mapData.entities,
        metaData: mapData.metaData,
      };
    } catch (error) {
      this.log.error(`Error fetching position data: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Find which segment contains a given point using cached layers
   * This is a static method that works with cached data
   *
   * @param cachedLayers - Cached map layers
   * @param x - X coordinate
   * @param y - Y coordinate
   * @returns The segment layer containing the point, or null if not found
   */
  findSegmentAtPositionCached(cachedLayers: CachedMapLayers, x: number, y: number): MapLayer | null {
    const segments = cachedLayers.layers.filter((layer) => layer.type === 'segment');

    // Find all segments whose bounds contain this position
    const matchingSegments: Array<{ segment: MapLayer; distance: number }> = [];

    for (const segment of segments) {
      const dims = segment.dimensions;
      const inBounds = x >= dims.x.min && x <= dims.x.max && y >= dims.y.min && y <= dims.y.max;

      if (inBounds) {
        // Calculate distance from segment midpoint
        const distanceFromMid = Math.sqrt(Math.pow(x - dims.x.mid, 2) + Math.pow(y - dims.y.mid, 2));
        matchingSegments.push({ segment, distance: distanceFromMid });
      }
    }

    if (matchingSegments.length === 0) {
      return null;
    }

    if (matchingSegments.length === 1) {
      return matchingSegments[0].segment;
    }

    // Multiple segments contain this position - use closest midpoint
    matchingSegments.sort((a, b) => a.distance - b.distance);
    const closest = matchingSegments[0];
    this.log.debug(`Multiple segments at (${x}, ${y}) - selected "${closest.segment.metaData.segmentId}" (closest midpoint, distance: ${closest.distance.toFixed(1)})`);

    return closest.segment;
  }

  /**
   * Create cached layers from full map data
   *
   * @param mapData - Full map data from Valetudo
   * @returns Cached layers suitable for position tracking
   */
  createCachedLayers(mapData: MapData): CachedMapLayers {
    return {
      layers: mapData.layers,
      size: mapData.size,
      pixelSize: mapData.pixelSize,
      timestamp: Date.now(),
      version: mapData.metaData.version,
    };
  }

  // ==========================================================================
  // Additional Features
  // ==========================================================================

  /**
   * Locate robot (play sound)
   */
  async locate(): Promise<boolean> {
    try {
      const result = await this.httpPut(`${this.baseUrl}/api/v2/robot/capabilities/LocateCapability`, {
        action: 'locate',
      });
      return result !== null;
    } catch (error) {
      this.log.error(`Error locating robot: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Get consumables status (brush, filter, etc.)
   */
  async getConsumables(): Promise<ValetudoConsumable[] | null> {
    try {
      const data = await this.httpGet(`${this.baseUrl}/api/v2/robot/capabilities/ConsumableMonitoringCapability`);
      return data as ValetudoConsumable[];
    } catch (error) {
      this.log.error(`Error fetching consumables: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ==========================================================================
  // HTTP Methods
  // ==========================================================================

  /**
   * Perform HTTP GET request
   *
   * @param url - The URL to fetch
   * @param timeoutMs - Optional timeout in milliseconds (default: 10000)
   * @throws {Error} If the request fails or times out
   */
  private async httpGet(url: string, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs ?? 10000; // Default 10 second timeout, allow override
      let timeoutId: NodeJS.Timeout | null = null;

      const req = http
        .get(url, { headers: this.getAuthHeaders() }, (res) => {
          let data = '';

          if (res.statusCode !== 200) {
            const error = new Error(`HTTP GET failed with status code: ${res.statusCode} for ${url}`);
            this.log.error(error.message);
            reject(error);
            return;
          }

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (timeoutId) clearTimeout(timeoutId);
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (error) {
              const parseError = new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`);
              this.log.error(parseError.message);
              reject(parseError);
            }
          });
        })
        .on('error', (error) => {
          if (timeoutId) clearTimeout(timeoutId);
          this.log.error(`HTTP GET error: ${error.message}`);
          reject(error);
        });

      // Set timeout
      timeoutId = setTimeout(() => {
        req.destroy();
        const timeoutError = new Error(`HTTP GET request timed out after ${timeout}ms for ${url}`);
        this.log.error(timeoutError.message);
        reject(timeoutError);
      }, timeout);
    });
  }

  /**
   * Perform HTTP PUT request
   *
   * @param url
   * @param body
   * @throws {Error} If the request fails or times out
   */
  private async httpPut(url: string, body: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = 10000; // 10 second timeout
      let timeoutId: NodeJS.Timeout | null = null;

      const bodyString = JSON.stringify(body);
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyString),
          'Accept': 'application/json',
          ...this.getAuthHeaders(),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';

        if (res.statusCode !== 200) {
          const error = new Error(`HTTP PUT failed with status code: ${res.statusCode} for ${url}`);
          this.log.error(error.message);
          reject(error);
          return;
        }

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (timeoutId) clearTimeout(timeoutId);
          try {
            if (data) {
              // Try to parse as JSON, but if it fails and data is just "OK", treat as success
              try {
                const parsed = JSON.parse(data);
                resolve(parsed);
              } catch {
                // If parse fails but response is "OK" or similar success text, treat as success
                if (data.trim() === 'OK' || data.trim() === 'ok') {
                  resolve({ success: true });
                } else {
                  const parseError = new Error(`Failed to parse JSON response: ${data}`);
                  this.log.error(parseError.message);
                  reject(parseError);
                }
              }
            } else {
              resolve({}); // Success with empty response
            }
          } catch (error) {
            const handleError = new Error(`Failed to handle response: ${error instanceof Error ? error.message : String(error)}`);
            this.log.error(handleError.message);
            reject(handleError);
          }
        });
      });

      req.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        this.log.error(`HTTP PUT error: ${error.message}`);
        reject(error);
      });

      // Set timeout
      timeoutId = setTimeout(() => {
        req.destroy();
        const timeoutError = new Error(`HTTP PUT request timed out after ${timeout}ms for ${url}`);
        this.log.error(timeoutError.message);
        reject(timeoutError);
      }, timeout);

      req.write(bodyString);
      req.end();
    });
  }

  /**
   * Test connection to Valetudo
   */
  async testConnection(): Promise<boolean> {
    const info = await this.getInfo();
    return info !== null;
  }
}
