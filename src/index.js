// ============================================================================
// Greenhouse Market — Backend-Worker
// Liefert die statische Website aus UND stellt die API für das Booking-System
// bereit (Gäste, Anfragen, Angebote, Buchungen, Rechnungen, Einstellungen).
//
// WICHTIG: Dies ist der Startpunkt der Datenbank-Anbindung. Die React-Tools
// (Greenhouse___Booking.html, Greenhouse___Buchung.html) müssen im nächsten
// Schritt noch umgebaut werden, damit sie diese API statt localStorage nutzen.
// ============================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// Prüft den Admin-Token für alle schreibenden/lesenden Admin-Routen.
// Die einzige öffentliche Route ist POST /api/inquiries (Gäste-Anfrage).
function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  return token && env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

function requireAuth(request, env) {
  if (!checkAuth(request, env)) {
    return errorResponse('Nicht autorisiert. Bitte gültigen Admin-Token im Header "Authorization: Bearer <token>" mitschicken.', 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen für generische CRUD-Operationen auf einer Tabelle
// ---------------------------------------------------------------------------

async function listRows(env, table, orderBy = 'created_at DESC') {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  return results;
}

async function getRow(env, table, id) {
  return await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
}

async function deleteRow(env, table, id) {
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
}

// Wandelt ein JS-Objekt (camelCase) in eine INSERT/UPDATE-freundliche Form um,
// basierend auf einer expliziten Feldliste (snake_case Spaltennamen -> camelCase Keys).
function pick(obj, fieldMap) {
  const out = {};
  for (const [column, key] of Object.entries(fieldMap)) {
    if (obj[key] !== undefined) out[column] = obj[key];
  }
  return out;
}

function boolToInt(v) {
  return v ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Gäste
// ---------------------------------------------------------------------------

const GUEST_FIELDS = {
  name: 'name', email: 'email', phone: 'phone',
  street: 'street', house_number: 'houseNumber', zip: 'zip', city: 'city',
  address: 'address', notes: 'notes',
};

async function handleGuests(request, env, method, id) {
  if (method === 'GET') return jsonResponse(await listRows(env, 'guests', 'name ASC'));

  if (method === 'POST') {
    const body = await request.json();
    const data = pick(body, GUEST_FIELDS);
    const result = await env.DB.prepare(
      `INSERT INTO guests (name, email, phone, street, house_number, zip, city, address, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(data.name, data.email, data.phone || '', data.street || '', data.house_number || '',
           data.zip || '', data.city || '', data.address || '', data.notes || '').first();
    return jsonResponse(result, 201);
  }

  if (method === 'PUT' && id) {
    const body = await request.json();
    const data = pick(body, GUEST_FIELDS);
    const result = await env.DB.prepare(
      `UPDATE guests SET name=?, email=?, phone=?, street=?, house_number=?, zip=?, city=?, address=?, notes=?
       WHERE id=? RETURNING *`
    ).bind(data.name, data.email, data.phone || '', data.street || '', data.house_number || '',
           data.zip || '', data.city || '', data.address || '', data.notes || '', id).first();
    if (!result) return errorResponse('Gast nicht gefunden', 404);
    return jsonResponse(result);
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'guests', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Anfragen (POST ist öffentlich — kommt vom Gäste-Tool ohne Login)
// ---------------------------------------------------------------------------

const INQUIRY_FIELDS = {
  name: 'name', email: 'email', phone: 'phone',
  street: 'street', house_number: 'houseNumber', zip: 'zip', city: 'city', address: 'address',
  wohnung: 'wohnung', check_in: 'checkIn', check_out: 'checkOut', persons: 'persons',
  payment_method: 'paymentMethod', total: 'total', nights: 'nights', status: 'status',
  policy_accepted_at: 'policyAcceptedAt',
};

async function handleInquiries(request, env, method, id) {
  if (method === 'GET') {
    const authFail = requireAuth(request, env);
    if (authFail) return authFail;
    return jsonResponse(await listRows(env, 'inquiries'));
  }

  if (method === 'POST') {
    // Öffentlich erreichbar — jeder Gast darf eine Anfrage einreichen.
    const body = await request.json();
    if (!body.name || !body.email || !body.checkIn || !body.checkOut || !body.wohnung) {
      return errorResponse('Pflichtfelder fehlen (name, email, checkIn, checkOut, wohnung)');
    }
    const newId = `INQ-${Date.now()}`;
    await env.DB.prepare(
      `INSERT INTO inquiries (
        id, name, email, phone, street, house_number, zip, city, address,
        wohnung, check_in, check_out, persons,
        early_checkin, late_checkout, final_cleaning, dog_fee, dog_count,
        projekt_space, projekt_space_cleaning, payment_method,
        total, nights, status, policy_accepted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId, body.name, body.email, body.phone || '',
      body.street || '', body.houseNumber || '', body.zip || '', body.city || '', body.address || '',
      body.wohnung, body.checkIn, body.checkOut, body.persons || 1,
      boolToInt(body.earlyCheckin), boolToInt(body.lateCheckout), boolToInt(body.finalCleaning),
      boolToInt(body.dogFee), body.dogCount || 1,
      boolToInt(body.projektSpace), boolToInt(body.projektSpaceCleaning), body.paymentMethod || 'bank_transfer',
      body.total || 0, body.nights || 0, 'new', body.policyAcceptedAt || null
    ).run();
    const created = await getRow(env, 'inquiries', newId);
    return jsonResponse(created, 201);
  }
const authFail = requireAuth(request, env);
  if (authFail) return authFail;

  if (method === 'PUT' && id) {
    const body = await request.json();
    const data = pick(body, INQUIRY_FIELDS);
    const existing = await getRow(env, 'inquiries', id);
    if (!existing) return errorResponse('Anfrage nicht gefunden', 404);
    const merged = { ...existing, ...data };
    await env.DB.prepare(
      `UPDATE inquiries SET name=?, email=?, phone=?, street=?, house_number=?, zip=?, city=?, address=?,
       status=? WHERE id=?`
    ).bind(merged.name, merged.email, merged.phone, merged.street, merged.house_number,
           merged.zip, merged.city, merged.address, merged.status, id).run();
    return jsonResponse(await getRow(env, 'inquiries', id));
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'inquiries', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Buchungen — DIESE Tabelle speist den Airbnb-Export!
// ---------------------------------------------------------------------------

async function handleBookings(request, env, method, id) {
  const authFail = requireAuth(request, env);
  if (authFail) return authFail;

  if (method === 'GET') return jsonResponse(await listRows(env, 'bookings'));

  if (method === 'POST') {
    const b = await request.json();
    const newId = b.id || `BUK-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    await env.DB.prepare(
      `INSERT INTO bookings (
        id, offer_id, guest_name, guest_email, guest_phone, guest_address, wohnung,
        check_in, check_out, persons, early_checkin, late_checkout, final_cleaning,
        dog_fee, dog_count, projekt_space, projekt_space_cleaning,
        total, deposit, down_payment, remaining, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId, b.offerId || null, b.guestName, b.guestEmail, b.guestPhone || '', b.guestAddress || '',
      b.wohnung, b.checkIn, b.checkOut, b.persons || 1,
      boolToInt(b.earlyCheckin), boolToInt(b.lateCheckout), boolToInt(b.finalCleaning),
      boolToInt(b.dogFee), b.dogCount || 1, boolToInt(b.projektSpace), boolToInt(b.projektSpaceCleaning),
      b.total || 0, b.deposit || 0, b.downPayment || 0, b.remaining || 0, b.status || 'awaiting_deposit'
    ).run();
    return jsonResponse(await getRow(env, 'bookings', newId), 201);
  }

  if (method === 'PUT' && id) {if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT key, value_json FROM settings').all();
    const out = {};
    for (const row of results) out[row.key] = JSON.parse(row.value_json);
    return jsonResponse(out);
  }

  if (method === 'PUT' && key) {
    const body = await request.json();
    await env.DB.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`
    ).bind(key, JSON.stringify(body)).run();
    return jsonResponse({ saved: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Löschkonzept (Art. 5 Abs. 1 lit. e DSGVO — Speicherbegrenzung)
//
// - Anfragen ohne Buchung (status 'new'/'rejected'): gelöscht nach X Monaten
// - Angebote ohne Buchung (status 'sent'): gelöscht nach X Monaten
// - Buchungen: NICHT gelöscht (Referenz für Rechnungen/Statistik), aber die
//   Gästedaten werden nach X Jahren nach Abreise ANONYMISIERT
// - Rechnungen: werden NIE automatisch gelöscht (10 Jahre Aufbewahrungspflicht
//   nach § 147 AO) — das übernimmt bewusst kein Automatismus.
// ---------------------------------------------------------------------------

async function getRetentionPolicy(env) {
  const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'retention_policy'`).first();
  const defaults = { inquiryMonths: 12, offerMonths: 12, bookingAnonymizeYears: 3 };
  if (!row) return defaults;
  try {
    return { ...defaults, ...JSON.parse(row.value_json) };
  } catch (e) {
    return defaults;
  }
}

async function logRetentionAction(env, action, table, recordId, reason) {
  await env.DB.prepare(
    `INSERT INTO retention_log (action, table_name, record_id, reason) VALUES (?, ?, ?, ?)`
  ).bind(action, table, recordId, reason).run();
}

// dryRun = true: nur ermitteln, was betroffen wäre, ohne etwas zu verändern.
async function runRetentionCleanup(env, dryRun) {
  const policy = await getRetentionPolicy(env);
  const report = { staleInquiries: [], staleOffers: [], bookingsToAnonymize: [] };

  const staleInquiries = await env.DB.prepare(
    `SELECT id, name, status, created_at FROM inquiries
     WHERE status IN ('new', 'rejected')
     AND created_at < datetime('now', '-' || ? || ' months')`
  ).bind(policy.inquiryMonths).all();
  report.staleInquiries = staleInquiries.results;

  const staleOffers = await env.DB.prepare(
    `SELECT id, guest_name, status, created_at FROM offers
     WHERE status = 'sent'
     AND created_at < datetime('now', '-' || ? || ' months')`
  ).bind(policy.offerMonths).all();
  report.staleOffers = staleOffers.results;

  const oldBookings = await env.DB.prepare(
    `SELECT id, guest_name, check_out FROM bookings
     WHERE check_out < datetime('now', '-' || ? || ' years')
     AND guest_name != '[Gelöscht]'`
  ).bind(policy.bookingAnonymizeYears).all();
  report.bookingsToAnonymize = oldBookings.results;

  if (!dryRun) {
    for (const inq of report.staleInquiries) {
      await env.DB.prepare(`DELETE FROM inquiries WHERE id = ?`).bind(inq.id).run();
      await logRetentionAction(env, 'deleted', 'inquiries', inq.id, `Anfrage älter als ${policy.inquiryMonths} Monate, Status: ${inq.status}`);
    }
    for (const off of report.staleOffers) {
      await env.DB.prepare(`DELETE FROM offers WHERE id = ?`).bind(off.id).run();
      await logRetentionAction(env, 'deleted', 'offers', off.id, `Angebot älter als ${policy.offerMonths} Monate, nie gebucht`);
    }
    for (const b of report.bookingsToAnonymize) {
      await env.DB.prepare(
        `UPDATE bookings SET guest_name='[Gelöscht]', guest_email='[Gelöscht]', guest_phone='', guest_address='' WHERE id = ?`
      ).bind(b.id).run();
      await logRetentionAction(env, 'anonymized', 'bookings', b.id, `Buchung länger als ${policy.bookingAnonymizeYears} Jahre nach Abreise — Gästedaten anonymisiert (Rechnung bleibt unberührt)`);
    }
  }

  return report;
}

async function handleRetentionPreview(request, env) {
  const authFail = requireAuth(request, env);
  if (authFail) return authFail;
  const report = await runRetentionCleanup(env, true);
  return jsonResponse(report);
}

async function handleRetentionRun(request, env) {
  const authFail = requireAuth(request, env);
  if (authFail) return authFail;
  const report = await runRetentionCleanup(env, false);
  return jsonResponse({ executed: true, ...report });
}

async function handleRetentionLog(request, env) {
  const authFail = requireAuth(request, env);
  if (authFail) return authFail;
  return jsonResponse(await listRows(env, 'retention_log', 'executed_at DESC'));
}

// ---------------------------------------------------------------------------
// Airbnb-Export: NUR bestätigte Buchungen (status IN awaiting_downpayment,
// confirmed, completed — d.h. mindestens die Kaution ist bestätigt und die
// Buchung ist damit verbindlich; "awaiting_deposit" zählt bewusst NICHT als
// bestätigt und blockiert Airbnb nicht).
// ---------------------------------------------------------------------------

function toIcsDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

async function handleExportIcs(request, env, wohnungParam) {
  const validWohnungen = ['wohnung1', 'wohnung2', 'both'];
  if (!validWohnungen.includes(wohnungParam)) {
    return new Response('Ungültiger Parameter "wohnung" (erwartet: wohnung1, wohnung2 oder both)', { status: 400 });
  }

  // "both"-Buchungen blockieren zusätzlich auch die Einzelwohnungen, da bei
  // Buchung beider Wohnungen natürlich auch jede einzelne belegt ist.
  const wohnungFilter = wohnungParam === 'both'
    ? `wohnung IN ('wohnung1', 'wohnung2', 'both')`
    : `wohnung IN (?, 'both')`;

  const query = `
    SELECT id, check_in, check_out, guest_name
    FROM bookings
    WHERE status IN ('awaiting_downpayment', 'confirmed', 'completed')
    AND ${wohnungFilter}
  `;

  const stmt = wohnungParam === 'both'
    ? env.DB.prepare(query)
    : env.DB.prepare(query).bind(wohnungParam);

  const { results } = await stmt.all();

  let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Greenhouse Market//Booking Export//DE\r\nCALSCALE:GREGORIAN\r\n';
  for (const b of results) {
    ics += 'BEGIN:VEVENT\r\n';
    ics += `UID:${b.id}@greenhouse-fuerstenberg.de\r\n`;
    ics += `DTSTART;VALUE=DATE:${toIcsDate(b.check_in)}\r\n`;
    ics += `DTEND;VALUE=DATE:${toIcsDate(b.check_out)}\r\n`;
    ics += `SUMMARY:Belegt (Greenhouse Booking)\r\n`;
    ics += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
    ics += 'END:VEVENT\r\n';
  }}
  ics += 'END:VCALENDAR\r\n';

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800', // 30 Min. Cache, Airbnb ruft ohnehin nur alle paar Stunden ab
    },
  });
}

// ---------------------------------------------------------------------------
// Bestehender iCal-Proxy (Airbnb -> Website), unverändert aus dem bisherigen
// Worker übernommen.
// ---------------------------------------------------------------------------

async function handleIcalProxy(url) {
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing "url" query parameter', { status: 400 });

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
        'Accept': 'text/calendar, text/plain, */*',
      },
    });
    if (!upstreamResponse.ok) {
      return new Response(`Upstream error: ${upstreamResponse.status} ${upstreamResponse.statusText}`, { status: 502 });
    }
    const text = await upstreamResponse.text();
    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new Response('Fetch failed: ' + err.message, { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// Haupt-Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    try {
      if (path === '/ical') return handleIcalProxy(url);

      if (path === '/export.ics') {
        const wohnung = url.searchParams.get('wohnung') || 'wohnung1';
        return handleExportIcs(request, env, wohnung);
      }

      if (path === '/api/retention/preview' && method === 'GET') return await handleRetentionPreview(request, env);
      if (path === '/api/retention/run' && method === 'POST') return await handleRetentionRun(request, env);
      if (path === '/api/retention/log' && method === 'GET') return await handleRetentionLog(request, env);

      const apiMatch = path.match(/^\/api\/(guests|inquiries|offers|bookings|invoices|settings)(?:\/([^/]+))?$/);
      if (apiMatch) {
        const [, resource, id] = apiMatch;
        switch (resource) {
          case 'guests': return await handleGuests(request, env, method, id);
          case 'inquiries': return await handleInquiries(request, env, method, id);
          case 'offers': return await handleOffers(request, env, method, id);
          case 'bookings': return await handleBookings(request, env, method, id);
          case 'invoices': return await handleInvoices(request, env, method, id);
          case 'settings': return await handleSettings(request, env, method, id);
        }
      }

      // Alles andere: statische Website ausliefern (index.html, Bilder, ...)
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Worker error:', err);
      return errorResponse('Serverfehler: ' + err.message, 500);
    }
  },

  // Wird automatisch per Cron Trigger ausgeführt (siehe wrangler.jsonc,
  // standardmäßig wöchentlich). Löscht/anonymisiert Daten gemäß Löschkonzept.
  // Rechnungen sind davon ausdrücklich NIE betroffen (10 Jahre Pflicht-
  // aufbewahrung nach § 147 AO).
  async scheduled(controller, env, ctx) {
    const report = await runRetentionCleanup(env, false);
    console.log(
      `Löschkonzept ausgeführt: ${report.staleInquiries.length} Anfragen gelöscht, ` +
      `${report.staleOffers.length} Angebote gelöscht, ` +
      `${report.bookingsToAnonymize.length} Buchungen anonymisiert.`
    );
  },
};
