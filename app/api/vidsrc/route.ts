import { NextResponse } from 'next/server';

async function fetchWithHeaders(url: string, referer?: string, timeout = 15000) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (referer) headers.Referer = referer;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function findFirstMatch(html: string, patterns: RegExp[]) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m;
  }
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tmdbId = url.searchParams.get('tmdbId');
  const type = (url.searchParams.get('type') || 'movie') as 'movie' | 'tv';
  const season = url.searchParams.get('season');
  const episode = url.searchParams.get('episode');

  if (!tmdbId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Missing tmdbId' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  const embedHosts = [
    'https://vidsrc-embed.ru',
    'https://vidsrc.pro',
    'https://vidsrc.cc',
    'https://vidsrc.xyz',
    'https://vidsrc.to',
    'https://vidsrc.in',
  ];

  try {
    // Try multiple embed hosts to avoid Turnstile-protected mirrors
    let embedHtml: string | null = null;
    let usedEmbedUrl: string | null = null;
    for (const host of embedHosts) {
      const embedUrl =
        type === 'tv' && season && episode
          ? `${host}/embed/tv/${tmdbId}/${season}/${episode}`
          : `${host}/embed/movie/${tmdbId}`;

      try {
        const res = await fetchWithHeaders(embedUrl, host, 10000);
        if (!res.ok) continue;
        const txt = await res.text();
        // quick check for cloudnestra iframe or direct .m3u8
        if (txt.includes('cloudnestra.com') || txt.match(/\.m3u8/)) {
          embedHtml = txt;
          usedEmbedUrl = embedUrl;
          break;
        }
      } catch (e) {
        // ignore and try next host
      }
    }

    if (!embedHtml) {
      return new Response(
        JSON.stringify({ success: false, error: 'No usable embed page found' }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // If embed page already contains .m3u8 links, return first one
    const directM3u8 = embedHtml.match(/https?:[^"'\s]+\.m3u8[^"'\s]*/i);
    if (directM3u8) {
      return new Response(
        JSON.stringify({ success: true, url: directM3u8[0], source: usedEmbedUrl }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Find cloudnestra rcp iframe
    const iframeMatch = embedHtml.match(/<iframe[^>]*src=["']([^"']*cloudnestra\.com\/rcp\/([^"']+))["']/i);
    if (!iframeMatch) {
      return new Response(
        JSON.stringify({ success: false, error: 'Could not find cloudnestra RCP iframe' }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    const rcpPath = iframeMatch[2];
    const rcpUrl = `https://cloudnestra.com/rcp/${rcpPath}`;
    const rcpRes = await fetchWithHeaders(rcpUrl, usedEmbedUrl || undefined, 10000);
    if (!rcpRes.ok) {
      return new Response(
        JSON.stringify({ success: false, error: `RCP fetch returned ${rcpRes.status}` }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
    const rcpHtml = await rcpRes.text();

    // If Turnstile is present, we won't attempt to bypass here
    if (rcpHtml.includes('cf-turnstile') || rcpHtml.includes('turnstile')) {
      return new Response(
        JSON.stringify({ success: false, error: 'RCP page protected by Cloudflare Turnstile (no bypass configured)' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Find prorcp or srcrcp endpoint path
    const patternMatch = findFirstMatch(rcpHtml, [
      /src:\s*["']\/prorcp\/([^"']+)["']/i,
      /src:\s*["']\/srcrcp\/([^"']+)["']/i,
      /["']\/prorcp\/([A-Za-z0-9+\/=\-_]+)["']/i,
      /["']\/srcrcp\/([A-Za-z0-9+\/=\-_]+)["']/i,
    ]);

    if (!patternMatch) {
      return new Response(
        JSON.stringify({ success: false, error: 'Could not find prorcp/srcrcp path' }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Determine type from matched regex (prorcp vs srcrcp)
    const matched = patternMatch[0];
    const isProrcp = /prorcp/i.test(matched);
    const endpointType = isProrcp ? 'prorcp' : 'srcrcp';
    const endpointPath = patternMatch[1];

    const endpointUrl = `https://cloudnestra.com/${endpointType}/${endpointPath}`;
    const endpointRes = await fetchWithHeaders(endpointUrl, 'https://cloudnestra.com/', 10000);
    if (!endpointRes.ok) {
      return new Response(
        JSON.stringify({ success: false, error: `Endpoint fetch returned ${endpointRes.status}` }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
    const endpointHtml = await endpointRes.text();

    // Extract PlayerJS file: value
    const fileMatch = endpointHtml.match(/file:\s*["']([^"']+)["']/i);
    if (!fileMatch) {
      // As a fallback, look for any .m3u8 in the endpoint
      const anyM3u8 = endpointHtml.match(/https?:[^"'\s]+\.m3u8[^"'\s]*/i);
      if (anyM3u8) {
        return new Response(
          JSON.stringify({ success: true, url: anyM3u8[0] }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }
      return new Response(
        JSON.stringify({ success: false, error: 'Could not find file URL in endpoint' }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    const fileUrlRaw = fileMatch[1];
    // file may contain alternatives separated by ' or '
    const alternatives = fileUrlRaw.split(/\s+or\s+/i).map(s => s.trim());

    // Replace placeholder domains {v1} etc. with candidate CDNs
    const cdnCandidates = ['shadowlandschronicles.com', 'cloudnestra.com'];
    const resolved: string[] = [];
    for (const a of alternatives) {
      if (a.includes('{v')) {
        for (const d of cdnCandidates) {
          const r = a.replace(/\{v\d+\}/g, d);
          if (r.includes('.m3u8')) resolved.push(r);
        }
      } else if (a.includes('.m3u8')) {
        resolved.push(a);
      }
    }

    if (resolved.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No resolved .m3u8 URLs found' }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Return first resolved URL (client can try others)
    return new Response(
      JSON.stringify({ success: true, url: resolved[0], all: resolved }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

export const dynamic = 'force-dynamic';
