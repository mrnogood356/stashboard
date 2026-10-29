import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

export type DiscoverableService = 'STASH' | 'WHISPARR' | 'PROWLARR' | 'SABNZBD';

export interface DiscoveredService {
  type: DiscoverableService;
  /** The address Stashboard reached it on, ready to save. */
  url: string;
  /** Where in that app its API key is shown. */
  keyHelpUrl: string;
}

export interface DiscoveryResponse {
  found: DiscoveredService[];
  /** How many addresses were tried, for "Checked 24 places". */
  checked: number;
}

/** The ports each app listens on out of the box. */
const DEFAULT_PORTS: Record<DiscoverableService, number[]> = {
  STASH: [9999],
  WHISPARR: [6969],
  PROWLARR: [9696],
  SABNZBD: [8080, 8085],
};

/** Container names people usually give them in a compose file. */
const CONTAINER_NAMES: Record<DiscoverableService, string[]> = {
  STASH: ['stash'],
  WHISPARR: ['whisparr'],
  PROWLARR: ['prowlarr'],
  SABNZBD: ['sabnzbd'],
};

const KEY_PAGES: Record<DiscoverableService, string> = {
  STASH: '/settings?tab=security',
  WHISPARR: '/settings/general',
  PROWLARR: '/settings/general',
  SABNZBD: '/config/general/',
};

const PROBE_TIMEOUT_MS = 1500;
/** Enough of a page to read its <title>. */
const MAX_BODY_BYTES = 64 * 1024;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Setup's "Find my services": tries the usual ports on the few places Stash,
 * Whisparr, Prowlarr and SABnzbd tend to live (the address you opened
 * Stashboard on, the Docker host, their usual container names) and keeps what
 * answers as that app. Only those fixed ports, only private addresses.
 */
@Injectable()
export class ServiceDiscoveryService {
  private readonly logger = new Logger(ServiceDiscoveryService.name);

  constructor(
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly routeTable: () => Promise<string> = () =>
      readFile('/proc/net/route', 'utf8'),
  ) {}

  async discover(requestHost: string | undefined): Promise<DiscoveryResponse> {
    const hosts = await this.candidateHosts(requestHost);
    const attempts: { type: DiscoverableService; url: string }[] = [];
    for (const type of Object.keys(DEFAULT_PORTS) as DiscoverableService[]) {
      for (const host of [...hosts, ...CONTAINER_NAMES[type]]) {
        for (const port of DEFAULT_PORTS[type]) {
          attempts.push({ type, url: `http://${formatHost(host)}:${port}` });
        }
      }
    }

    const results = await Promise.all(
      attempts.map(async (attempt) =>
        (await this.identify(attempt.type, attempt.url)) ? attempt : null,
      ),
    );

    // The first place each app answers wins; the hosts are in order of preference.
    const found: DiscoveredService[] = [];
    for (const result of results) {
      if (result && !found.some((entry) => entry.type === result.type)) {
        found.push({
          type: result.type,
          url: result.url,
          keyHelpUrl: `${result.url}${KEY_PAGES[result.type]}`,
        });
      }
    }
    this.logger.log(
      `Looked for services in ${attempts.length} places; found ${
        found.map((entry) => `${entry.type} at ${entry.url}`).join(', ') ||
        'none'
      }.`,
    );
    return { found, checked: attempts.length };
  }

  /**
   * The address you opened Stashboard on comes first: it's one your browser
   * can reach too, so "Open in Stash" links work. Then the Docker host and
   * this machine.
   */
  private async candidateHosts(
    requestHost: string | undefined,
  ): Promise<string[]> {
    const hosts: string[] = [];
    const fromRequest = hostnameOf(requestHost);
    if (fromRequest && isPrivateHost(fromRequest)) {
      hosts.push(fromRequest);
    }
    const gateway = await this.dockerGateway();
    if (gateway) {
      hosts.push(gateway);
    }
    hosts.push('host.docker.internal', '127.0.0.1');
    return [...new Set(hosts)];
  }

  /** The default route's gateway: the Docker host, seen from a container. */
  private async dockerGateway(): Promise<string | null> {
    try {
      const table = await this.routeTable();
      for (const line of table.split('\n').slice(1)) {
        const [, destination, gateway] = line.trim().split(/\s+/);
        if (destination === '00000000' && gateway && gateway !== '00000000') {
          const bytes = gateway.match(/../g)?.map((pair) => parseInt(pair, 16));
          return bytes && bytes.length === 4 ? bytes.reverse().join('.') : null;
        }
      }
    } catch {
      // Not Linux, or no route table: skip it.
    }
    return null;
  }

  private async identify(
    type: DiscoverableService,
    base: string,
  ): Promise<boolean> {
    try {
      if (type === 'SABNZBD') {
        for (const path of [
          '/api?mode=version&output=json',
          '/sabnzbd/api?mode=version&output=json',
        ]) {
          const body = await this.read(`${base}${path}`);
          if (body && /"version"\s*:/.test(body)) {
            return true;
          }
        }
        return false;
      }
      const body = await this.read(`${base}/`);
      if (!body) {
        return false;
      }
      const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1] ?? '';
      const name = {
        STASH: 'Stash',
        WHISPARR: 'Whisparr',
        PROWLARR: 'Prowlarr',
      }[type];
      return new RegExp(`\\b${name}\\b`, 'i').test(title);
    } catch {
      return false;
    }
  }

  private async read(url: string): Promise<string | null> {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
      headers: { Accept: 'text/html,application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    return text.slice(0, MAX_BODY_BYTES);
  }
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/** Only addresses on your own network: never send probes out to the internet. */
export function isPrivateHost(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    const lower = host.toLowerCase();
    return lower === '::1' || lower.startsWith('fd') || lower.startsWith('fc');
  }
  // A bare name (unraid, nas, stash.local) is resolved on the local network.
  return (
    !host.includes('.') || host.endsWith('.local') || host.endsWith('.lan')
  );
}

function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
