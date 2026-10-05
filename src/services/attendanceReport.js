// Attendance Report -- same "Crystal Reports equivalent" approach as
// expenseReport.js: built and formatted by us, same From Date / To Date /
// Employee ID parameters, styled with a header block + bordered table.
// Every calendar day in the range gets a row (Present or Absent), matching
// the logic of the office attendance sheet, but scoped to one employee.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Karachi';

function fmtDate(s) {
  const [y, m, d] = s.split('-');
  return `${d}-${m}-${y.slice(2)}`;
}
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: REPORT_TZ,
  });
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchAttendanceReportData(pool, employeeId, from, to) {
  const { rows: userRows } = await pool.query(
    `SELECT id, name, sap_sales_employee_code AS employee_code, manager_name FROM users WHERE id = $1`,
    [employeeId]
  );
  if (userRows.length === 0) return null;
  const u = userRows[0];

  const { rows } = await pool.query(
    `SELECT a.*, c.card_name,
            to_char(a.marked_at AT TIME ZONE $4, 'YYYY-MM-DD') AS d
       FROM attendance a LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.user_id = $1
        AND (a.marked_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY a.marked_at ASC`,
    [employeeId, from, to, REPORT_TZ]
  );
  const byDay = {};
  for (const r of rows) byDay[r.d] = r; // last record of the day wins if there were several

  const lines = [];
  const totals = { present: 0, absent: 0, km: 0, orders: 0 };
  for (let d = from; d <= to; d = addDaysStr(d, 1)) {
    const r = byDay[d];
    const present = !!r && r.status === 'present';
    if (present) totals.present += 1; else totals.absent += 1;
    totals.km += r ? Number(r.km_traveled) || 0 : 0;
    totals.orders += r ? Number(r.orders_count) || 0 : 0;

    lines.push({
      date: fmtDate(d),
      day: new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      status: present ? 'Present' : 'Absent',
      checkIn: r ? fmtTime(r.marked_at) : '',
      checkOut: r ? fmtTime(r.check_out_at) : '',
      customer: r ? (r.card_name || '') : '',
      km: r ? Number(r.km_traveled) || 0 : 0,
      orders: r ? Number(r.orders_count) || 0 : 0,
    });
    if (d === to) break; // avoid infinite loop if from > to
  }

  return {
    employee: { code: u.employee_code || String(u.id), name: u.name, manager: u.manager_name || '' },
    from, to, lines, totals, generatedAt: new Date(),
  };
}

const COLS = [
  { key: 'date',     label: 'Date',        w: 60,  xw: 12 },
  { key: 'day',      label: 'Day',         w: 46,  xw: 8 },
  { key: 'status',   label: 'Status',      w: 60,  xw: 11 },
  { key: 'checkIn',  label: 'Check-In',    w: 60,  xw: 10 },
  { key: 'checkOut', label: 'Check-Out',   w: 60,  xw: 10 },
  { key: 'customer', label: 'Customer Visited', w: 130, xw: 26 },
  { key: 'km',       label: 'KM',          w: 40,  xw: 8, num: true, dec: 1 },
  { key: 'orders',   label: 'Orders',      w: 44,  xw: 8, num: true, dec: 0 },
];
const money = (n, dec = 0) => (n === null || n === undefined || n === 0) ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec === 0 ? 2 : dec });

async function buildXlsx(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance Report', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = COLS.map((c) => ({ width: c.xw }));
  const bold = { bold: true };
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };

  ws.mergeCells(1, 1, 1, COLS.length);
  ws.getCell(1, 1).value = 'Employee Attendance Report';
  ws.getCell(1, 1).font = { bold: true, size: 15 };

  const hdr = [['Emp Id', data.employee.code], ['Emp. Name', data.employee.name], ['Date From', fmtDate(data.from)], ['To Date', fmtDate(data.to)], ['Emp. Manager', data.employee.manager || '-']];
  let r = 3;
  hdr.forEach(([label], i) => { const c = ws.getCell(r, i + 1); c.value = label; c.font = bold; c.fill = headFill; c.border = box; });
  r += 1;
  hdr.forEach(([, val], i) => { const c = ws.getCell(r, i + 1); c.value = val; c.border = box; });
  r += 2;

  const headerRowNum = r;
  COLS.forEach((c, i) => { const cell = ws.getCell(headerRowNum, i + 1); cell.value = c.label; cell.font = bold; cell.fill = headFill; cell.border = box; cell.alignment = { horizontal: c.num ? 'right' : 'left' }; });
  r += 1;
  const first = r;
  for (const line of data.lines) {
    COLS.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = c.num ? (line[c.key] || 0) : (line[c.key] || '');
      cell.border = box;
      if (c.num) { cell.numFmt = c.dec === 1 ? '#,##0.0' : '#,##0'; cell.alignment = { horizontal: 'right' }; }
      if (c.key === 'status') cell.font = { color: { argb: line.status === 'Present' ? 'FF2E7D32' : 'FFC62828' } };
    });
    r += 1;
  }
  const last = r - 1;

  const totalRow = r;
  ws.getCell(totalRow, 1).value = 'TOTAL';
  ws.getCell(totalRow, 1).font = bold; ws.getCell(totalRow, 1).fill = headFill; ws.getCell(totalRow, 1).border = box;
  COLS.forEach((c, i) => {
    const cell = ws.getCell(totalRow, i + 1);
    if (i === 0) return;
    cell.font = bold; cell.fill = headFill; cell.border = box;
    if (c.num) {
      const L = ws.getColumn(i + 1).letter;
      cell.value = data.lines.length ? { formula: `SUM(${L}${first}:${L}${last})`, result: data.totals[c.key] || 0 } : 0;
      cell.numFmt = c.dec === 1 ? '#,##0.0' : '#,##0';
      cell.alignment = { horizontal: 'right' };
    }
  });

  r = totalRow + 2;
  [['Days Present', data.totals.present], ['Days Absent', data.totals.absent], ['Total KM Travelled', data.totals.km]].forEach(([label, val]) => {
    ws.getCell(r, 1).value = label; ws.getCell(r, 1).font = bold;
    ws.getCell(r, 3).value = val;
    r++;
  });
  r++;
  ws.getCell(r, 1).value = `Generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;
    const PAD = 3, FS = 8;
    const tableWidth = COLS.reduce((s, c) => s + c.w, 0);

    doc.font('Helvetica-Bold').fontSize(15).text('Employee Attendance Report', left, 30);

    const hdr = [['Emp Id', data.employee.code], ['Emp. Name', data.employee.name], ['Date From', fmtDate(data.from)], ['To Date', fmtDate(data.to)], ['Emp. Manager', data.employee.manager || '-']];
    const hw = tableWidth / hdr.length;
    let y = 58;
    hdr.forEach(([label, val], i) => {
      const x = left + i * hw;
      doc.rect(x, y, hw, 14).fillAndStroke('#DCE6F1', '#999');
      doc.rect(x, y + 14, hw, 18).stroke('#999');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(8).text(label, x + PAD, y + 4, { width: hw - 2 * PAD, lineBreak: false });
      doc.font('Helvetica').fontSize(9).text(String(val), x + PAD, y + 19, { width: hw - 2 * PAD, lineBreak: false, ellipsis: true });
    });
    y += 46;

    const drawHeader = () => {
      let x = left;
      doc.font('Helvetica-Bold').fontSize(FS);
      for (const c of COLS) {
        doc.rect(x, y, c.w, 16).fillAndStroke('#DCE6F1', '#999');
        doc.fillColor('#000').text(c.label, x + PAD, y + 4, { width: c.w - 2 * PAD, align: c.num ? 'right' : 'left', lineBreak: false });
        x += c.w;
      }
      y += 16;
    };
    drawHeader();

    doc.font('Helvetica').fontSize(FS);
    for (const line of data.lines) {
      const rowH = 16;
      if (y + rowH > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
      let x = left;
      for (const c of COLS) {
        doc.rect(x, y, c.w, rowH).stroke('#BBB');
        const val = c.num ? (c.key === 'km' ? money(line[c.key], 1) : money(line[c.key], 0)) : (line[c.key] || '');
        doc.fillColor(c.key === 'status' ? (line.status === 'Present' ? '#2E7D32' : '#C62828') : '#000')
          .font('Helvetica').fontSize(FS)
          .text(val, x + PAD, y + 4, { width: c.w - 2 * PAD, align: c.num ? 'right' : 'left', lineBreak: false });
        x += c.w;
      }
      doc.fillColor('#000');
      y += rowH;
    }

    if (y + 18 > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
    let x = left;
    for (const c of COLS) {
      doc.rect(x, y, c.w, 18).fillAndStroke('#DCE6F1', '#999');
      let t = '';
      if (c.key === 'date') t = 'TOTAL';
      else if (c.num) t = c.key === 'km' ? money(data.totals.km, 1) : money(data.totals[c.key], 0);
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(FS).text(t, x + PAD, y + 5, { width: c.w - 2 * PAD, align: c.num ? 'right' : 'left', lineBreak: false });
      x += c.w;
    }
    y += 18 + 14;

    if (y + 60 > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; }
    doc.font('Helvetica-Bold').fontSize(9).text('Summary', left, y);
    y += 14;
    [['Days Present', String(data.totals.present)], ['Days Absent', String(data.totals.absent)], ['Total KM Travelled', money(data.totals.km, 1) || '0']].forEach(([k, v]) => {
      doc.font('Helvetica').fontSize(9).text(k, left, y, { width: 160, lineBreak: false });
      doc.font('Helvetica-Bold').text(v, left + 165, y, { width: 100, lineBreak: false });
      y += 13;
    });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const fy = doc.page.height - doc.page.margins.bottom - 12;
      doc.font('Helvetica').fontSize(7).fillColor('#777').text(`Generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, left, fy, { width: 400, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left, fy, { width: tableWidth, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { fetchAttendanceReportData, buildXlsx, buildPdf };