export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Eigene Route für den iCal-Proxy
    if (url.pathname === '/ical') {
      return handleIcalProxy(url);
    }

    // Alles andere: normale statische Seite ausliefern (index.html, Bilder, ...)
    return env.ASSETS.fetch(request);
  }
};

async function handleIcalProxy(url) {
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing "url" query parameter', { status: 400 });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch (e) {
    return new Response('Invalid "url" parameter', { status: 400 });
  }

  const allowedHosts = ['www.airbnb.de', 'www.airbnb.com', 'airbnb.de', 'airbnb.com'];
  if (!allowedHosts.includes(parsedTarget.hostname)) {
    return new Response('Host not allowed', { status: 403 });
  }

  try {
    const upstreamResponse = await fetch(parsedTarget.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GreenhouseCalendarSync/1.0)',
        'Accept': 'text/calendar, text/plain, */*'
      }
    });

    if (!upstreamResponse.ok) {
      return new Response(
        `Upstream error: ${upstreamResponse.status} ${upstreamResponse.statusText}`,
        { status: 502 }
      );
    }

    const text = await upstreamResponse.text();

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    return new Response('Fetch failed: ' + err.message, { status: 502 });
  }
}
