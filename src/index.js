import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

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

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return false;

  const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'admin_password_hash'`).first();
  if (row) {
    const storedHash = JSON.parse(row.value_json);
    const incomingHash = await hashPassword(token);
    return incomingHash === storedHash;
  }

  return !!(env.ADMIN_TOKEN && token === env.ADMIN_TOKEN);
}

async function requireAuth(request, env) {
  if (!(await checkAuth(request, env))) {
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

async function ensureGuestExists(env, { name, email, phone, street, houseNumber, zip, city, address }) {
  if (!email) return;
  const existing = await env.DB.prepare(`SELECT id FROM guests WHERE lower(email) = lower(?)`).bind(email).first();
  if (existing) return;
  await env.DB.prepare(
    `INSERT INTO guests (name, email, phone, street, house_number, zip, city, address, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(name || '', email, phone || '', street || '', houseNumber || '', zip || '', city || '', address || '', 'Automatisch angelegt').run();
}

async function handleInquiries(request, env, method, id) {
  if (method === 'GET') {
    const authFail = await requireAuth(request, env);
    if (authFail) return authFail;
    return jsonResponse(await listRows(env, 'inquiries'));
  }

  if (method === 'POST') {
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
    await ensureGuestExists(env, {
      name: body.name, email: body.email, phone: body.phone,
      street: body.street, houseNumber: body.houseNumber, zip: body.zip, city: body.city, address: body.address,
    });
    return jsonResponse(created, 201);
  }

  const authFail = await requireAuth(request, env);
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
  const authFail = await requireAuth(request, env);
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
    await ensureGuestExists(env, { name: b.guestName, email: b.guestEmail, phone: b.guestPhone, address: b.guestAddress });
    return jsonResponse(await getRow(env, 'bookings', newId), 201);
  }

  if (method === 'PUT' && id) {
    const b = await request.json();
    const existing = await getRow(env, 'bookings', id);
    if (!existing) return errorResponse('Buchung nicht gefunden', 404);
    await env.DB.prepare(
      `UPDATE bookings SET deposit_paid=?, down_payment_paid=?, remaining_paid=?, status=?
       WHERE id=?`
    ).bind(
      b.depositPaid !== undefined ? boolToInt(b.depositPaid) : existing.deposit_paid,
      b.downPaymentPaid !== undefined ? boolToInt(b.downPaymentPaid) : existing.down_payment_paid,
      b.remainingPaid !== undefined ? boolToInt(b.remainingPaid) : existing.remaining_paid,
      b.status || existing.status,
      id
    ).run();
    return jsonResponse(await getRow(env, 'bookings', id));
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'bookings', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Angebote
// ---------------------------------------------------------------------------

async function handleOffers(request, env, method, id) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (method === 'GET') return jsonResponse(await listRows(env, 'offers'));

  if (method === 'POST') {
    const o = await request.json();
    const newId = o.id || `ANG-${Date.now()}`;
    await env.DB.prepare(
      `INSERT INTO offers (
        id, guest_id, source_inquiry_id, guest_name, guest_email, guest_phone, guest_address,
        wohnung, check_in, check_out, persons, early_checkin, late_checkout, final_cleaning,
        dog_fee, dog_count, projekt_space, projekt_space_cleaning, discount_percent,
        total, nights, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId, o.guestId || null, o.sourceInquiryId || null, o.guestName, o.guestEmail,
      o.guestPhone || '', o.guestAddress || '', o.wohnung, o.checkIn, o.checkOut, o.persons || 1,
      boolToInt(o.earlyCheckin), boolToInt(o.lateCheckout), boolToInt(o.finalCleaning),
      boolToInt(o.dogFee), o.dogCount || 1, boolToInt(o.projektSpace), boolToInt(o.projektSpaceCleaning),
      o.discountPercent || 0, o.total || 0, o.nights || 0, o.status || 'sent'
    ).run();
    return jsonResponse(await getRow(env, 'offers', newId), 201);
  }

  if (method === 'PUT' && id) {
    const o = await request.json();
    const existing = await getRow(env, 'offers', id);
    if (!existing) return errorResponse('Angebot nicht gefunden', 404);

    const merged = {
      guest_id: o.guestId !== undefined ? o.guestId : existing.guest_id,
      guest_name: o.guestName !== undefined ? o.guestName : existing.guest_name,
      guest_email: o.guestEmail !== undefined ? o.guestEmail : existing.guest_email,
      guest_phone: o.guestPhone !== undefined ? o.guestPhone : existing.guest_phone,
      guest_address: o.guestAddress !== undefined ? o.guestAddress : existing.guest_address,
      wohnung: o.wohnung !== undefined ? o.wohnung : existing.wohnung,
      check_in: o.checkIn !== undefined ? o.checkIn : existing.check_in,
      check_out: o.checkOut !== undefined ? o.checkOut : existing.check_out,
      persons: o.persons !== undefined ? o.persons : existing.persons,
      early_checkin: o.earlyCheckin !== undefined ? boolToInt(o.earlyCheckin) : existing.early_checkin,
      late_checkout: o.lateCheckout !== undefined ? boolToInt(o.lateCheckout) : existing.late_checkout,
      final_cleaning: o.finalCleaning !== undefined ? boolToInt(o.finalCleaning) : existing.final_cleaning,
      dog_fee: o.dogFee !== undefined ? boolToInt(o.dogFee) : existing.dog_fee,
      dog_count: o.dogCount !== undefined ? o.dogCount : existing.dog_count,
      projekt_space: o.projektSpace !== undefined ? boolToInt(o.projektSpace) : existing.projekt_space,
      projekt_space_cleaning: o.projektSpaceCleaning !== undefined ? boolToInt(o.projektSpaceCleaning) : existing.projekt_space_cleaning,
      discount_percent: o.discountPercent !== undefined ? o.discountPercent : existing.discount_percent,
      total: o.total !== undefined ? o.total : existing.total,
      nights: o.nights !== undefined ? o.nights : existing.nights,
      status: o.status !== undefined ? o.status : existing.status,
    };

    await env.DB.prepare(
      `UPDATE offers SET guest_id=?, guest_name=?, guest_email=?, guest_phone=?, guest_address=?,
       wohnung=?, check_in=?, check_out=?, persons=?, early_checkin=?, late_checkout=?, final_cleaning=?,
       dog_fee=?, dog_count=?, projekt_space=?, projekt_space_cleaning=?, discount_percent=?,
       total=?, nights=?, status=? WHERE id=?`
    ).bind(
      merged.guest_id, merged.guest_name, merged.guest_email, merged.guest_phone, merged.guest_address,
      merged.wohnung, merged.check_in, merged.check_out, merged.persons, merged.early_checkin, merged.late_checkout,
      merged.final_cleaning, merged.dog_fee, merged.dog_count, merged.projekt_space, merged.projekt_space_cleaning,
      merged.discount_percent, merged.total, merged.nights, merged.status, id
    ).run();
    return jsonResponse(await getRow(env, 'offers', id));
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'offers', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Rechnungen
// ---------------------------------------------------------------------------

async function handleInvoices(request, env, method, id) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (method === 'GET') {
    const rows = await listRows(env, 'invoices');
    return jsonResponse(rows.map(r => ({ ...r, items: JSON.parse(r.items_json) })));
  }

  if (method === 'POST') {
    const inv = await request.json();
    const newId = inv.id || `RE-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    await env.DB.prepare(
      `INSERT INTO invoices (
        id, source_ref, wohnung, guest_name, guest_email, guest_address, invoice_date,
        service_start, service_end, items_json, vat_mode, discount_percent,
        raw_net, discount_amount, net, vat_rate, vat_amount, gross, notes, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId, inv.sourceRef || '', inv.wohnung || 'wohnung1', inv.guestName, inv.guestEmail,
      inv.guestAddress, inv.invoiceDate, inv.serviceStart || '', inv.serviceEnd || '',
      JSON.stringify(inv.items || []), inv.vatMode || 'kleinunternehmer', inv.discountPercent || 0,
      inv.rawNet || 0, inv.discountAmount || 0, inv.net || 0, inv.vatRate || 0,
      inv.vatAmount || 0, inv.gross || 0, inv.notes || '', 'open'
    ).run();
    const created = await getRow(env, 'invoices', newId);
    return jsonResponse({ ...created, items: JSON.parse(created.items_json) }, 201);
  }

  if (method === 'PUT' && id) {
    const inv = await request.json();
    const existing = await getRow(env, 'invoices', id);
    if (!existing) return errorResponse('Rechnung nicht gefunden', 404);

    const merged = {
      source_ref: inv.sourceRef !== undefined ? inv.sourceRef : existing.source_ref,
      wohnung: inv.wohnung !== undefined ? inv.wohnung : existing.wohnung,
      guest_name: inv.guestName !== undefined ? inv.guestName : existing.guest_name,
      guest_email: inv.guestEmail !== undefined ? inv.guestEmail : existing.guest_email,
      guest_address: inv.guestAddress !== undefined ? inv.guestAddress : existing.guest_address,
      invoice_date: inv.invoiceDate !== undefined ? inv.invoiceDate : existing.invoice_date,
      service_start: inv.serviceStart !== undefined ? inv.serviceStart : existing.service_start,
      service_end: inv.serviceEnd !== undefined ? inv.serviceEnd : existing.service_end,
      items_json: inv.items !== undefined ? JSON.stringify(inv.items) : existing.items_json,
      vat_mode: inv.vatMode !== undefined ? inv.vatMode : existing.vat_mode,
      discount_percent: inv.discountPercent !== undefined ? inv.discountPercent : existing.discount_percent,
      raw_net: inv.rawNet !== undefined ? inv.rawNet : existing.raw_net,
      discount_amount: inv.discountAmount !== undefined ? inv.discountAmount : existing.discount_amount,
      net: inv.net !== undefined ? inv.net : existing.net,
      vat_rate: inv.vatRate !== undefined ? inv.vatRate : existing.vat_rate,
      vat_amount: inv.vatAmount !== undefined ? inv.vatAmount : existing.vat_amount,
      gross: inv.gross !== undefined ? inv.gross : existing.gross,
      notes: inv.notes !== undefined ? inv.notes : existing.notes,
      status: inv.status !== undefined ? inv.status : existing.status,
    };

    await env.DB.prepare(
      `UPDATE invoices SET source_ref=?, wohnung=?, guest_name=?, guest_email=?, guest_address=?,
       invoice_date=?, service_start=?, service_end=?, items_json=?, vat_mode=?, discount_percent=?,
       raw_net=?, discount_amount=?, net=?, vat_rate=?, vat_amount=?, gross=?, notes=?, status=?
       WHERE id=?`
    ).bind(
      merged.source_ref, merged.wohnung, merged.guest_name, merged.guest_email, merged.guest_address,
      merged.invoice_date, merged.service_start, merged.service_end, merged.items_json, merged.vat_mode,
      merged.discount_percent, merged.raw_net, merged.discount_amount, merged.net, merged.vat_rate,
      merged.vat_amount, merged.gross, merged.notes, merged.status, id
    ).run();
    const updated = await getRow(env, 'invoices', id);
    return jsonResponse({ ...updated, items: JSON.parse(updated.items_json) });
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'invoices', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}// ---------------------------------------------------------------------------
// Einstellungen (Preise, Firmendaten, Stornobedingungen, Anzahlungs-%)
// ---------------------------------------------------------------------------

async function handlePublicSettings(request, env) {
  const pricesRow = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'prices'`).first();
  const policyRow = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'cancellation_policy'`).first();
  const downPaymentRow = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'down_payment_percent'`).first();

  return jsonResponse({
    prices: pricesRow ? JSON.parse(pricesRow.value_json) : null,
    cancellationPolicy: policyRow ? JSON.parse(policyRow.value_json) : null,
    downPaymentPercent: downPaymentRow ? JSON.parse(downPaymentRow.value_json) : null,
  });
}

async function handlePublicBlockedEdges(request, env, wohnungParam) {
  const validWohnungen = ['wohnung1', 'wohnung2', 'both'];
  if (!validWohnungen.includes(wohnungParam)) {
    return errorResponse('Ungültiger Parameter "wohnung"', 400);
  }
  const wohnungFilter = wohnungParam === 'both'
    ? `wohnung IN ('wohnung1', 'wohnung2', 'both')`
    : `wohnung IN (?, 'both')`;
  const query = `SELECT check_in, check_out FROM blocked_periods WHERE ${wohnungFilter}`;
  const stmt = wohnungParam === 'both' ? env.DB.prepare(query) : env.DB.prepare(query).bind(wohnungParam);
  const { results } = await stmt.all();
  return jsonResponse(results.map(r => ({ checkIn: r.check_in, checkOut: r.check_out })));
}

async function handleSettings(request, env, method, key) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (method === 'GET') {
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
// Manuell blockierte Zeiträume — unabhängig von echten Buchungen (z.B.
// Eigennutzung, Wartung). Blockieren den Kalender genauso wie echte Buchungen.
// ---------------------------------------------------------------------------

async function handleBlockedPeriods(request, env, method, id) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  if (method === 'GET') return jsonResponse(await listRows(env, 'blocked_periods'));

  if (method === 'POST') {
    const body = await request.json();
    if (!body.wohnung || !body.checkIn || !body.checkOut) {
      return errorResponse('Pflichtfelder fehlen (wohnung, checkIn, checkOut)');
    }
    const newId = `BLK-${Date.now()}`;
    await env.DB.prepare(
      `INSERT INTO blocked_periods (id, wohnung, check_in, check_out, reason) VALUES (?, ?, ?, ?, ?)`
    ).bind(newId, body.wohnung, body.checkIn, body.checkOut, body.reason || '').run();
    return jsonResponse(await getRow(env, 'blocked_periods', newId), 201);
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'blocked_periods', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Passwort ändern — erfordert gültige aktuelle Authentifizierung.
// Speichert nur einen SHA-256-Hash, nie das Passwort im Klartext.
// ---------------------------------------------------------------------------

async function handleChangePassword(request, env) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  const body = await request.json();
  const newPassword = (body.newPassword || '').trim();
  if (newPassword.length < 8) {
    return errorResponse('Das neue Passwort muss mindestens 8 Zeichen lang sein.', 400);
  }

  const hash = await hashPassword(newPassword);
  await env.DB.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES ('admin_password_hash', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`
  ).bind(JSON.stringify(hash)).run();

  return jsonResponse({ changed: true });
}

// ---------------------------------------------------------------------------
// Datensicherung — kompletter Export aller Tabellen als JSON.
// ---------------------------------------------------------------------------

async function buildFullBackup(env) {
  const [guests, inquiries, offers, bookings, invoicesRaw, settingsRows] = await Promise.all([
    listRows(env, 'guests', 'name ASC'),
    listRows(env, 'inquiries'),
    listRows(env, 'offers'),
    listRows(env, 'bookings'),
    listRows(env, 'invoices'),
    env.DB.prepare('SELECT key, value_json FROM settings').all().then(r => r.results),
  ]);

  const invoices = invoicesRaw.map(r => ({ ...r, items: JSON.parse(r.items_json) }));
  const settings = {};
  for (const row of settingsRows) settings[row.key] = JSON.parse(row.value_json);

  return {
    exportedAt: new Date().toISOString(),
    guests,
    inquiries,
    offers,
    bookings,
    invoices,
    settings,
  };
}

async function handleBackupNow(request, env) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;
  const backup = await buildFullBackup(env);
  return new Response(JSON.stringify(backup, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `attachment; filename="greenhouse-backup-${new Date().toISOString().split('T')[0]}.json"`,
    },
  });
}

async function handleListBackups(request, env) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;
  const { results } = await env.DB.prepare('SELECT id, created_at FROM backups ORDER BY created_at DESC').all();
  return jsonResponse(results);
}

async function handleGetBackup(request, env, id) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;
  const row = await env.DB.prepare('SELECT created_at, data_json FROM backups WHERE id = ?').bind(Number(id)).first();
  if (!row) return errorResponse('Backup nicht gefunden', 404);
  return new Response(row.data_json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `attachment; filename="greenhouse-backup-${row.created_at.split(' ')[0]}.json"`,
    },
  });
}

async function createAutomaticBackup(env) {
  const backup = await buildFullBackup(env);
  await env.DB.prepare('INSERT INTO backups (data_json) VALUES (?)').bind(JSON.stringify(backup)).run();
  await env.DB.prepare(
    `DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY created_at DESC LIMIT 12)`
  ).run();
}

// ---------------------------------------------------------------------------
// Löschkonzept (Art. 5 Abs. 1 lit. e DSGVO — Speicherbegrenzung)
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
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;
  const report = await runRetentionCleanup(env, true);
  return jsonResponse(report);
}

async function handleRetentionRun(request, env) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;
  const report = await runRetentionCleanup(env, false);
  return jsonResponse({ executed: true, ...report });
}

async function handleRetentionLog(request, env) {
  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;
  return jsonResponse(await listRows(env, 'retention_log', 'executed_at DESC'));
}

// ---------------------------------------------------------------------------
// Airbnb-Export
// ---------------------------------------------------------------------------

function toIcsDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

async function handleExportIcs(request, env, wohnungParam, includeBlocks) {
  const validWohnungen = ['wohnung1', 'wohnung2', 'both'];
  if (!validWohnungen.includes(wohnungParam)) {
    return new Response('Ungültiger Parameter "wohnung" (erwartet: wohnung1, wohnung2 oder both)', { status: 400 });
  }

  const wohnungFilter = wohnungParam === 'both'
    ? `wohnung IN ('wohnung1', 'wohnung2', 'both')`
    : `wohnung IN (?, 'both')`;

  const bookingsQuery = `
    SELECT id, check_in, check_out, guest_name
    FROM bookings
    WHERE status IN ('awaiting_downpayment', 'confirmed', 'completed')
    AND ${wohnungFilter}
  `;
  const bookingsStmt = wohnungParam === 'both' ? env.DB.prepare(bookingsQuery) : env.DB.prepare(bookingsQuery).bind(wohnungParam);
  const { results: bookingResults } = await bookingsStmt.all();

  let blockedResults = [];
  if (includeBlocks) {
    const blockedQuery = `SELECT id, check_in, check_out FROM blocked_periods WHERE ${wohnungFilter}`;
    const blockedStmt = wohnungParam === 'both' ? env.DB.prepare(blockedQuery) : env.DB.prepare(blockedQuery).bind(wohnungParam);
    blockedResults = (await blockedStmt.all()).results;
  }

  let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Greenhouse Market//Booking Export//DE\r\nCALSCALE:GREGORIAN\r\n';
  for (const b of bookingResults) {
    ics += 'BEGIN:VEVENT\r\n';
    ics += `UID:${b.id}@greenhouse-fuerstenberg.de\r\n`;
    ics += `DTSTART;VALUE=DATE:${toIcsDate(b.check_in)}\r\n`;
    ics += `DTEND;VALUE=DATE:${toIcsDate(b.check_out)}\r\n`;
    ics += `SUMMARY:Belegt (Greenhouse Booking)\r\n`;
    ics += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
    ics += 'END:VEVENT\r\n';
  }
  function addOneDay(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  for (const b of blockedResults) {
    let cur = addOneDay(b.check_in);
    let dayIndex = 0;
    while (cur < b.check_out) {
      const next = addOneDay(cur);
      ics += 'BEGIN:VEVENT\r\n';
      ics += `UID:${b.id}-${dayIndex}@greenhouse-fuerstenberg.de\r\n`;
      ics += `DTSTART;VALUE=DATE:${toIcsDate(cur)}\r\n`;
      ics += `DTEND;VALUE=DATE:${toIcsDate(next)}\r\n`;
      ics += `SUMMARY:Blockiert\r\n`;
      ics += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z\r\n`;
      ics += 'END:VEVENT\r\n';
      cur = next;
      dayIndex++;
    }
  }
  ics += 'END:VCALENDAR\r\n';

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

// ---------------------------------------------------------------------------
// Bestehender iCal-Proxy (Airbnb -> Website)
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
}// ---------------------------------------------------------------------------
// DATEV-Automatik: Rechnungen (Anzahlung + Restzahlung) für bestätigte
// Buchungen automatisch als PDF an das DATEV-Einlese-Postfach senden.
//
// WICHTIG — bewusste Verzögerung bis zum Anreisedatum:
// Eine Buchung gilt aus Sicht dieser Automatik erst als "endgültig" (nicht
// mehr stornierbar), sobald das Anreisedatum erreicht oder überschritten ist.
// Erst DANN werden fällige, bereits bezahlte Anzahlungen/Restzahlungen als
// Rechnung erzeugt und an DATEV gemeldet — nie vorher, auch wenn die Zahlung
// selbst schon vorher eingegangen ist.
//
// Die Kaution ("deposit") ist ausdrücklich NICHT Teil dieser Automatik.
// ---------------------------------------------------------------------------

const DATEV_UPLOAD_EMAIL = '5f7f7361-efe5-4cad-8db0-a0849c883227@uploadmail.datev.de';
const DATEV_SENDER_EMAIL = 'buchhaltung@greenhouse-fuerstenberg.de';

// Liefert das heutige Datum als 'YYYY-MM-DD' — bewusst in deutscher Zeit
// (Europe/Berlin), nicht in UTC. So bleibt die Berechnung ("heute" für DATEV-
// Fälligkeit, Erinnerungen, Begrüßungsmails) mit dem tatsächlichen deutschen
// Kalendertag synchron, unabhängig von der Tages-/Nachtzeit in UTC (sonst
// würde z. B. kurz nach deutscher Mitternacht UTC noch den Vortag zeigen).
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

async function getCompanyInfo(env) {
  const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'company_info'`).first();
  const defaults = { email: 'Greenhousemarket@proton.me', iban: '', bic: '', taxId: '', registerNr: '' };
  if (!row) return defaults;
  try {
    return { ...defaults, ...JSON.parse(row.value_json) };
  } catch (e) {
    return defaults;
  }
}

async function getWifiInfo(env) {
  const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'wifi'`).first();
  const defaults = { name: 'GREENHOUSE', password: '' };
  if (!row) return defaults;
  try {
    return { ...defaults, ...JSON.parse(row.value_json) };
  } catch (e) {
    return defaults;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Mailversand über Resend
// ---------------------------------------------------------------------------
async function sendMail(env, { to, from, bcc, subject, text, attachments }) {
  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
  };
  if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];
  if (attachments) body.attachments = attachments;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend-Versand fehlgeschlagen (${res.status}): ${errText}`);
  }
  return await res.json();
}

const WOHNUNG_LABELS = { wohnung1: 'Wohnung I', wohnung2: 'Wohnung II', both: 'Beide Wohnungen' };

async function buildDatevInvoicePdf({ invoiceId, guestName, guestAddress, wohnung, checkIn, checkOut, description, amount, invoiceDate, companyInfo }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const marginLeft = 50;
  const pageWidth = 595.28;
  let y = 790;

  const draw = (text, x, yPos, opts = {}) => {
    page.drawText(String(text ?? ''), {
      x, y: yPos,
      size: opts.size || 10,
      font: opts.bold ? bold : font,
      color: rgb(0.12, 0.12, 0.12),
    });
  };

  draw('Greenhouse Market GbR', marginLeft, y, { size: 14, bold: true }); y -= 18;
  draw('Brandenburger Straße 17, 16798 Fürstenberg/Havel', marginLeft, y); y -= 30;

  draw(`RECHNUNG ${invoiceId}`, marginLeft, y, { size: 13, bold: true }); y -= 18;
  draw(`Rechnungsdatum: ${new Date(invoiceDate).toLocaleDateString('de-DE')}`, marginLeft, y); y -= 24;

  draw('Rechnungsempfänger:', marginLeft, y, { bold: true }); y -= 14;
  draw(guestName || '', marginLeft, y); y -= 14;
  for (const line of (guestAddress || '').split('\n')) {
    if (!line) continue;
    draw(line, marginLeft, y); y -= 14;
  }
  y -= 10;

  draw(`Wohnung: ${WOHNUNG_LABELS[wohnung] || wohnung}`, marginLeft, y); y -= 14;
  draw(`Aufenthalt: ${checkIn} bis ${checkOut}`, marginLeft, y); y -= 28;

  draw(description, marginLeft, y);
  draw(`${amount.toFixed(2)} €`, pageWidth - 150, y);
  y -= 22;

  page.drawLine({
    start: { x: marginLeft, y: y + 8 },
    end: { x: pageWidth - 50, y: y + 8 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
  y -= 10;

  draw('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', marginLeft, y); y -= 24;
  draw(`Gesamtbetrag: ${amount.toFixed(2)} €`, marginLeft, y, { bold: true, size: 12 }); y -= 34;

  draw('Zahlungsdaten:', marginLeft, y, { bold: true }); y -= 14;
  draw(`IBAN: ${companyInfo.iban || '-'}`, marginLeft, y); y -= 14;
  draw(`BIC: ${companyInfo.bic || '-'}`, marginLeft, y); y -= 14;
  draw(`Verwendungszweck: ${invoiceId}`, marginLeft, y); y -= 24;

  if (companyInfo.taxId) { draw(`USt-IdNr. gem. § 27a UStG: ${companyInfo.taxId}`, marginLeft, y); y -= 14; }
  if (companyInfo.registerNr) { draw(`Unternehmensregisternr.: ${companyInfo.registerNr}`, marginLeft, y); }

  return await pdfDoc.save();
}

async function ensureLegInvoice(env, booking, leg) {
  const isDownpayment = leg === 'downpayment';

  if (!isDownpayment && booking.remaining_invoice_id) {
    const existing = await getRow(env, 'invoices', booking.remaining_invoice_id);
    if (existing) {
      return {
        invoiceId: existing.id,
        amount: existing.gross,
        description: JSON.parse(existing.items_json)[0]?.description || 'Restzahlung',
        invoiceDate: existing.invoice_date,
      };
    }
  }

  const amount = isDownpayment ? booking.down_payment : booking.remaining;
  const description = isDownpayment
    ? `Anzahlung für Aufenthalt ${booking.check_in} bis ${booking.check_out}`
    : `Restzahlung für Aufenthalt ${booking.check_in} bis ${booking.check_out}`;
  const invoiceDate = todayStr();
  const newInvoiceId = `RE-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}${isDownpayment ? 'A' : 'B'}`;
  const items = [{ description, amount }];

  await env.DB.prepare(
    `INSERT INTO invoices (
      id, source_ref, wohnung, guest_name, guest_email, guest_address, invoice_date,
      service_start, service_end, items_json, vat_mode, discount_percent,
      raw_net, discount_amount, net, vat_rate, vat_amount, gross, notes, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    newInvoiceId, `booking:${booking.id}`, booking.wohnung, booking.guest_name, booking.guest_email,
    booking.guest_address || '', invoiceDate, booking.check_in, booking.check_out,
    JSON.stringify(items), 'kleinunternehmer', 0,
    amount, 0, amount, 0, 0, amount,
    isDownpayment
      ? `Automatisch erzeugt und an DATEV übermittelt (Anzahlung) am ${invoiceDate}.`
      : `Automatisch erzeugt (Restzahlung) am ${invoiceDate}.`,
    'open'
  ).run();

  if (!isDownpayment) {
    await env.DB.prepare(`UPDATE bookings SET remaining_invoice_id = ? WHERE id = ?`).bind(newInvoiceId, booking.id).run();
  }

  return { invoiceId: newInvoiceId, amount, description, invoiceDate };
}

async function sendDatevInvoiceForLeg(env, booking, leg, companyInfo) {
  const isDownpayment = leg === 'downpayment';
  const { invoiceId: newInvoiceId, amount, description, invoiceDate } = await ensureLegInvoice(env, booking, leg);

  const pdfBytes = await buildDatevInvoicePdf({
    invoiceId: newInvoiceId,
    guestName: booking.guest_name,
    guestAddress: booking.guest_address,
    wohnung: booking.wohnung,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    description,
    amount,
    invoiceDate,
    companyInfo,
  });
  const base64Pdf = bytesToBase64(pdfBytes);

  await sendMail(env, {
    to: DATEV_UPLOAD_EMAIL,
    from: DATEV_SENDER_EMAIL,
    subject: `Rechnung ${newInvoiceId} – Greenhouse Market GbR`,
    text:
      `Automatischer DATEV-Beleg-Upload.\n\n` +
      `Rechnung: ${newInvoiceId}\n` +
      `Buchung: ${booking.id}\n` +
      `Gast: ${booking.guest_name}\n` +
      `Zeitraum: ${booking.check_in} bis ${booking.check_out}\n` +
      `Betrag: ${amount.toFixed(2)} €\n` +
      `Art: ${isDownpayment ? 'Anzahlung' : 'Restzahlung'}`,
    attachments: [
      {
        content: base64Pdf,
        filename: `${newInvoiceId}.pdf`,
      },
    ],
  });

  const nowIso = new Date().toISOString();
  const column = isDownpayment ? 'datev_downpayment_sent_at' : 'datev_remaining_sent_at';
  await env.DB.prepare(`UPDATE bookings SET ${column} = ? WHERE id = ?`).bind(nowIso, booking.id).run();

  return newInvoiceId;
}

async function runDatevExport(env, dryRun = false) {
  const today = todayStr();
  const companyInfo = dryRun ? null : await getCompanyInfo(env);

  const { results: dueBookings } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE status != 'cancelled' AND check_in <= ?`
  ).bind(today).all();

  const report = { checkedBookings: dueBookings.length, sent: [], due: [] };

  for (const b of dueBookings) {
    const legsToSend = [];
    if (b.down_payment_paid && b.down_payment > 0 && !b.datev_downpayment_sent_at) legsToSend.push('downpayment');
    if (b.remaining_paid && b.remaining > 0 && !b.datev_remaining_sent_at) legsToSend.push('remaining');

    for (const leg of legsToSend) {
      report.due.push({ bookingId: b.id, guestName: b.guest_name, checkIn: b.check_in, checkOut: b.check_out, leg });
      if (!dryRun) {
        const invoiceId = await sendDatevInvoiceForLeg(env, b, leg, companyInfo);
        report.sent.push({ bookingId: b.id, leg, invoiceId });
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Automatische Restzahlungs-Erinnerung
// ---------------------------------------------------------------------------

const REMAINING_DUE_DAYS_BEFORE_CHECKIN = 14;
const REMAINING_FINAL_REMINDER_DAYS_BEFORE_CHECKIN = 3;
const REMINDER_SENDER_EMAIL = 'info@greenhouse-fuerstenberg.de';

function daysUntil(dateStr) {
  const today = new Date(todayStr() + 'T00:00:00Z');
  const target = new Date(dateStr + 'T00:00:00Z');
  return Math.round((target - today) / 86400000);
}

function buildReminderText({ guestName, checkIn, checkOut, remaining, bookingId, companyInfo, isFinal }) {
  const intro = isFinal
    ? `dies ist eine letzte Erinnerung: Ihre Anreise steht kurz bevor, und für Ihren Aufenthalt im Greenhouse ist noch eine Restzahlung offen.`
    : `wir möchten Sie freundlich an die noch ausstehende Restzahlung für Ihren bevorstehenden Aufenthalt im Greenhouse erinnern.`;

  return `Liebe/r ${guestName},

${intro}

Zeitraum: ${checkIn} bis ${checkOut}
Restbetrag: ${remaining.toFixed(2)} €

Bitte überweisen Sie den Betrag zeitnah auf folgendes Konto:
IBAN: ${companyInfo.iban || '[bitte IBAN in den Einstellungen hinterlegen]'}
BIC: ${companyInfo.bic || '[bitte BIC in den Einstellungen hinterlegen]'}
Verwendungszweck: ${bookingId}

Bei Fragen antworten Sie gerne direkt auf diese E-Mail.

Herzliche Grüße
Greenhouse Market`;
}

async function sendRemainingReminder(env, booking, isFinal, companyInfo) {
  const remaining = Number(booking.remaining) || 0;
  const text = buildReminderText({
    guestName: booking.guest_name,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    remaining,
    bookingId: booking.id,
    companyInfo,
    isFinal,
  });
  const subject = isFinal
    ? `Letzte Erinnerung: Restzahlung für Ihren Aufenthalt (${booking.check_in} – ${booking.check_out})`
    : `Erinnerung: Restzahlung für Ihren Aufenthalt (${booking.check_in} – ${booking.check_out})`;

  const { invoiceId, amount, description, invoiceDate } = await ensureLegInvoice(env, booking, 'remaining');
  const pdfBytes = await buildDatevInvoicePdf({
    invoiceId,
    guestName: booking.guest_name,
    guestAddress: booking.guest_address,
    wohnung: booking.wohnung,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    description,
    amount,
    invoiceDate,
    companyInfo,
  });
  const base64Pdf = bytesToBase64(pdfBytes);

  await sendMail(env, {
    to: booking.guest_email,
    from: REMINDER_SENDER_EMAIL,
    bcc: companyInfo.email || undefined,
    subject,
    text,
    attachments: [
      {
        content: base64Pdf,
        filename: `${invoiceId}.pdf`,
      },
    ],
  });

  const column = isFinal ? 'remaining_final_reminder_sent_at' : 'remaining_reminder_sent_at';
  await env.DB.prepare(`UPDATE bookings SET ${column} = ? WHERE id = ?`).bind(new Date().toISOString(), booking.id).run();
}

async function runRemainingReminders(env, dryRun = false) {
  const companyInfo = dryRun ? null : await getCompanyInfo(env);

  const { results: candidates } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE status != 'cancelled'
     AND remaining_paid = 0
     AND remaining > 0
     AND check_in >= ?`
  ).bind(todayStr()).all();

  const report = { checked: candidates.length, sent: [], due: [] };

  for (const b of candidates) {
    const daysLeft = daysUntil(b.check_in);
    const isFinalWindow = daysLeft <= REMAINING_FINAL_REMINDER_DAYS_BEFORE_CHECKIN;
    const isDueWindow = daysLeft <= REMAINING_DUE_DAYS_BEFORE_CHECKIN;

    if (isFinalWindow && !b.remaining_final_reminder_sent_at) {
      report.due.push({ bookingId: b.id, guestName: b.guest_name, checkIn: b.check_in, type: 'final' });
      if (!dryRun) {
        await sendRemainingReminder(env, b, true, companyInfo);
        report.sent.push({ bookingId: b.id, type: 'final' });
      }
      continue;
    }

    if (isDueWindow && !b.remaining_reminder_sent_at) {
      report.due.push({ bookingId: b.id, guestName: b.guest_name, checkIn: b.check_in, type: 'due' });
      if (!dryRun) {
        await sendRemainingReminder(env, b, false, companyInfo);
        report.sent.push({ bookingId: b.id, type: 'due' });
      }
    }
  }

  return report;
}// ---------------------------------------------------------------------------
// Automatische Begrüßungsmail
//
// Wird einmalig ca. 5 Tage vor Anreise an den Gast verschickt — mit Anrede
// per Vorname, Check-in-Zeit, Adresse und WLAN-Zugangsdaten. BCC an die
// eigene Adresse, damit ihr seht, dass sie rausgegangen ist.
// ---------------------------------------------------------------------------

const WELCOME_EMAIL_DAYS_BEFORE_CHECKIN = 5;
const WELCOME_EMAIL_SENDER = 'info@greenhouse-fuerstenberg.de';
const PROPERTY_ADDRESS = 'Brandenburger Straße 17, 16798 Fürstenberg/Havel';

function firstNameOf(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return 'Gast';
  return trimmed.split(' ')[0];
}

function formatGermanDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('de-DE', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function buildWelcomeEmailText({ firstName, checkInFormatted, wifiInfo }) {
  return `Hallo ${firstName},

dein Aufenthalt findet bald statt. Du kannst am ${checkInFormatted} ab 15:00 Uhr jederzeit einchecken.

Weißt du schon, wann du ungefähr ankommen wirst?

Hier ist die Adresse:
${PROPERTY_ADDRESS}

Hier sind die WLAN-Zugangsdaten:
Name: ${wifiInfo.name}
Passwort: ${wifiInfo.password || '[bitte in den Einstellungen hinterlegen]'}

Wenn du Fragen hast, gib mir gern Bescheid.

Liebe Grüße
Lucia und Jan 
Greenhouse Fürstenberg `;
}

async function sendWelcomeEmail(env, booking, wifiInfo, companyInfo) {
  const text = buildWelcomeEmailText({
    firstName: firstNameOf(booking.guest_name),
    checkInFormatted: formatGermanDate(booking.check_in),
    wifiInfo,
  });

  await sendMail(env, {
    to: booking.guest_email,
    from: WELCOME_EMAIL_SENDER,
    bcc: companyInfo.email || undefined,
    subject: `Bald geht's los! Dein Aufenthalt im Greenhouse`,
    text,
  });

  await env.DB.prepare(`UPDATE bookings SET welcome_email_sent_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), booking.id).run();
}

async function runWelcomeEmails(env, dryRun = false) {
  const wifiInfo = dryRun ? null : await getWifiInfo(env);
  const companyInfo = dryRun ? null : await getCompanyInfo(env);

  const { results: candidates } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE status != 'cancelled'
     AND welcome_email_sent_at IS NULL
     AND check_in >= ?`
  ).bind(todayStr()).all();

  const report = { checked: candidates.length, sent: [], due: [] };

  for (const b of candidates) {
    const daysLeft = daysUntil(b.check_in);
    if (daysLeft <= WELCOME_EMAIL_DAYS_BEFORE_CHECKIN) {
      report.due.push({ bookingId: b.id, guestName: b.guest_name, checkIn: b.check_in });
      if (!dryRun) {
        await sendWelcomeEmail(env, b, wifiInfo, companyInfo);
        report.sent.push({ bookingId: b.id });
      }
    }
  }

  return report;
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
        const includeBlocks = url.searchParams.get('includeBlocks') !== 'false';
        return handleExportIcs(request, env, wohnung, includeBlocks);
      }

      if (path === '/api/welcome-emails/status' && method === 'GET') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        const report = await runWelcomeEmails(env, true);
        return jsonResponse(report);
      }
      if (path === '/api/welcome-emails/run' && method === 'POST') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        const report = await runWelcomeEmails(env, false);
        return jsonResponse(report);
      }

      if (path === '/api/reminders/status' && method === 'GET') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        const report = await runRemainingReminders(env, true);
        return jsonResponse(report);
      }
      if (path === '/api/reminders/run' && method === 'POST') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        const report = await runRemainingReminders(env, false);
        return jsonResponse(report);
      }

      if (path === '/api/datev/status' && method === 'GET') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        const report = await runDatevExport(env, true);
        return jsonResponse(report);
      }
      if (path === '/api/datev/run' && method === 'POST') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        const report = await runDatevExport(env, false);
        return jsonResponse(report);
      }

      if (path === '/api/retention/preview' && method === 'GET') return await handleRetentionPreview(request, env);
      if (path === '/api/retention/run' && method === 'POST') return await handleRetentionRun(request, env);
      if (path === '/api/retention/log' && method === 'GET') return await handleRetentionLog(request, env);
      if (path === '/api/public-settings' && method === 'GET') return await handlePublicSettings(request, env);
      if (path === '/api/public-blocked-edges' && method === 'GET') {
        const wohnung = url.searchParams.get('wohnung') || 'wohnung1';
        return await handlePublicBlockedEdges(request, env, wohnung);
      }
      if (path === '/api/admin-update' && method === 'POST') return await handleChangePassword(request, env);
      if (path === '/api/backup' && method === 'GET') return await handleBackupNow(request, env);
      if (path === '/api/backups' && method === 'GET') return await handleListBackups(request, env);
      const backupMatch = path.match(/^\/api\/backups\/(\d+)$/);
      if (backupMatch && method === 'GET') return await handleGetBackup(request, env, backupMatch[1]);

      const blockedMatch = path.match(/^\/api\/blocked-periods(?:\/([^/]+))?$/);
      if (blockedMatch) return await handleBlockedPeriods(request, env, method, blockedMatch[1]);

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

  async scheduled(controller, env, ctx) {
    if (controller.cron === '0 4 * * *') {
      const datevReport = await runDatevExport(env, false);
      console.log(
        `DATEV-Export ausgeführt: ${datevReport.checkedBookings} Buchungen geprüft, ` +
        `${datevReport.sent.length} Rechnung(en) an DATEV gesendet.`
      );

      const reminderReport = await runRemainingReminders(env, false);
      console.log(
        `Restzahlungs-Erinnerungen ausgeführt: ${reminderReport.checked} Buchungen geprüft, ` +
        `${reminderReport.sent.length} Erinnerung(en) verschickt.`
      );

      const welcomeReport = await runWelcomeEmails(env, false);
      console.log(
        `Begrüßungsmails ausgeführt: ${welcomeReport.checked} Buchungen geprüft, ` +
        `${welcomeReport.sent.length} Mail(s) verschickt.`
      );
      return;
    }

    const report = await runRetentionCleanup(env, false);
    console.log(
      `Löschkonzept ausgeführt: ${report.staleInquiries.length} Anfragen gelöscht, ` +
      `${report.staleOffers.length} Angebote gelöscht, ` +
      `${report.bookingsToAnonymize.length} Buchungen anonymisiert.`
    );
    await createAutomaticBackup(env);
    console.log('Automatisches wöchentliches Backup erstellt.');
  },
};
