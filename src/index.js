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

// Prüft den Admin-Token für alle schreibenden/lesenden Admin-Routen.
// Die einzige öffentliche Route ist POST /api/inquiries (Gäste-Anfrage).
// Wandelt ein Passwort in einen SHA-256-Hash um (Hex-String). So liegt das
// eigentliche Passwort nie im Klartext in der Datenbank.
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Prüft den Admin-Token für alle schreibenden/lesenden Admin-Routen.
// Die einzige öffentliche Route ist POST /api/inquiries (Gäste-Anfrage).
//
// Zwei mögliche Quellen für das gültige Passwort:
// 1. Ein in der Datenbank gespeicherter Passwort-Hash (wurde übers Booking-Tool
//    selbst gesetzt/geändert) — wird bevorzugt geprüft, falls vorhanden.
// 2. Fallback: das Cloudflare-Secret ADMIN_TOKEN (der ursprüngliche, beim
//    Einrichten per Dashboard/Wrangler gesetzte Wert) — greift nur, solange
//    noch kein Passwort in der Datenbank gesetzt wurde.
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

// Vergibt EINMALIG eine fortlaufende, für Menschen lesbare Nummer (z. B.
// RE-2026-0001 / AN-2026-0001) — wird bei Erstellung in der Datenbank
// gespeichert (Spalte display_number) und danach nie mehr automatisch
// verändert. So sehen Buchungstool UND alle automatisch/manuell versendeten
// PDFs garantiert dieselbe Nummer für dieselbe Rechnung/Angebot.
async function nextDisplayNumber(env, table, prefix, yearSource) {
  const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${table}`).first();
  const seq = (row?.c || 0) + 1;
  const year = yearSource ? new Date(yearSource).getFullYear() : new Date().getFullYear();
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
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

// Legt automatisch einen Gast im Adressbuch an, falls noch keiner mit dieser
// E-Mail existiert — genutzt bei neuen Anfragen und neuen Buchungen, damit das
// Gäste-Adressbuch nicht manuell gepflegt werden muss.
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

    const depositPaid = b.depositPaid !== undefined ? boolToInt(b.depositPaid) : existing.deposit_paid;
    const downPaymentPaid = b.downPaymentPaid !== undefined ? boolToInt(b.downPaymentPaid) : existing.down_payment_paid;
    const remainingPaid = b.remainingPaid !== undefined ? boolToInt(b.remainingPaid) : existing.remaining_paid;

    // Zeitstempel wird NUR beim Übergang unbezahlt -> bezahlt gesetzt (nicht bei
    // jedem Speichern neu überschrieben). Wichtig für die DATEV-Automatik: sie
    // rechnet damit, wann die Zahlung tatsächlich einging (steuerlich relevant
    // für die Ist-Versteuerung), nicht wann die Buchung zuletzt bearbeitet wurde.
    const downPaymentPaidAt = (downPaymentPaid && !existing.down_payment_paid)
      ? new Date().toISOString() : existing.down_payment_paid_at;
    const remainingPaidAt = (remainingPaid && !existing.remaining_paid)
      ? new Date().toISOString() : existing.remaining_paid_at;

    await env.DB.prepare(
      `UPDATE bookings SET deposit_paid=?, down_payment_paid=?, remaining_paid=?, status=?,
       down_payment_paid_at=?, remaining_paid_at=?
       WHERE id=?`
    ).bind(
      depositPaid, downPaymentPaid, remainingPaid,
      b.status || existing.status,
      downPaymentPaidAt, remainingPaidAt,
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
    const displayNumber = o.displayNumber || await nextDisplayNumber(env, 'offers', 'AN', null);
    await env.DB.prepare(
      `INSERT INTO offers (
        id, display_number, guest_id, source_inquiry_id, guest_name, guest_email, guest_phone, guest_address,
        wohnung, check_in, check_out, persons, early_checkin, late_checkout, final_cleaning,
        dog_fee, dog_count, projekt_space, projekt_space_cleaning, discount_percent,
        total, nights, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId, displayNumber, o.guestId || null, o.sourceInquiryId || null, o.guestName, o.guestEmail,
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
      display_number: o.displayNumber !== undefined && o.displayNumber.trim()
        ? o.displayNumber.trim() : (existing.display_number || await nextDisplayNumber(env, 'offers', 'AN', null)),
    };

    await env.DB.prepare(
      `UPDATE offers SET guest_id=?, guest_name=?, guest_email=?, guest_phone=?, guest_address=?,
       wohnung=?, check_in=?, check_out=?, persons=?, early_checkin=?, late_checkout=?, final_cleaning=?,
       dog_fee=?, dog_count=?, projekt_space=?, projekt_space_cleaning=?, discount_percent=?,
       total=?, nights=?, status=?, display_number=? WHERE id=?`
    ).bind(
      merged.guest_id, merged.guest_name, merged.guest_email, merged.guest_phone, merged.guest_address,
      merged.wohnung, merged.check_in, merged.check_out, merged.persons, merged.early_checkin, merged.late_checkout,
      merged.final_cleaning, merged.dog_fee, merged.dog_count, merged.projekt_space, merged.projekt_space_cleaning,
      merged.discount_percent, merged.total, merged.nights, merged.status, merged.display_number, id
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
    const displayNumber = inv.displayNumber || await nextDisplayNumber(env, 'invoices', 'RE', inv.invoiceDate);
    await env.DB.prepare(
      `INSERT INTO invoices (
        id, display_number, source_ref, wohnung, guest_name, guest_email, guest_address, invoice_date,
        service_start, service_end, items_json, vat_mode, discount_percent,
        raw_net, discount_amount, net, vat_rate, vat_amount, gross, notes, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      newId, displayNumber, inv.sourceRef || '', inv.wohnung || 'wohnung1', inv.guestName, inv.guestEmail,
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
      display_number: inv.displayNumber !== undefined && inv.displayNumber.trim()
        ? inv.displayNumber.trim() : (existing.display_number || await nextDisplayNumber(env, 'invoices', 'RE', existing.invoice_date)),
    };

    await env.DB.prepare(
      `UPDATE invoices SET source_ref=?, wohnung=?, guest_name=?, guest_email=?, guest_address=?,
       invoice_date=?, service_start=?, service_end=?, items_json=?, vat_mode=?, discount_percent=?,
       raw_net=?, discount_amount=?, net=?, vat_rate=?, vat_amount=?, gross=?, notes=?, status=?, display_number=?
       WHERE id=?`
    ).bind(
      merged.source_ref, merged.wohnung, merged.guest_name, merged.guest_email, merged.guest_address,
      merged.invoice_date, merged.service_start, merged.service_end, merged.items_json, merged.vat_mode,
      merged.discount_percent, merged.raw_net, merged.discount_amount, merged.net, merged.vat_rate,
      merged.vat_amount, merged.gross, merged.notes, merged.status, merged.display_number, id
    ).run();
    const updated = await getRow(env, 'invoices', id);
    return jsonResponse({ ...updated, items: JSON.parse(updated.items_json) });
  }

  if (method === 'DELETE' && id) {
    await deleteRow(env, 'invoices', id);
    return jsonResponse({ deleted: true });
  }

  return errorResponse('Methode nicht unterstützt', 405);
}

// ---------------------------------------------------------------------------
// Einstellungen (Preise, Firmendaten, Stornobedingungen, Anzahlungs-%)
// ---------------------------------------------------------------------------

// Öffentlicher, nicht-passwortgeschützter Endpunkt für das Gäste-Tool — zeigt
// nur die Felder, die Gäste vor einer Buchung legitim sehen müssen (Preise,
// Stornobedingungen). KEINE Firmendaten (IBAN etc.) oder sonstige interne
// Einstellungen — diese bleiben ausschließlich über /api/settings (mit Login) erreichbar.
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

// Öffentlicher Endpunkt: liefert die ORIGINAL eingegebenen Start-/Enddaten aller
// manuellen Blockierungen (unverschoben) — genutzt von der Website, um die
// beiden Randtage (die selbst frei bleiben) visuell als Übergangstage zu
// kennzeichnen, genau wie bei An-/Abreisetagen echter Buchungen.
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
// Manuell jederzeit abrufbar, zusätzlich läuft wöchentlich ein automatischer
// Schnappschuss (siehe scheduled()). Alte automatische Schnappschüsse werden
// nach einer Weile aufgeräumt (die letzten 12 — ca. 3 Monate wöchentlich —
// bleiben erhalten).
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
  // Alte Schnappschüsse aufräumen — die letzten 12 (≈ 3 Monate wöchentlich) bleiben.
  await env.DB.prepare(
    `DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY created_at DESC LIMIT 12)`
  ).run();
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
// Airbnb-Export: NUR bestätigte Buchungen (status IN awaiting_downpayment,
// confirmed, completed — d.h. mindestens die Kaution ist bestätigt und die
// Buchung ist damit verbindlich; "awaiting_deposit" zählt bewusst NICHT als
// bestätigt und blockiert Airbnb nicht).
// ---------------------------------------------------------------------------

function toIcsDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

async function handleExportIcs(request, env, wohnungParam, includeBlocks) {
  const validWohnungen = ['wohnung1', 'wohnung2', 'both'];
  if (!validWohnungen.includes(wohnungParam)) {
    return new Response('Ungültiger Parameter "wohnung" (erwartet: wohnung1, wohnung2 oder both)', { status: 400 });
  }

  // "both"-Buchungen blockieren zusätzlich auch die Einzelwohnungen, da bei
  // Buchung beider Wohnungen natürlich auch jede einzelne belegt ist.
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
    // Statt EINES Termins über den ganzen Zeitraum wird für JEDEN einzelnen,
    // wirklich betroffenen Tag (checkIn+1 bis checkOut-1) ein eigener,
    // unmissverständlicher Ein-Tages-Termin erzeugt. Das lässt keinen
    // Interpretationsspielraum mehr zu, wie genau Airbnb den Rand eines
    // mehrtägigen Zeitraums behandelt (das hatte sich als unzuverlässig
    // erwiesen) — ein einzelner Tag (DTSTART=X, DTEND=X+1) ist eindeutig.
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
// DATEV-Automatik: Rechnungen (Anzahlung + Restzahlung) für bestätigte
// Buchungen automatisch als PDF an das DATEV-Einlese-Postfach senden.
//
// TIMING-REGEL (Stand: überarbeitet, ersetzt die alte "warte bis Anreise"-Logik):
// Eine Zahlung wird an DATEV gemeldet, sobald der SPÄTERE der beiden folgenden
// Zeitpunkte erreicht ist:
//   (a) 3 Tage nach dem Zeitpunkt, an dem die Zahlung im System als "bezahlt"
//       markiert wurde (kleiner Sicherheitspuffer für Korrekturen/Rückbuchungen)
//   (b) DATEV_SAFE_TO_SEND_DAYS_BEFORE_CHECKIN Tage vor Anreise — angelehnt an
//       die eigene Stornobedingung (aktuell: freie Stornierung bis 30 Tage vor
//       Anreise). Erst ab diesem Punkt gilt die Buchung als praktisch nicht
//       mehr kostenlos stornierbar.
//
// Das löst zwei Probleme der alten Regel:
// - Buchungen, bei denen Anzahlung und Restzahlung in unterschiedlichen
//   Kalenderjahren geleistet werden (z. B. Anzahlung im Dezember, Anreise im
//   Februar), werden nicht mehr fälschlich komplett ins Anreise-Jahr verschoben.
// - Trotzdem wird nie gemeldet, solange der Gast laut eigener Stornobedingung
//   noch kostenlos stornieren könnte.
//
// WICHTIG für den Steuerberater: Das tatsächliche Zahlungseingangsdatum (nicht
// das Datum des DATEV-Versands) ist im PDF und im Mailtext explizit als
// "Zahlungseingang" ausgewiesen — das ist bei Ist-Versteuerung das Jahr, dem
// die Einnahme zuzurechnen ist. Eine spätere Stornierung/Rückerstattung nach
// bereits erfolgter Meldung ist normal und wird im Jahr der Rückzahlung als
// Korrektur erfasst — sie macht die Vorjahresmeldung nicht ungültig.
//
// Die Kaution ("deposit") ist ausdrücklich NICHT Teil dieser Automatik — sie
// ist rückzahlbar und stellt keinen steuerpflichtigen Umsatz dar.
// ---------------------------------------------------------------------------

const DATEV_SAFE_TO_SEND_DAYS_BEFORE_CHECKIN = 30;
const DATEV_DAYS_AFTER_PAYMENT_BUFFER = 3;

// Standard-Adresse, falls in den Einstellungen noch keine eigene hinterlegt
// wurde. Im Admin-Tool (Tab Einstellungen) editierbar, falls DATEV euch mal
// eine neue Upload-Adresse zuweist.
const DEFAULT_DATEV_UPLOAD_EMAIL = '5f7f7361-efe5-4cad-8db0-a0849c883227@uploadmail.datev.de';

async function getDatevEmail(env) {
  const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'datev_email'`).first();
  if (!row) return DEFAULT_DATEV_UPLOAD_EMAIL;
  try {
    const parsed = JSON.parse(row.value_json);
    return (parsed && parsed.trim()) ? parsed.trim() : DEFAULT_DATEV_UPLOAD_EMAIL;
  } catch (e) {
    return DEFAULT_DATEV_UPLOAD_EMAIL;
  }
}

// Absenderadresse für automatische DATEV-Mails. Muss auf der bei Cloudflare
// Email Service "onboardeten" Sende-Domain liegen (greenhouse-fuerstenberg.de) —
// NICHT die private/geschäftliche ProtonMail-Adresse, da Cloudflare nur von
// freigeschalteten eigenen Domains aus versenden kann.
const DATEV_SENDER_EMAIL = 'buchhaltung@greenhouse-fuerstenberg.de';

// Liefert das heutige Datum als 'YYYY-MM-DD' — bewusst in deutscher Zeit
// (Europe/Berlin), nicht in UTC. So bleibt die Berechnung ("heute" für DATEV-
// Fälligkeit, Erinnerungen, Begrüßungsmails) mit dem tatsächlichen deutschen
// Kalendertag synchron, unabhängig von der Tages-/Nachtzeit in UTC (sonst
// würde z. B. kurz nach deutscher Mitternacht UTC noch den Vortag zeigen).
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

// Addiert (oder subtrahiert, bei negativem days) eine Anzahl Tage zu einem
// 'YYYY-MM-DD'-Datum und gibt das Ergebnis wieder als 'YYYY-MM-DD' zurück.
// Rechnet bewusst in UTC-Mittagsstunden intern (Kalendertag-Arithmetik, keine
// Uhrzeit-Feinheiten nötig, da beide Werte immer reine Datumsangaben sind).
function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
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

// Wandelt PDF-Bytes (Uint8Array) in einen Base64-String um — in Stücken, damit
// auch größere PDFs nicht am Aufruf-Stack-Limit von String.fromCharCode scheitern.
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Mailversand über Resend (kostenlose Alternative zu Cloudflare Email Service
// mit Workers Paid Plan). Erwartet ein Secret env.RESEND_API_KEY
// (einrichten mit: wrangler secret put RESEND_API_KEY).
// Anhänge: [{ content: <base64-String>, filename: 'datei.pdf' }]
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

// Erstellt ein schlankes, einseitiges Rechnungs-PDF für eine einzelne
// Zahlungs-Position (Anzahlung ODER Restzahlung). Bewusst einfacher gehalten
// als das Angebots-/Rechnungs-PDF im Frontend (jsPDF im Browser) — dieselbe
// Bibliothek läuft nicht in Cloudflare Workers, daher hier "pdf-lib".
async function buildDatevInvoicePdf({ invoiceId, guestName, guestAddress, wohnung, checkIn, checkOut, description, amount, invoiceDate, paidAtDate, companyInfo }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 in Punkt
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
  draw(`Rechnungsdatum: ${new Date(invoiceDate).toLocaleDateString('de-DE')}`, marginLeft, y); y -= 14;
  if (paidAtDate) {
    // Für den Steuerberater: das tatsächliche Zahlungseingangsdatum, relevant
    // für die Zuordnung zum richtigen Wirtschaftsjahr bei Ist-Versteuerung —
    // kann vom Rechnungsdatum abweichen, falls die Meldung an DATEV bewusst
    // verzögert wurde (Stornofrist-Sicherheitspuffer).
    draw(`Zahlungseingang: ${new Date(paidAtDate).toLocaleDateString('de-DE')}`, marginLeft, y, { bold: true }); y -= 14;
  }
  y -= 10;

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

// Erzeugt ein vollständiges Rechnungs-PDF mit ALLEN Posten (nicht nur einer
// einzelnen Anzahlung/Restzahlung) — genutzt für den manuellen DATEV-Versand
// beliebiger, bereits im System vorhandener Rechnungen (Tab "Rechnungen").
async function buildGeneralInvoicePdf({ invoiceId, guestName, guestAddress, invoiceDate, items, discountPercent, rawNet, discountAmount, net, vatRate, vatAmount, gross, notes, companyInfo }) {
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
  y -= 16;

  draw('Pos.', marginLeft, y, { bold: true });
  draw('Beschreibung', marginLeft + 40, y, { bold: true });
  draw('Menge', pageWidth - 210, y, { bold: true });
  draw('Einzelpreis', pageWidth - 155, y, { bold: true });
  draw('Betrag', pageWidth - 80, y, { bold: true });
  y -= 8;
  page.drawLine({ start: { x: marginLeft, y }, end: { x: pageWidth - 50, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 16;

  (items || []).forEach((item, idx) => {
    const qty = item.quantity ?? 1;
    const unitPrice = item.unitPrice ?? item.amount ?? 0;
    const lineTotal = item.amount !== undefined && item.quantity === undefined ? item.amount : qty * unitPrice;
    draw(String(idx + 1), marginLeft, y);
    draw(item.description || '', marginLeft + 40, y);
    draw(String(qty), pageWidth - 210, y);
    draw(`${Number(unitPrice).toFixed(2)} €`, pageWidth - 155, y);
    draw(`${Number(lineTotal).toFixed(2)} €`, pageWidth - 80, y);
    y -= 16;
  });

  y -= 8;
  page.drawLine({ start: { x: marginLeft, y: y + 8 }, end: { x: pageWidth - 50, y: y + 8 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 10;

  draw(`Zwischensumme: ${Number(rawNet).toFixed(2)} €`, pageWidth - 220, y); y -= 14;
  if (discountPercent > 0) {
    draw(`Rabatt (${discountPercent}%): -${Number(discountAmount).toFixed(2)} €`, pageWidth - 220, y); y -= 14;
  }
  if (vatRate > 0) {
    draw(`Netto: ${Number(net).toFixed(2)} €`, pageWidth - 220, y); y -= 14;
    draw(`zzgl. ${(vatRate * 100).toFixed(0)}% USt: ${Number(vatAmount).toFixed(2)} €`, pageWidth - 220, y); y -= 14;
  } else {
    draw('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', marginLeft, y); y -= 14;
  }
  draw(`Gesamtbetrag: ${Number(gross).toFixed(2)} €`, pageWidth - 220, y, { bold: true, size: 12 }); y -= 34;

  if (notes) {
    draw(notes, marginLeft, y); y -= 20;
  }

  draw('Zahlungsdaten:', marginLeft, y, { bold: true }); y -= 14;
  draw(`IBAN: ${companyInfo.iban || '-'}`, marginLeft, y); y -= 14;
  draw(`BIC: ${companyInfo.bic || '-'}`, marginLeft, y); y -= 14;
  draw(`Verwendungszweck: ${invoiceId}`, marginLeft, y); y -= 24;

  if (companyInfo.taxId) { draw(`USt-IdNr. gem. § 27a UStG: ${companyInfo.taxId}`, marginLeft, y); y -= 14; }
  if (companyInfo.registerNr) { draw(`Unternehmensregisternr.: ${companyInfo.registerNr}`, marginLeft, y); }

  return await pdfDoc.save();
}

// Manueller DATEV-Versand einer beliebigen, bereits vorhandenen Rechnung —
// unabhängig von der automatischen Anzahlung/Restzahlung-Buchungslogik. Für
// Sonderfälle, in denen von Hand nachgereicht werden muss.
async function sendInvoiceToDatevManually(env, invoiceId) {
  const invoice = await getRow(env, 'invoices', invoiceId);
  if (!invoice) throw new Error('Rechnung nicht gefunden');

  // Falls diese Rechnung noch aus der Zeit vor Einführung der persistenten
  // Anzeige-Nummer stammt, wird jetzt einmalig eine vergeben und gespeichert.
  let displayNumber = invoice.display_number;
  if (!displayNumber) {
    displayNumber = await nextDisplayNumber(env, 'invoices', 'RE', invoice.invoice_date);
    await env.DB.prepare(`UPDATE invoices SET display_number = ? WHERE id = ?`).bind(displayNumber, invoice.id).run();
  }

  const companyInfo = await getCompanyInfo(env);
  const datevEmail = await getDatevEmail(env);
  const items = JSON.parse(invoice.items_json || '[]');

  const pdfBytes = await buildGeneralInvoicePdf({
    invoiceId: displayNumber,
    guestName: invoice.guest_name,
    guestAddress: invoice.guest_address,
    invoiceDate: invoice.invoice_date,
    items,
    discountPercent: invoice.discount_percent,
    rawNet: invoice.raw_net,
    discountAmount: invoice.discount_amount,
    net: invoice.net,
    vatRate: invoice.vat_rate,
    vatAmount: invoice.vat_amount,
    gross: invoice.gross,
    notes: invoice.notes,
    companyInfo,
  });
  const base64Pdf = bytesToBase64(pdfBytes);

  await sendMail(env, {
    to: datevEmail,
    from: DATEV_SENDER_EMAIL,
    subject: `Rechnung ${displayNumber} – Greenhouse Market GbR (manueller Versand)`,
    text:
      `Manueller DATEV-Beleg-Upload.\n\n` +
      `Rechnung: ${displayNumber}\n` +
      `Gast: ${invoice.guest_name}\n` +
      `Rechnungsdatum: ${new Date(invoice.invoice_date).toLocaleDateString('de-DE')}\n` +
      `Betrag: ${Number(invoice.gross).toFixed(2)} €\n` +
      `Quelle: ${invoice.source_ref || '-'}`,
    attachments: [{ content: base64Pdf, filename: `${displayNumber}.pdf` }],
  });

  await env.DB.prepare(`UPDATE invoices SET datev_sent_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), invoice.id).run();

  return invoice.id;
}

// Erstellt EINMALIG eine Rechnung für eine Zahlungs-Position (Anzahlung/
// Restzahlung) einer Buchung — oder gibt die bereits vorhandene zurück, falls
// z. B. die Restzahlungs-Erinnerung sie schon früher angelegt hat. So bekommt
// dieselbe Zahlungs-Position nie zwei verschiedene Rechnungsnummern, egal ob
// zuerst die Erinnerung oder zuerst der DATEV-Export läuft.
async function ensureLegInvoice(env, booking, leg) {
  const isDownpayment = leg === 'downpayment';
  const linkedInvoiceId = isDownpayment ? booking.down_payment_invoice_id : booking.remaining_invoice_id;

  // Falls für diese Zahlungs-Position schon einmal eine Rechnung angelegt
  // wurde (z. B. Anzahlung beim manuellen Versand, Restzahlung bei der
  // Erinnerungsmail), wird sie wiederverwendet statt eine zweite anzulegen.
  if (linkedInvoiceId) {
    const existing = await getRow(env, 'invoices', linkedInvoiceId);
    if (existing) {
      return {
        invoiceId: existing.id,
        displayNumber: existing.display_number || existing.id,
        amount: existing.gross,
        description: JSON.parse(existing.items_json)[0]?.description || (isDownpayment ? 'Anzahlung' : 'Restzahlung'),
        invoiceDate: existing.invoice_date,
      };
    }
    // Datensatz wurde zwischenzeitlich gelöscht -> unten neu anlegen.
  }

  const amount = isDownpayment ? booking.down_payment : booking.remaining;
  const description = isDownpayment
    ? `Anzahlung für Aufenthalt ${booking.check_in} bis ${booking.check_out}`
    : `Restzahlung für Aufenthalt ${booking.check_in} bis ${booking.check_out}`;
  const invoiceDate = todayStr();
  // Suffix A/B verhindert Kollisionen, falls Anzahlung und Restzahlung
  // derselben Buchung im selben Lauf (also derselben Sekunde) erzeugt werden.
  const newInvoiceId = `RE-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}${isDownpayment ? 'A' : 'B'}`;
  const displayNumber = await nextDisplayNumber(env, 'invoices', 'RE', invoiceDate);
  const items = [{ description, amount }];

  await env.DB.prepare(
    `INSERT INTO invoices (
      id, display_number, source_ref, wohnung, guest_name, guest_email, guest_address, invoice_date,
      service_start, service_end, items_json, vat_mode, discount_percent,
      raw_net, discount_amount, net, vat_rate, vat_amount, gross, notes, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    newInvoiceId, displayNumber, `booking:${booking.id}`, booking.wohnung, booking.guest_name, booking.guest_email,
    booking.guest_address || '', invoiceDate, booking.check_in, booking.check_out,
    JSON.stringify(items), 'kleinunternehmer', 0,
    amount, 0, amount, 0, 0, amount,
    isDownpayment
      ? `Automatisch erzeugt und an DATEV übermittelt (Anzahlung) am ${invoiceDate}.`
      : `Automatisch erzeugt (Restzahlung) am ${invoiceDate}.`,
    'open'
  ).run();

  const column = isDownpayment ? 'down_payment_invoice_id' : 'remaining_invoice_id';
  await env.DB.prepare(`UPDATE bookings SET ${column} = ? WHERE id = ?`).bind(newInvoiceId, booking.id).run();

  return { invoiceId: newInvoiceId, displayNumber, amount, description, invoiceDate };
}

async function sendDatevInvoiceForLeg(env, booking, leg, companyInfo) {
  const isDownpayment = leg === 'downpayment';
  const { invoiceId: newInvoiceId, displayNumber, amount, description, invoiceDate } = await ensureLegInvoice(env, booking, leg);
  const paidAtDate = isDownpayment ? booking.down_payment_paid_at : booking.remaining_paid_at;
  const datevEmail = await getDatevEmail(env);

  const pdfBytes = await buildDatevInvoicePdf({
    invoiceId: displayNumber,
    guestName: booking.guest_name,
    guestAddress: booking.guest_address,
    wohnung: booking.wohnung,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    description,
    amount,
    invoiceDate,
    paidAtDate,
    companyInfo,
  });
  const base64Pdf = bytesToBase64(pdfBytes);

  await sendMail(env, {
    to: datevEmail,
    from: DATEV_SENDER_EMAIL,
    subject: `Rechnung ${displayNumber} – Greenhouse Market GbR`,
    text:
      `Automatischer DATEV-Beleg-Upload.\n\n` +
      `Rechnung: ${displayNumber}\n` +
      `Buchung: ${booking.id}\n` +
      `Gast: ${booking.guest_name}\n` +
      `Zeitraum: ${booking.check_in} bis ${booking.check_out}\n` +
      `Betrag: ${amount.toFixed(2)} €\n` +
      `Art: ${isDownpayment ? 'Anzahlung' : 'Restzahlung'}\n` +
      (paidAtDate ? `Zahlungseingang: ${new Date(paidAtDate).toLocaleDateString('de-DE')} (relevant für Ist-Versteuerung/Zuordnung zum Wirtschaftsjahr)\n` : ''),
    attachments: [
      {
        content: base64Pdf,
        filename: `${displayNumber}.pdf`,
      },
    ],
  });

  const nowIso = new Date().toISOString();
  const column = isDownpayment ? 'datev_downpayment_sent_at' : 'datev_remaining_sent_at';
  await env.DB.prepare(`UPDATE bookings SET ${column} = ? WHERE id = ?`).bind(nowIso, booking.id).run();

  return displayNumber;
}

// Ermittelt eine einzelne Zahlungs-Position als "fällig für DATEV", sobald der
// SPÄTERE der beiden Zeitpunkte erreicht ist: 3 Tage nach Zahlungseingang,
// oder DATEV_SAFE_TO_SEND_DAYS_BEFORE_CHECKIN Tage vor Anreise (= eigene
// Stornofrist-Grenze). Siehe Kommentarblock oben für die Begründung.
function isLegDueForDatev(booking, leg) {
  const isDownpayment = leg === 'downpayment';
  const paidAt = isDownpayment ? booking.down_payment_paid_at : booking.remaining_paid_at;
  // Sicherheitsfallback für ältere Datensätze ohne Zeitstempel (z. B. vor
  // Einführung dieser Spalte bereits als bezahlt markiert): Datum der
  // Buchungserstellung verwenden, damit sie nicht dauerhaft "hängen bleiben".
  const paidAtStr = paidAt ? paidAt.split(' ')[0].split('T')[0] : (booking.created_at || todayStr()).split(' ')[0];

  const sendAfterPayment = addDaysToDateStr(paidAtStr, DATEV_DAYS_AFTER_PAYMENT_BUFFER);
  const sendAfterCancellationSafe = addDaysToDateStr(booking.check_in, -DATEV_SAFE_TO_SEND_DAYS_BEFORE_CHECKIN);
  const sendDate = sendAfterPayment > sendAfterCancellationSafe ? sendAfterPayment : sendAfterCancellationSafe;

  return todayStr() >= sendDate;
}

// Ermittelt alle fälligen Positionen (Anzahlung/Restzahlung bereits bezahlt,
// Sicherheitsfrist abgelaufen, noch nicht an DATEV gemeldet) und verschickt sie.
// dryRun=true: nur ermitteln, nichts verschicken/verändern (für die Vorschau).
async function runDatevExport(env, dryRun = false) {
  const companyInfo = dryRun ? null : await getCompanyInfo(env);

  const { results: candidateBookings } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE status != 'cancelled'
     AND (
       (down_payment_paid = 1 AND datev_downpayment_sent_at IS NULL)
       OR
       (remaining_paid = 1 AND datev_remaining_sent_at IS NULL)
     )`
  ).all();

  const report = { checkedBookings: candidateBookings.length, sent: [], due: [] };

  for (const b of candidateBookings) {
    const legsToCheck = [];
    if (b.down_payment_paid && b.down_payment > 0 && !b.datev_downpayment_sent_at) legsToCheck.push('downpayment');
    if (b.remaining_paid && b.remaining > 0 && !b.datev_remaining_sent_at) legsToCheck.push('remaining');

    for (const leg of legsToCheck) {
      if (!isLegDueForDatev(b, leg)) continue;
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
//
// Erinnert Gast UND Betreiber (per BCC) per Mail an die noch offene
// Restzahlung — einmal zum Fälligkeitstermin (Standard: 14 Tage vor Anreise,
// passend zur Stornobedingung "< 15 Tage = 100% Stornogebühr") und ein
// weiteres Mal als letzte Erinnerung kurz vor Anreise (Standard: 3 Tage
// vorher). Bereits bezahlte oder stornierte Buchungen werden ausgelassen.
// ---------------------------------------------------------------------------

const REMAINING_DUE_DAYS_BEFORE_CHECKIN = 14;
const REMAINING_FINAL_REMINDER_DAYS_BEFORE_CHECKIN = 3;
const REMINDER_SENDER_EMAIL = 'info@greenhouse-fuerstenberg.de';

// Anzahl ganzer Tage zwischen heute (UTC) und einem 'YYYY-MM-DD'-Datum.
// Positiv = Datum liegt in der Zukunft.
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

  // Erzeugt beim ersten Mal die Restzahlungs-Rechnung (oder holt sie, falls durch
  // eine vorherige Erinnerung bereits angelegt) und hängt sie als PDF an. Die
  // DATEV-Automatik verwendet später dieselbe Rechnungsnummer weiter.
  const { invoiceId, displayNumber, amount, description, invoiceDate } = await ensureLegInvoice(env, booking, 'remaining');
  const pdfBytes = await buildDatevInvoicePdf({
    invoiceId: displayNumber,
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
        filename: `${displayNumber}.pdf`,
      },
    ],
  });

  const column = isFinal ? 'remaining_final_reminder_sent_at' : 'remaining_reminder_sent_at';
  await env.DB.prepare(`UPDATE bookings SET ${column} = ? WHERE id = ?`).bind(new Date().toISOString(), booking.id).run();
}

// dryRun=true: nur ermitteln, was fällig wäre, ohne etwas zu verschicken.
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

    // Falls eine Buchung sehr kurzfristig erstellt wurde (schon im "letzte
    // Erinnerung"-Fenster) wird NUR die finale Erinnerung verschickt, nicht
    // zusätzlich noch die reguläre — sonst kämen an einem Tag zwei Mails.
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
}

// ---------------------------------------------------------------------------
// Automatische Begrüßungsmail
//
// Wird einmalig ca. 5 Tage vor Anreise an den Gast verschickt — mit Anrede
// per Vorname, Check-in-Zeit, Adresse und WLAN-Zugangsdaten. BCC an die
// eigene Adresse, damit ihr seht, dass sie rausgegangen ist.
// ---------------------------------------------------------------------------

const WELCOME_EMAIL_DAYS_BEFORE_CHECKIN = 5;
const WELCOME_EMAIL_SENDER = 'info@greenhouse-fuerstenberg.de';
const PROPERTY_ADDRESS = 'Brandenburger Straße 17, 16798 Fürstenberg/Havel';

// Nimmt den ersten "Wort"-Teil eines vollen Namens als informelle Anrede —
// funktioniert auch bei Doppelnamen mit Bindestrich (z. B. "Carl-August"),
// da nur am ersten LEERZEICHEN getrennt wird, nicht am Bindestrich.
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

const DEFAULT_WELCOME_EMAIL_TEMPLATE = `Hallo {{vorname}},

dein Aufenthalt findet bald statt. Du kannst am {{datum}} ab 15:00 Uhr jederzeit einchecken.

Weißt du schon, wann du ungefähr ankommen wirst?

Hier ist die Adresse:
{{adresse}}

Hier sind die WLAN-Zugangsdaten:
Name: {{wlan_name}}
Passwort: {{wlan_passwort}}

Wenn du Fragen hast, gib mir gern Bescheid.

Liebe Grüße
Lucia und Jan`;

async function getWelcomeEmailTemplate(env) {
  const row = await env.DB.prepare(`SELECT value_json FROM settings WHERE key = 'welcome_email_template'`).first();
  if (!row) return DEFAULT_WELCOME_EMAIL_TEMPLATE;
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed || DEFAULT_WELCOME_EMAIL_TEMPLATE;
  } catch (e) {
    return DEFAULT_WELCOME_EMAIL_TEMPLATE;
  }
}

// Ersetzt die {{platzhalter}} in der (im Admin-Tool editierbaren) Vorlage durch
// die tatsächlichen Werte der jeweiligen Buchung.
function fillWelcomeEmailTemplate(template, { firstName, checkInFormatted, wifiInfo }) {
  return template
    .replaceAll('{{vorname}}', firstName)
    .replaceAll('{{datum}}', checkInFormatted)
    .replaceAll('{{adresse}}', PROPERTY_ADDRESS)
    .replaceAll('{{wlan_name}}', wifiInfo.name)
    .replaceAll('{{wlan_passwort}}', wifiInfo.password || '[bitte in den Einstellungen hinterlegen]');
}

async function sendWelcomeEmail(env, booking, wifiInfo, companyInfo, template) {
  const text = fillWelcomeEmailTemplate(template, {
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

// dryRun=true: nur ermitteln, was fällig wäre, ohne etwas zu verschicken.
async function runWelcomeEmails(env, dryRun = false) {
  const wifiInfo = dryRun ? null : await getWifiInfo(env);
  const companyInfo = dryRun ? null : await getCompanyInfo(env);
  const template = dryRun ? null : await getWelcomeEmailTemplate(env);

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
        await sendWelcomeEmail(env, b, wifiInfo, companyInfo, template);
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
      const manualDatevMatch = path.match(/^\/api\/datev\/send-invoice\/([^/]+)$/);
      if (manualDatevMatch && method === 'POST') {
        const authFail = await requireAuth(request, env);
        if (authFail) return authFail;
        try {
          const invoiceId = await sendInvoiceToDatevManually(env, manualDatevMatch[1]);
          return jsonResponse({ sent: true, invoiceId });
        } catch (err) {
          return errorResponse('DATEV-Versand fehlgeschlagen: ' + err.message, 500);
        }
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

  // Wird automatisch per Cron Trigger ausgeführt (siehe wrangler.jsonc).
  // Es können mehrere Cron-Ausdrücke registriert sein — controller.cron
  // verrät, welcher gerade ausgelöst hat, damit wir hier unterscheiden können.
  async scheduled(controller, env, ctx) {
    // Täglicher DATEV-Export + Restzahlungs-Erinnerungen (neuer Cron, z. B. "0 4 * * *").
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

    // Bestehender wöchentlicher Cron: Löschkonzept + Backup. Löscht/anonymisiert
    // Daten gemäß Löschkonzept. Rechnungen sind davon ausdrücklich NIE
    // betroffen (10 Jahre Pflichtaufbewahrung nach § 147 AO).
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
