import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Pool, ProxyAgent } from 'undici';
import { publicStreamUrl } from './savedStreams.mjs';

// Only DNS is local: provider TCP/HTTP/TLS still uses the proxy. ProxyAgent
// retains the original request origin, Host and TLS server name.
export function resolvingProxy(uri, { lookup = systemLookup } = {}) {
  return new ProxyAgent({
    uri, proxyTunnel: true, connectTimeout: 8000,
    clientFactory(origin, options) {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool);
      pool.connect = async options => {
        const target = new URL(`http://${options.path}`);
        const host = target.hostname.replace(/^\[|\]$/g, '');
        let address = host;
        if (!isIP(host)) {
          let timer;
          try {
            const result = await Promise.race([
              lookup(host, { family: 4 }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Provider DNS timeout'), { code: 'STREAM_DNS_TIMEOUT' })), 3000); }),
            ]);
            address = result.address;
          } finally { clearTimeout(timer); }
        }
        const literal = isIP(address) === 6 ? `[${address}]` : address;
        if (!isIP(address) || !publicStreamUrl(`http://${literal}/`)) throw Object.assign(new Error('Provider DNS returned a non-public address'), { code: 'STREAM_DNS_UNSAFE' });
        return connect({ ...options, path: `${literal}:${target.port || 80}` });
      };
      return pool;
    },
  });
}
