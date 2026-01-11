# Matterbridge Valetudo Plugin

[![npm version](https://img.shields.io/npm/v/matterbridge-valetudo.svg)](https://www.npmjs.com/package/matterbridge-valetudo)
[![npm downloads](https://img.shields.io/npm/dt/matterbridge-valetudo.svg)](https://www.npmjs.com/package/matterbridge-valetudo)
[![license](https://img.shields.io/npm/l/matterbridge-valetudo.svg)](https://github.com/JGtHb/matterbridge-valetudo/blob/main/LICENSE)

[![powered by](https://img.shields.io/badge/powered%20by-matterbridge-blue)](https://www.npmjs.com/package/matterbridge)
[![powered by](https://img.shields.io/badge/powered%20by-valetudo-blue)](https://valetudo.cloud/)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that exposes [Valetudo](https://valetudo.cloud/)-enabled robot vacuums to Apple Home, Google Home, Amazon Alexa, and other Matter-compatible smart home platforms.

## Features

- **Multi-vacuum support** - Control multiple Valetudo vacuums from a single plugin
- **Automatic mDNS discovery** - Automatically finds Valetudo vacuums on your network
- **Full Matter RVC support** - Implements the Matter Robot Vacuum Cleaner device type
- **Room-by-room cleaning** - Select specific rooms/segments to clean
- **Multiple cleaning modes** - Vacuum only, mop only, or vacuum & mop combined
- **Intensity control** - Quiet, auto, quick, and max intensity presets
- **Battery monitoring** - Real-time battery level and charging status
- **Consumable tracking** - Monitor brush, filter, and sensor lifetimes
- **Position tracking** - See which room the vacuum is currently in
- **Apple Home compatible** - Full support via server mode

## Requirements

- [Matterbridge](https://github.com/Luligu/matterbridge) v3.4.0 or later
- A robot vacuum running [Valetudo](https://valetudo.cloud/)
- Node.js 20.x, 22.x, or 24.x

## Installation

### From npm (Recommended)

```bash
npm install -g matterbridge-valetudo
```

Then add the plugin to Matterbridge:

```bash
matterbridge -add matterbridge-valetudo
```

### From Source

1. Clone the repository:
   ```bash
   git clone https://github.com/yJGtHb/matterbridge-valetudo.git
   cd matterbridge-valetudo
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Link to Matterbridge:
   ```bash
   npm link matterbridge
   matterbridge -add .
   ```

## Configuration

Configure the plugin through the Matterbridge web UI or by editing the config file directly.

### Basic Configuration

The plugin works out of the box with automatic mDNS discovery. Simply enable the plugin and it will find your Valetudo vacuums automatically.

### Manual Vacuum Configuration

If auto-discovery doesn't find your vacuum, add it manually:

```json
{
  "name": "matterbridge-valetudo",
  "type": "DynamicPlatform",
  "vacuums": [
    {
      "ip": "192.168.1.100",
      "name": "Living Room Vacuum",
      "enabled": true
    }
  ]
}
```

### Full Configuration Options

```json
{
  "name": "matterbridge-valetudo",
  "type": "DynamicPlatform",
  "discovery": {
    "enabled": true,
    "timeout": 5000,
    "scanIntervalSeconds": 300
  },
  "vacuums": [],
  "pollingInterval": 30000,
  "enableServerMode": false,
  "positionTracking": {
    "enabled": true
  },
  "consumables": {
    "enabled": true,
    "warningThreshold": 10,
    "exposeAsContactSensors": false,
    "maxLifetimes": {
      "mainBrush": 18000,
      "sideBrush": 12000,
      "dustFilter": 9000,
      "sensor": 1800
    }
  },
  "mapCache": {
    "enabled": true,
    "refreshIntervalHours": 1,
    "refreshOnError": true
  },
  "debug": false
}
```

### Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `discovery.enabled` | boolean | `true` | Enable automatic mDNS discovery |
| `discovery.timeout` | number | `5000` | Discovery timeout in milliseconds |
| `discovery.scanIntervalSeconds` | number | `300` | Periodic re-scan interval (0 = once at startup) |
| `vacuums` | array | `[]` | Manually configured vacuums |
| `vacuums[].ip` | string | required | IP address or hostname |
| `vacuums[].name` | string | auto | Custom friendly name |
| `vacuums[].enabled` | boolean | `true` | Enable/disable this vacuum |
| `pollingInterval` | number | `30000` | Status polling interval (5000-60000ms) |
| `enableServerMode` | boolean | `false` | Enable for Apple Home support |
| `positionTracking.enabled` | boolean | `true` | Track current room during cleaning |
| `consumables.enabled` | boolean | `true` | Enable consumable monitoring |
| `consumables.warningThreshold` | number | `10` | Warning threshold percentage |
| `consumables.exposeAsContactSensors` | boolean | `false` | Create contact sensors for consumables |

## Apple Home Setup

Apple Home requires **server mode** to be enabled. This creates a separate Matter device for each vacuum with its own QR code.

### Configuration for Apple Home

1. Set `enableServerMode: true` in your config
2. Restart Matterbridge
3. Each vacuum will have its own commissioning QR code
4. Add each vacuum to Apple Home separately

## Usage

### Cleaning Modes

The plugin exposes the following cleaning modes based on your vacuum's capabilities:

- **Vacuum Only** - Quiet, Auto, Quick, Max intensities
- **Mop Only** - Min, Low, Medium, High water levels
- **Vacuum & Mop** - Combined modes with intensity variants

### Room Selection

If your vacuum supports map segmentation:

1. Rooms appear as selectable areas in your smart home app
2. Select one or more rooms
3. Start cleaning to clean only selected rooms
4. Clear selection to clean the entire home

### Commands

| Command | Description |
|---------|-------------|
| Start/Clean | Begin cleaning (selected rooms or full home) |
| Stop | Stop cleaning and stay in place |
| Pause | Pause cleaning |
| Resume | Resume paused cleaning |
| Return Home | Return to charging dock |
| Locate | Play a sound to find the vacuum |

## Consumable Sensors

When `consumables.exposeAsContactSensors` is enabled, each consumable creates a contact sensor:

- **Closed** = Consumable is OK
- **Open** = Consumable needs replacement (below warning threshold)

This allows you to create automations when consumables need attention.

## Troubleshooting

### Vacuum not discovered

1. Verify your vacuum is running Valetudo with mDNS enabled
2. Check that mDNS is working on your network
3. Workaround - Add the vacuum manually using the `vacuums` config array

### Device stuck on "Updating..." in Apple Home

This is usually caused by a port conflict, e.g. running Homebridge and Matterbridge on the same server:

1. Configure a unique Matter port
2. Restart Matterbridge and re-add the device to Apple Home

## Development

### Building

```bash
npm run build          # Development build
npm run buildProduction  # Production build (no source maps)
```

### Testing

```bash
npm test              # Run tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run with coverage report
```

### Linting & Formatting

```bash
npm run lint          # Check for linting errors
npm run lint:fix      # Auto-fix linting errors
npm run format        # Format code with Prettier
```

### Project Structure

```
src/
  module.ts           # Main plugin class
  valetudo-client.ts  # Valetudo REST API client
  valetudo-discovery.ts  # mDNS discovery
```

## License

Apache-2.0

## Acknowledgments

- [Matterbridge](https://github.com/Luligu/matterbridge) by Luca Liguori
- [Valetudo](https://valetudo.cloud/) by Soren Beye
- [Matter.js](https://github.com/project-chip/matter.js) for Matter protocol implementation
