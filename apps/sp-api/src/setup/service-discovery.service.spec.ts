import {
  ServiceDiscoveryService,
  isPrivateHost,
} from './service-discovery.service';

const page = (title: string) =>
  new Response(`<html><head><title>${title}</title></head></html>`, {
    status: 200,
  });

describe('ServiceDiscoveryService', () => {
  // Docker's default bridge: gateway 172.17.0.1, written little-endian in hex.
  const routes = () =>
    Promise.resolve(
      'Iface\tDestination\tGateway\n' +
        'eth0\t00000000\t010011AC\t0003\n' +
        'eth0\t000011AC\t00000000\t0001\n',
    );

  it('finds each app on the address Stashboard was opened on first, then the Docker host', async () => {
    const fetcher = jest.fn((url: string) => {
      if (url === 'http://192.168.1.50:9999/')
        return Promise.resolve(page('Stash'));
      if (url === 'http://172.17.0.1:9999/')
        return Promise.resolve(page('Stash'));
      if (url === 'http://172.17.0.1:6969/')
        return Promise.resolve(page('Whisparr'));
      if (url === 'http://192.168.1.50:9696/')
        return Promise.resolve(page('Sonarr'));
      if (url === 'http://sabnzbd:8080/api?mode=version&output=json')
        return Promise.resolve(new Response('{"version":"4.3.2"}'));
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const service = new ServiceDiscoveryService(fetcher, routes);

    const result = await service.discover('192.168.1.50:3000');

    expect(result.found).toEqual([
      {
        type: 'STASH',
        url: 'http://192.168.1.50:9999',
        keyHelpUrl: 'http://192.168.1.50:9999/settings?tab=security',
      },
      {
        type: 'WHISPARR',
        url: 'http://172.17.0.1:6969',
        keyHelpUrl: 'http://172.17.0.1:6969/settings/general',
      },
      {
        type: 'SABNZBD',
        url: 'http://sabnzbd:8080',
        keyHelpUrl: 'http://sabnzbd:8080/config/general/',
      },
    ]);
    // A different app on Prowlarr's port isn't taken for Prowlarr.
    expect(result.found.some((entry) => entry.type === 'PROWLARR')).toBe(false);
    // 4 hosts plus the app's usual container name, on each usual port (SABnzbd has two).
    expect(result.checked).toBe(25);
  });

  it('never probes a public address taken from the Host header', async () => {
    const urls: string[] = [];
    const fetcher = jest.fn((url: string) => {
      urls.push(url);
      return Promise.reject(new Error('no'));
    });
    const service = new ServiceDiscoveryService(fetcher, routes);

    await service.discover('stashboard.example.com');

    expect(urls.map((url) => new URL(url).hostname)).not.toContain(
      'stashboard.example.com',
    );
    expect(urls).toContain('http://172.17.0.1:9999/');
  });

  it('follows a redirect on the same address but never one that leaves it', async () => {
    const urls: string[] = [];
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { location } });
    const fetcher = jest.fn((url: string) => {
      urls.push(url);
      if (url === 'http://172.17.0.1:9999/')
        return Promise.resolve(redirect('/login'));
      if (url === 'http://172.17.0.1:9999/login')
        return Promise.resolve(page('Stash'));
      if (url === 'http://172.17.0.1:6969/')
        return Promise.resolve(redirect('http://whisparr.example.com/'));
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const service = new ServiceDiscoveryService(fetcher, routes);

    const result = await service.discover(undefined);

    expect(result.found.map((entry) => entry.type)).toEqual(['STASH']);
    expect(urls.map((url) => new URL(url).hostname)).not.toContain(
      'whisparr.example.com',
    );
  });

  it('reads only the start of a large page', async () => {
    const huge = `<title>Stash</title>${'x'.repeat(5 * 1024 * 1024)}`;
    const fetcher = jest.fn((url: string) =>
      url === 'http://172.17.0.1:9999/'
        ? Promise.resolve(new Response(huge))
        : Promise.reject(new Error('ECONNREFUSED')),
    );
    const service = new ServiceDiscoveryService(fetcher, routes);

    const result = await service.discover(undefined);

    expect(result.found.map((entry) => entry.type)).toEqual(['STASH']);
  });

  it('knows which addresses are on your own network', () => {
    expect(isPrivateHost('192.168.1.5')).toBe(true);
    expect(isPrivateHost('10.0.0.2')).toBe(true);
    expect(isPrivateHost('172.20.1.1')).toBe(true);
    expect(isPrivateHost('100.101.102.103')).toBe(true);
    expect(isPrivateHost('unraid')).toBe(true);
    expect(isPrivateHost('nas.local')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('stashboard.example.com')).toBe(false);
  });
});
