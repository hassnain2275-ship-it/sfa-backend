// Employee Expense Report -- built by us (not SAP Crystal Reports), same three
// parameters the client described: From Date, To Date, Employee.
// Layout follows the paper template the client showed (header block with Emp Id /
// Name / Date From / To Date / Manager, then Date / From / To / Town / Sub Town /
// Area / Comments), with the money columns added between Area and Comments.
//
// Data comes from our own database, which is where the expense entries are
// captured -- so the report works even when the SAP bridge / ngrok is down.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// Calendar days are cut in the business's own timezone, not the server's (the
// server runs in UTC). Karachi is UTC+5, so an entry logged at 1 AM local time
// still lands on the right day.
const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Karachi';

const TYPE_LABEL = {
  travel: 'Travel',
  ta_da: 'TA / DA',
  outstation: 'Outstation',
  other: 'Other',
  absence: 'Absent',
};

// ---------------------------------------------------------------- helpers

const ymd = (s) => s; // dates travel as 'YYYY-MM-DD' strings end to end (no JS Date timezone traps)

// 'YYYY-MM-DD' -> 'DD-MM-YY' (the format used in the client's template)
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d}-${m}-${y.slice(2)}`;
}

function daysBetweenInclusive(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
}

const maxDate = (a, b) => (a > b ? a : b);
const minDate = (a, b) => (a < b ? a : b);

// ------------------------------------------------------------- data query

async function fetchReportData(pool, employeeId, from, to) {
  const { rows: userRows } = await pool.query(
    `SELECT id, name, sap_sales_employee_code AS employee_code, manager_name FROM users WHERE id = $1`,
    [employeeId]
  );
  if (userRows.length === 0) return null;
  const u = userRows[0];

  // An entry belongs in the report if its day (or, for TA/DA and absences, any day
  // in its range) falls inside [from, to].
  const { rows } = await pool.query(
    `SELECT e.*,
            to_char(COALESCE(e.start_date, (e.expense_date AT TIME ZONE $4)::date), 'YYYY-MM-DD') AS d_start,
            to_char(COALESCE(e.end_date,   (e.expense_date AT TIME ZONE $4)::date), 'YYYY-MM-DD') AS d_end
       FROM expenses e
      WHERE e.user_id = $1
        AND COALESCE(e.start_date, (e.expense_date AT TIME ZONE $4)::date) <= $3::date
        AND COALESCE(e.end_date,   (e.expense_date AT TIME ZONE $4)::date) >= $2::date
      ORDER BY d_start, e.expense_date`,
    [employeeId, from, to, REPORT_TZ]
  );

  const lines = [];
  const totals = { km: 0, travel: 0, ta: 0, da: 0, outstation: 0, other: 0, total: 0, absentDays: 0, nights: 0 };

  for (const e of rows) {
    const amount = Number(e.amount) || 0;
    const line = {
      date: fmtDate(e.d_start),
      type: TYPE_LABEL[e.expense_type] || e.expense_type,
      from: e.from_location || '',
      to: e.to_location || '',
      town: e.town || '',
      subTown: e.sub_town || '',
      area: e.area || '',
      km: null, travel: null, ta: null, da: null, outstation: null, other: null, total: null,
      comments: e.remarks || '',
    };

    switch (e.expense_type) {
      case 'travel':
        line.km = Number(e.km) || 0;
        line.travel = amount;
        line.total = amount;
        totals.km += line.km;
        totals.travel += amount;
        break;
      case 'ta_da': {
        line.ta = Number(e.ta_amount) || 0;
        line.da = Number(e.da_amount) || 0;
        line.total = amount;
        const n = e.nights || 0;
        line.type = `TA / DA (${n} night${n === 1 ? '' : 's'})`;
        if (e.d_start !== e.d_end) line.date = `${fmtDate(e.d_start)} to ${fmtDate(e.d_end)}`;
        totals.ta += line.ta;
        totals.da += line.da;
        totals.nights += n;
        break;
      }
      case 'outstation':
        line.outstation = amount;
        line.total = amount;
        if (e.category) line.type = `Outstation - ${e.category}`;
        totals.outstation += amount;
        break;
      case 'other':
        line.other = amount;
        line.total = amount;
        if (e.category) line.type = `Other - ${e.category}`;
        totals.other += amount;
        break;
      case 'absence': {
        // Only the days that fall inside the requested period count toward the total.
        const inRange = daysBetweenInclusive(maxDate(e.d_start, from), minDate(e.d_end, to));
        const whole = daysBetweenInclusive(e.d_start, e.d_end);
        totals.absentDays += inRange;
        line.type = `Absent - ${e.absence_reason || 'Other'}`;
        if (e.d_start !== e.d_end) line.date = `${fmtDate(e.d_start)} to ${fmtDate(e.d_end)}`;
        line.comments = [e.remarks, `${whole} day${whole === 1 ? '' : 's'}`].filter(Boolean).join(' - ');
        break;
      }
      default:
        break;
    }
    if (line.total) totals.total += line.total;
    lines.push(line);
  }

  return {
    employee: {
      id: u.id,
      code: u.employee_code || String(u.id),
      name: u.name,
      manager: u.manager_name || '',
    },
    from: ymd(from),
    to: ymd(to),
    lines,
    totals,
    generatedAt: new Date(),
  };
}

// --------------------------------------------------------------- columns

const COLS = [
  { key: 'date',       label: 'Date',          w: 56,  xw: 20 },
  { key: 'type',       label: 'Type',          w: 62,  xw: 22 },
  { key: 'from',       label: 'From Location', w: 60,  xw: 18 },
  { key: 'to',         label: 'To Location',   w: 60,  xw: 18 },
  { key: 'town',       label: 'Town',          w: 46,  xw: 14 },
  { key: 'subTown',    label: 'Sub Town',      w: 50,  xw: 16 },
  { key: 'area',       label: 'Area',          w: 52,  xw: 18 },
  { key: 'km',         label: 'KM',            w: 30,  xw: 8,  num: true, dec: 1 },
  { key: 'travel',     label: 'Travel',        w: 40,  xw: 11, num: true, dec: 0 },
  { key: 'ta',         label: 'TA',            w: 36,  xw: 10, num: true, dec: 0 },
  { key: 'da',         label: 'DA',            w: 36,  xw: 10, num: true, dec: 0 },
  { key: 'outstation', label: 'Outstation',    w: 44,  xw: 11, num: true, dec: 0 },
  { key: 'other',      label: 'Other',         w: 36,  xw: 10, num: true, dec: 0 },
  { key: 'total',      label: 'Total',         w: 46,  xw: 12, num: true, dec: 0 },
  { key: 'comments',   label: 'Comments',      w: 128, xw: 34 },
];

const money = (n, dec = 0) =>
  n === null || n === undefined || n === 0
    ? ''
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec === 0 ? 2 : dec });

// ------------------------------------------------------------------ Excel

async function buildXlsx(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SFA Mobile';
  wb.created = data.generatedAt;
  const ws = wb.addWorksheet('Expense Report', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = COLS.map((c) => ({ width: c.xw }));

  const bold = { bold: true };
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };

  // ---- title
  ws.mergeCells(1, 1, 1, COLS.length);
  ws.getCell(1, 1).value = 'Employee Expense Report';
  ws.getCell(1, 1).font = { bold: true, size: 15 };

  // ---- header block: Emp Id / Emp Name / Date From / To Date / Emp Manager
  const hdr = [
    ['Emp Id', data.employee.code],
    ['Emp. Name', data.employee.name],
    ['Date From', fmtDate(data.from)],
    ['To Date', fmtDate(data.to)],
    ['Emp. Manager', data.employee.manager || '-'],
  ];
  let r = 3;
  hdr.forEach(([label], i) => {
    const cell = ws.getCell(r, i * 3 + 1);
    ws.mergeCells(r, i * 3 + 1, r, i * 3 + 2);
    cell.value = label;
    cell.font = bold;
    cell.fill = headFill;
    cell.border = box;
  });
  r += 1;
  hdr.forEach(([, val], i) => {
    const cell = ws.getCell(r, i * 3 + 1);
    ws.mergeCells(r, i * 3 + 1, r, i * 3 + 2);
    cell.value = val;
    cell.border = box;
  });
  r += 2;

  // ---- table header
  const headerRowNum = r;
  COLS.forEach((c, i) => {
    const cell = ws.getCell(headerRowNum, i + 1);
    cell.value = c.label;
    cell.font = bold;
    cell.fill = headFill;
    cell.border = box;
    cell.alignment = { horizontal: c.num ? 'right' : 'left', vertical: 'middle' };
  });
  r += 1;

  const first = r;
  if (data.lines.length === 0) {
    ws.mergeCells(r, 1, r, COLS.length);
    const cell = ws.getCell(r, 1);
    cell.value = 'No expense entries were recorded in this period.';
    cell.font = { italic: true, color: { argb: 'FF666666' } };
    cell.border = box;
    r += 1;
  } else {
    for (const line of data.lines) {
      COLS.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = c.num ? (line[c.key] || 0) : (line[c.key] || '');
        cell.border = box;
        if (c.num) {
          cell.numFmt = c.dec === 1 ? '#,##0.0' : '#,##0';
          cell.alignment = { horizontal: 'right' };
        } else {
          cell.alignment = { wrapText: true, vertical: 'top' };
        }
      });
      r += 1;
    }
  }
  const last = r - 1;

  // Totals row: live SUM formulas, so it stays correct if someone edits a row.
  const totalRow = r;
  ws.getCell(totalRow, 1).value = 'TOTAL';
  COLS.forEach((c, i) => {
    const cell = ws.getCell(totalRow, i + 1);
    cell.font = bold; cell.fill = headFill; cell.border = box;
    if (c.num) {
      const L = ws.getColumn(i + 1).letter;
      const result = data.totals[c.key] || 0;
      cell.value = data.lines.length
        ? { formula: `SUM(${L}${first}:${L}${last})`, result }
        : 0;
      cell.numFmt = c.dec === 1 ? '#,##0.0' : '#,##0';
      cell.alignment = { horizontal: 'right' };
    }
  });

  r = totalRow + 2;
  const summary = [
    ['Days absent in period', data.totals.absentDays],
    ['Overnight stays (nights)', data.totals.nights],
    ['Total claimed (Rs)', data.totals.total],
  ];
  for (const [label, val] of summary) {
    ws.mergeCells(r, 1, r, 3);
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = bold;
    ws.getCell(r, 4).value = val;
    ws.getCell(r, 4).numFmt = '#,##0';
    ws.getCell(r, 4).alignment = { horizontal: 'left' };
    r++;
  }
  r++;
  ws.getCell(r, 1).value = `Generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Amounts in Rs.`;
  ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// -------------------------------------------------------------------- PDF

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    // Leaves room for the footer AND stays clear of the bottom-margin boundary
    // itself, which PDFKit treats as an overflow trigger for any text drawn on it.
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;
    const PAD = 3;
    const FS = 7;

    // ---- title + header block
    doc.font('Helvetica-Bold').fontSize(15).text('Employee Expense Report', left, 30);
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text('Amounts in Rs', left, 34, { align: 'right', width: 782 });
    doc.fillColor('#000');

    const hdr = [
      ['Emp Id', data.employee.code],
      ['Emp. Name', data.employee.name],
      ['Date From', fmtDate(data.from)],
      ['To Date', fmtDate(data.to)],
      ['Emp. Manager', data.employee.manager || '-'],
    ];
    const hw = 782 / hdr.length;
    let y = 58;
    hdr.forEach(([label, val], i) => {
      const x = left + i * hw;
      doc.rect(x, y, hw, 14).fillAndStroke('#DCE6F1', '#999');
      doc.rect(x, y + 14, hw, 18).stroke('#999');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(8).text(label, x + PAD, y + 4, { width: hw - 2 * PAD, lineBreak: false });
      doc.font('Helvetica').fontSize(9).text(String(val), x + PAD, y + 19, { width: hw - 2 * PAD, lineBreak: false, ellipsis: true });
    });
    y += 46;

    // ---- table
    const drawHeader = () => {
      let x = left;
      doc.font('Helvetica-Bold').fontSize(FS);
      for (const c of COLS) {
        doc.rect(x, y, c.w, 16).fillAndStroke('#DCE6F1', '#999');
        doc.fillColor('#000').text(c.label, x + PAD, y + 5, {
          width: c.w - 2 * PAD, align: c.num ? 'right' : 'left', lineBreak: false,
        });
        x += c.w;
      }
      y += 16;
    };
    drawHeader();

    const cellText = (c, line) => {
      const v = line[c.key];
      if (c.num) return c.key === 'km' ? money(v, 1) : money(v, 0);
      return v || '';
    };

    doc.font('Helvetica').fontSize(FS);
    if (data.lines.length === 0) {
      doc.rect(left, y, 782, 24).stroke('#999');
      doc.font('Helvetica-Oblique').fillColor('#555')
        .text('No expense entries were recorded in this period.', left + PAD, y + 8, { width: 782 - 2 * PAD });
      doc.fillColor('#000');
      y += 24;
    }

    for (const line of data.lines) {
      doc.font('Helvetica').fontSize(FS);
      const heights = COLS.map((c) => doc.heightOfString(cellText(c, line) || ' ', { width: c.w - 2 * PAD }));
      const rowH = Math.max(...heights) + 2 * PAD;

      if (y + rowH > bottomLimit()) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }

      let x = left;
      for (const c of COLS) {
        doc.rect(x, y, c.w, rowH).stroke('#BBB');
        doc.fillColor('#000').font('Helvetica').fontSize(FS)
          .text(cellText(c, line), x + PAD, y + PAD, { width: c.w - 2 * PAD, align: c.num ? 'right' : 'left' });
        x += c.w;
      }
      y += rowH;
    }

    // ---- totals row
    if (y + 20 > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
    let x = left;
    for (const c of COLS) {
      doc.rect(x, y, c.w, 18).fillAndStroke('#DCE6F1', '#999');
      let t = '';
      if (c.key === 'date') t = 'TOTAL';
      else if (c.num) t = c.key === 'km' ? money(data.totals.km, 1) : money(data.totals[c.key], 0);
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(FS)
        .text(t, x + PAD, y + 6, { width: c.w - 2 * PAD, align: c.num ? 'right' : 'left', lineBreak: false });
      x += c.w;
    }
    y += 18 + 14;

    // ---- summary + sign-off (kept together on one page)
    if (y + 90 > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; }
    doc.font('Helvetica-Bold').fontSize(9).text('Summary', left, y);
    y += 14;
    const summary = [
      ['Days absent in period', String(data.totals.absentDays)],
      ['Overnight stays (nights)', String(data.totals.nights)],
      ['Total claimed (Rs)', money(data.totals.total, 0) || '0'],
    ];
    for (const [k, v] of summary) {
      doc.font('Helvetica').fontSize(9).text(k, left, y, { width: 160, lineBreak: false });
      doc.font('Helvetica-Bold').text(v, left + 165, y, { width: 100, lineBreak: false });
      y += 13;
    }
    y += 22;
    const sigW = 200;
    ['Employee signature', 'Manager approval'].forEach((label, i) => {
      const sx = left + i * (sigW + 60);
      doc.moveTo(sx, y).lineTo(sx + sigW, y).stroke('#666');
      doc.font('Helvetica').fontSize(8).fillColor('#444').text(label, sx, y + 3, { width: sigW, lineBreak: false });
    });
    doc.fillColor('#000');

    // ---- footer on every page
    // Placing text exactly at the bottom margin boundary makes PDFKit think the
    // line overflows the page and silently insert a fresh blank page to hold it,
    // even with lineBreak:false. Keeping fy comfortably above that boundary
    // (margins.bottom is 30) avoids that trap.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const fy = doc.page.height - doc.page.margins.bottom - 12;
      doc.font('Helvetica').fontSize(7).fillColor('#777')
        .text(`Generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, left, fy, { width: 400, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left, fy, { width: 782, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { fetchReportData, buildXlsx, buildPdf };