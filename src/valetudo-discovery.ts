/**
 * Valetudo mDNS Discovery Module
 *
 * Discovers Valetudo vacuum instances on the local network using multicast DNS (mDNS).
 * Queries for _http._tcp.local service type and filters for Valetudo devices by checking
 * TXT records for identifying fields (id, model, manufacturer, version).
 */

import multicastdns from 'multicast-dns';
import { AnsiLogger } from 'matterbridge/logger';

/** DNS record with name and optional data field */
interface DnsRecord {
  name: string;
  type: string;
  data?: unknown;
}

/**
 * Discovered Valetudo vacuum information
 */
export interface DiscoveredVacuum {
  /** IP address of the vacuum */
  ip: string;
  /** Port number (usually 80) */
  port: number;
  /** Hostname from mDNS */
  hostname: string;
  /** Additional TXT record data */
  txt?: Record<string, string>;
}

/**
 * mDNS Discovery class for Valetudo vacuums
 */
export class ValetudoDiscovery {
  private mdns: multicastdns.MulticastDNS | null = null;
  private log: AnsiLogger;

  constructor(log: AnsiLogger) {
    this.log = log;
  }

  /**
   * Discover Valetudo vacuums on the local network
   *
   * @param timeoutMs - Discovery timeout in milliseconds (default: 5000)
   * @returns Array of discovered vacuums
   */
  public async discover(timeoutMs: number = 5000): Promise<DiscoveredVacuum[]> {
    return new Promise((resolve, reject) => {
      const discovered = new Map<string, DiscoveredVacuum>();

      // Collect all instance names and records across all responses
      const instanceNames = new Set<string>();
      const allRecords: { srv: DnsRecord[]; a: DnsRecord[]; txt: DnsRecord[] } = {
        srv: [],
        a: [],
        txt: [],
      };

      let queryTimeout: NodeJS.Timeout | undefined;

      try {
        // Create mDNS instance
        this.mdns = multicastdns();

        // Set up response handler - collect all records across responses
        this.mdns.on('response', (response) => {
          try {
            // Collect PTR records for _http._tcp.local services
            const httpPtrRecords = response.answers.filter((answer) => answer.type === 'PTR' && answer.name === '_http._tcp.local');

            for (const ptrRecord of httpPtrRecords) {
              if ('data' in ptrRecord && typeof ptrRecord.data === 'string') {
                const instanceName = ptrRecord.data;

                // Only add if we haven't seen it before
                if (!instanceNames.has(instanceName)) {
                  instanceNames.add(instanceName);
                  this.log.debug(`Found HTTP service: ${instanceName}`);

                  // Send follow-up queries for this specific instance
                  if (this.mdns) {
                    this.mdns.query({
                      questions: [
                        { name: instanceName, type: 'SRV' },
                        { name: instanceName, type: 'TXT' },
                        { name: instanceName, type: 'A' },
                      ],
                    });
                  }
                }
              }
            }

            // Collect SRV records and query for their A records
            const srvRecords = response.answers.filter((answer) => answer.type === 'SRV');
            if (srvRecords.length > 0) {
              // For each SRV record, query for the A record of its target hostname
              for (const srvRecord of srvRecords) {
                if ('data' in srvRecord && srvRecord.data) {
                  const srvData = srvRecord.data as { target?: string };
                  if (srvData.target && this.mdns) {
                    this.mdns.query({
                      questions: [{ name: srvData.target, type: 'A' }],
                    });
                  }
                }
              }
            }
            allRecords.srv.push(...srvRecords);

            // Collect A records
            const aRecords = response.answers.filter((answer) => answer.type === 'A');
            allRecords.a.push(...aRecords);

            // Collect TXT records
            const txtRecords = response.answers.filter((answer) => answer.type === 'TXT');
            allRecords.txt.push(...txtRecords);
          } catch (error) {
            this.log.error(`Error processing mDNS response: ${error instanceof Error ? error.message : String(error)}`);
          }
        });

        // Set up error handler
        this.mdns.on('error', (error) => {
          this.log.error(`mDNS error: ${error.message}`);
        });

        // Send query for HTTP services (Valetudo broadcasts as _http._tcp.local)
        this.log.info('Querying for _http._tcp.local services...');
        this.mdns.query({
          questions: [
            {
              name: '_http._tcp.local',
              type: 'PTR',
            },
          ],
        });

        this.log.info(`mDNS query sent, waiting ${timeoutMs}ms for responses...`);

        // Set timeout to resolve after specified duration
        queryTimeout = setTimeout(() => {
          this.log.debug(`Discovery timeout reached, processing ${instanceNames.size} collected service(s)`);

          // Now correlate all collected records for each instance
          for (const instanceName of instanceNames) {
            try {
              // Find matching SRV record
              const srvRecord = allRecords.srv.find((r) => r.name === instanceName);
              if (!srvRecord) {
                this.log.debug(`No SRV record found for ${instanceName}`);
                continue;
              }

              const srvData = srvRecord.data as { port: number; target: string };
              const port = srvData?.port || 80;
              const targetHostname = srvData?.target || '';

              // Find matching A record
              let ip = '';
              const aRecord = allRecords.a.find((r) => r.name === targetHostname);
              if (aRecord && 'data' in aRecord) {
                ip = aRecord.data as string;
              }

              if (!ip) {
                this.log.debug(`No IP found for ${instanceName}`);
                continue;
              }

              // Find matching TXT record
              const txtRecord = allRecords.txt.find((r) => r.name === instanceName);
              const txt: Record<string, string> = {};

              if (txtRecord && 'data' in txtRecord) {
                const txtData = txtRecord.data;
                if (Array.isArray(txtData)) {
                  for (const entry of txtData) {
                    if (Buffer.isBuffer(entry)) {
                      const str = entry.toString('utf8');
                      const [key, ...valueParts] = str.split('=');
                      if (key) {
                        txt[key] = valueParts.join('=') || '';
                      }
                    }
                  }
                }
              }

              // Filter: Only accept Valetudo devices
              if (!txt.id) {
                this.log.debug(`Skipping ${instanceName} - no Valetudo 'id' field`);
                continue;
              }

              const hasValetudoFields = txt.model || txt.manufacturer || txt.version;
              if (!hasValetudoFields) {
                this.log.debug(`Skipping ${instanceName} - missing Valetudo metadata`);
                continue;
              }

              // Add to discovered vacuums
              if (!discovered.has(ip)) {
                const hostname = instanceName.replace(/\._http\._tcp\.local$/, '').replace(/\.local$/, '');

                discovered.set(ip, {
                  ip,
                  port,
                  hostname,
                  txt: Object.keys(txt).length > 0 ? txt : undefined,
                });

                this.log.info(`Discovered Valetudo vacuum at ${ip}:${port} (${hostname}, id: ${txt.id}, model: ${txt.model || 'unknown'})`);
              }
            } catch (error) {
              this.log.error(`Error processing instance ${instanceName}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          this.cleanup();
          resolve(Array.from(discovered.values()));
        }, timeoutMs);
      } catch (error) {
        if (queryTimeout) clearTimeout(queryTimeout);
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * Clean up mDNS instance
   */
  public destroy(): void {
    this.cleanup();
  }

  /**
   * Internal cleanup method
   */
  private cleanup(): void {
    if (this.mdns) {
      try {
        this.mdns.destroy();
      } catch (error) {
        this.log.debug(`Error destroying mDNS: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.mdns = null;
    }
  }
}
