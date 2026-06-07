import { vi, describe, beforeEach, it, expect } from 'vitest';
import { AnsiLogger } from 'matterbridge/logger';

import { ValetudoClient, MapData, MapLayer, CachedMapLayers } from '../src/valetudo-client.ts';

// Capture state for the mocked HTTP layer (hoisted so the vi.mock factory can use it)
const httpState = vi.hoisted(() => ({ lastOptions: undefined as { method?: string; path?: string } | undefined, lastBody: undefined as string | undefined }));

// Mock node:http so control-command PUTs resolve successfully and we can assert path/body.
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    request: (options: { method?: string; path?: string }, cb: (res: unknown) => void) => {
      httpState.lastOptions = options;
      const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      res.statusCode = 200;
      res.resume = () => {};
      cb(res);
      process.nextTick(() => res.emit('end'));
      const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void; destroy: () => void };
      req.write = (b: string) => {
        httpState.lastBody = b;
      };
      req.end = () => {};
      req.destroy = () => {};
      return req;
    },
    get: () => {
      const req = new EventEmitter() as EventEmitter & { destroy: () => void };
      req.destroy = () => {};
      return req;
    },
  };
});

const mockLog = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as AnsiLogger;

describe('ValetudoClient', () => {
  let client: ValetudoClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ValetudoClient('192.168.1.100', mockLog);
  });

  describe('constructor', () => {
    it('should create a client with the correct base URL', () => {
      const testClient = new ValetudoClient('192.168.1.200', mockLog);
      expect(testClient).toBeInstanceOf(ValetudoClient);
    });

    it('should handle IPv6 addresses', () => {
      const testClient = new ValetudoClient('fe80::1', mockLog);
      expect(testClient).toBeInstanceOf(ValetudoClient);
    });

    it('should handle hostnames', () => {
      const testClient = new ValetudoClient('robot.local', mockLog);
      expect(testClient).toBeInstanceOf(ValetudoClient);
    });
  });

  // ==========================================================================
  // Segment Position Logic (pure logic, no HTTP mocking needed)
  // ==========================================================================

  describe('findSegmentAtPositionCached', () => {
    const createCachedLayers = (segments: Partial<MapLayer>[]): CachedMapLayers => ({
      layers: segments.map((s, i) => ({
        __class: 'MapLayer',
        type: 'segment',
        pixels: [],
        compressedPixels: [],
        metaData: { segmentId: `segment_${i}`, ...s.metaData },
        dimensions: s.dimensions || {
          x: { min: 0, max: 100, mid: 50, avg: 50 },
          y: { min: 0, max: 100, mid: 50, avg: 50 },
          pixelCount: 10000,
        },
      })) as MapLayer[],
      size: { x: 1000, y: 1000 },
      pixelSize: 5,
      timestamp: Date.now(),
      version: 1,
    });

    it('should find a segment containing the given position', () => {
      const cachedLayers = createCachedLayers([
        {
          metaData: { segmentId: 'kitchen' },
          dimensions: {
            x: { min: 200, max: 300, mid: 250, avg: 250 },
            y: { min: 100, max: 200, mid: 150, avg: 150 },
            pixelCount: 10000,
          },
        },
      ]);

      const segment = client.findSegmentAtPositionCached(cachedLayers, 250, 150);
      expect(segment).not.toBeNull();
      expect(segment?.metaData.segmentId).toBe('kitchen');
    });

    it('should find segment when position is at edge of bounds', () => {
      const cachedLayers = createCachedLayers([
        {
          metaData: { segmentId: 'room' },
          dimensions: {
            x: { min: 100, max: 200, mid: 150, avg: 150 },
            y: { min: 100, max: 200, mid: 150, avg: 150 },
            pixelCount: 10000,
          },
        },
      ]);

      // Test edge cases - exactly at boundaries
      expect(client.findSegmentAtPositionCached(cachedLayers, 100, 100)?.metaData.segmentId).toBe('room');
      expect(client.findSegmentAtPositionCached(cachedLayers, 200, 200)?.metaData.segmentId).toBe('room');
      expect(client.findSegmentAtPositionCached(cachedLayers, 100, 200)?.metaData.segmentId).toBe('room');
      expect(client.findSegmentAtPositionCached(cachedLayers, 200, 100)?.metaData.segmentId).toBe('room');
    });

    it('should select closest segment when position is in overlapping bounds', () => {
      const cachedLayers = createCachedLayers([
        {
          metaData: { segmentId: 'room_a' },
          dimensions: {
            x: { min: 0, max: 150, mid: 75, avg: 75 },
            y: { min: 0, max: 100, mid: 50, avg: 50 },
            pixelCount: 10000,
          },
        },
        {
          metaData: { segmentId: 'room_b' },
          dimensions: {
            x: { min: 50, max: 200, mid: 125, avg: 125 },
            y: { min: 0, max: 100, mid: 50, avg: 50 },
            pixelCount: 10000,
          },
        },
      ]);

      // Position 70, 50 is closer to room_a's midpoint (75, 50) than room_b's (125, 50)
      const segment = client.findSegmentAtPositionCached(cachedLayers, 70, 50);
      expect(segment?.metaData.segmentId).toBe('room_a');
    });

    it('should select room_b when position is closer to its midpoint', () => {
      const cachedLayers = createCachedLayers([
        {
          metaData: { segmentId: 'room_a' },
          dimensions: {
            x: { min: 0, max: 150, mid: 75, avg: 75 },
            y: { min: 0, max: 100, mid: 50, avg: 50 },
            pixelCount: 10000,
          },
        },
        {
          metaData: { segmentId: 'room_b' },
          dimensions: {
            x: { min: 50, max: 200, mid: 125, avg: 125 },
            y: { min: 0, max: 100, mid: 50, avg: 50 },
            pixelCount: 10000,
          },
        },
      ]);

      // Position 130, 50 is closer to room_b's midpoint (125, 50) than room_a's (75, 50)
      const segment = client.findSegmentAtPositionCached(cachedLayers, 130, 50);
      expect(segment?.metaData.segmentId).toBe('room_b');
    });

    it('should return null if position is not within any segment', () => {
      const cachedLayers = createCachedLayers([
        {
          metaData: { segmentId: 'only_room' },
          dimensions: {
            x: { min: 0, max: 100, mid: 50, avg: 50 },
            y: { min: 0, max: 100, mid: 50, avg: 50 },
            pixelCount: 10000,
          },
        },
      ]);

      const segment = client.findSegmentAtPositionCached(cachedLayers, 999, 999);
      expect(segment).toBeNull();
    });

    it('should return null for empty cached layers', () => {
      const cachedLayers: CachedMapLayers = {
        layers: [],
        size: { x: 1000, y: 1000 },
        pixelSize: 5,
        timestamp: Date.now(),
        version: 1,
      };

      const segment = client.findSegmentAtPositionCached(cachedLayers, 50, 50);
      expect(segment).toBeNull();
    });

    it('should filter out non-segment layers', () => {
      const cachedLayers: CachedMapLayers = {
        layers: [
          {
            __class: 'MapLayer',
            type: 'floor',
            pixels: [],
            compressedPixels: [],
            metaData: { segmentId: 'floor' },
            dimensions: {
              x: { min: 0, max: 1000, mid: 500, avg: 500 },
              y: { min: 0, max: 1000, mid: 500, avg: 500 },
              pixelCount: 1000000,
            },
          },
          {
            __class: 'MapLayer',
            type: 'segment',
            pixels: [],
            compressedPixels: [],
            metaData: { segmentId: 'kitchen' },
            dimensions: {
              x: { min: 100, max: 200, mid: 150, avg: 150 },
              y: { min: 100, max: 200, mid: 150, avg: 150 },
              pixelCount: 10000,
            },
          },
        ] as MapLayer[],
        size: { x: 1000, y: 1000 },
        pixelSize: 5,
        timestamp: Date.now(),
        version: 1,
      };

      // Position is in floor bounds but only kitchen segment should be considered
      const segment = client.findSegmentAtPositionCached(cachedLayers, 150, 150);
      expect(segment?.metaData.segmentId).toBe('kitchen');
    });

    it('should handle multiple segments with no overlaps', () => {
      const cachedLayers = createCachedLayers([
        {
          metaData: { segmentId: 'kitchen' },
          dimensions: {
            x: { min: 0, max: 100, mid: 50, avg: 50 },
            y: { min: 0, max: 100, mid: 50, avg: 50 },
            pixelCount: 10000,
          },
        },
        {
          metaData: { segmentId: 'bedroom' },
          dimensions: {
            x: { min: 200, max: 300, mid: 250, avg: 250 },
            y: { min: 200, max: 300, mid: 250, avg: 250 },
            pixelCount: 10000,
          },
        },
        {
          metaData: { segmentId: 'bathroom' },
          dimensions: {
            x: { min: 400, max: 500, mid: 450, avg: 450 },
            y: { min: 400, max: 500, mid: 450, avg: 450 },
            pixelCount: 10000,
          },
        },
      ]);

      expect(client.findSegmentAtPositionCached(cachedLayers, 50, 50)?.metaData.segmentId).toBe('kitchen');
      expect(client.findSegmentAtPositionCached(cachedLayers, 250, 250)?.metaData.segmentId).toBe('bedroom');
      expect(client.findSegmentAtPositionCached(cachedLayers, 450, 450)?.metaData.segmentId).toBe('bathroom');
      // Position between segments
      expect(client.findSegmentAtPositionCached(cachedLayers, 150, 150)).toBeNull();
    });
  });

  describe('createCachedLayers', () => {
    it('should create cached layers from map data', () => {
      const mapData: MapData = {
        __class: 'ValetudoMap',
        metaData: { version: 5 },
        size: { x: 2000, y: 1500 },
        pixelSize: 5,
        layers: [
          {
            __class: 'MapLayer',
            type: 'segment',
            pixels: [1, 2, 3],
            compressedPixels: [],
            metaData: { segmentId: 'test' },
            dimensions: {
              x: { min: 0, max: 100, mid: 50, avg: 50 },
              y: { min: 0, max: 100, mid: 50, avg: 50 },
              pixelCount: 100,
            },
          },
        ],
        entities: [],
      };

      const cached = client.createCachedLayers(mapData);

      expect(cached.version).toBe(5);
      expect(cached.size).toEqual({ x: 2000, y: 1500 });
      expect(cached.pixelSize).toBe(5);
      expect(cached.layers).toHaveLength(1);
      expect(cached.timestamp).toBeGreaterThan(0);
    });

    it('should preserve all layer data', () => {
      const mapData: MapData = {
        __class: 'ValetudoMap',
        metaData: { version: 10 },
        size: { x: 3000, y: 2000 },
        pixelSize: 10,
        layers: [
          {
            __class: 'MapLayer',
            type: 'segment',
            pixels: [1, 2, 3, 4, 5],
            compressedPixels: [10, 20],
            metaData: { segmentId: 'room1', name: 'Kitchen', area: 50000 },
            dimensions: {
              x: { min: 100, max: 500, mid: 300, avg: 290 },
              y: { min: 200, max: 600, mid: 400, avg: 380 },
              pixelCount: 50000,
            },
          },
          {
            __class: 'MapLayer',
            type: 'floor',
            pixels: [],
            compressedPixels: [],
            metaData: { segmentId: 'floor_0' },
            dimensions: {
              x: { min: 0, max: 3000, mid: 1500, avg: 1500 },
              y: { min: 0, max: 2000, mid: 1000, avg: 1000 },
              pixelCount: 500000,
            },
          },
        ],
        entities: [],
      };

      const cached = client.createCachedLayers(mapData);

      expect(cached.layers).toHaveLength(2);
      expect(cached.layers[0].metaData.name).toBe('Kitchen');
      expect(cached.layers[0].metaData.area).toBe(50000);
      expect(cached.layers[0].dimensions.x.min).toBe(100);
      expect(cached.layers[1].type).toBe('floor');
    });

    it('should handle empty layers array', () => {
      const mapData: MapData = {
        __class: 'ValetudoMap',
        metaData: { version: 1 },
        size: { x: 1000, y: 1000 },
        pixelSize: 5,
        layers: [],
        entities: [],
      };

      const cached = client.createCachedLayers(mapData);

      expect(cached.layers).toHaveLength(0);
      expect(cached.version).toBe(1);
    });
  });

  // ==========================================================================
  // Control commands (HTTP PUT) — mock node:http to capture path/body
  // ==========================================================================

  describe('control commands', () => {
    beforeEach(() => {
      httpState.lastOptions = undefined;
      httpState.lastBody = undefined;
    });

    it('triggerAutoEmpty PUTs the AutoEmptyDockManualTriggerCapability with action "trigger"', async () => {
      const ok = await client.triggerAutoEmpty();
      expect(ok).toBe(true);
      expect(httpState.lastOptions?.method).toBe('PUT');
      expect(httpState.lastOptions?.path).toBe('/api/v2/robot/capabilities/AutoEmptyDockManualTriggerCapability');
      expect(JSON.parse(httpState.lastBody ?? '{}')).toEqual({ action: 'trigger' });
    });

    it('locate PUTs the LocateCapability with action "locate"', async () => {
      const ok = await client.locate();
      expect(ok).toBe(true);
      expect(httpState.lastOptions?.path).toBe('/api/v2/robot/capabilities/LocateCapability');
      expect(JSON.parse(httpState.lastBody ?? '{}')).toEqual({ action: 'locate' });
    });

    it('returnHome PUTs BasicControlCapability with action "home"', async () => {
      const ok = await client.returnHome();
      expect(ok).toBe(true);
      expect(httpState.lastOptions?.path).toBe('/api/v2/robot/capabilities/BasicControlCapability');
      expect(JSON.parse(httpState.lastBody ?? '{}')).toEqual({ action: 'home' });
    });
  });
});
