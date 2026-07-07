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
