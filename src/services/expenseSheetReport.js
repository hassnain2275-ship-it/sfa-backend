// Expense report in the client's Excel-style sheet format:
//   Header: Employee Name | Employee ID | Date | Employee Designation
//   Table : Date | Detail | Visit Start | End Location | Mileage | Rate Per KM | TA/DA | Fuel Allowance | Car Allowance | Total Travel Expense
// Same three functions as the old expenseReport.js, so routes/reports.js needs only a one-line change.
// Old entries (TA/DA stays, outstation, other, absence) are mapped into the same columns, so history still shows.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Karachi';
const TYPE_LABEL = { travel: 'Travel', ta_da: 'TA / DA', outstation: 'Outstation', other: 'Other', absence: 'Absent' };

const fmtDate = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}-${m}-${y}`; };
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

const COLUMNS = [
  { key: 'date', header: 'Date', width: 12 },
  { key: 'detail', header: 'Detail', width: 28 },
  { key: 'start', header: 'Visit Start', width: 20 },
  { key: 'end', header: 'End Location', width: 20 },
  { key: 'km', header: 'Mileage (KM)', width: 12, num: true, dp: 1 },
  { key: 'rate', header: 'Rate Per KM', width: 12, num: true, dp: 2 },
  { key: 'tada', header: 'TA/DA', width: 12, num: true, dp: 2 },
  { key: 'fuel', header: 'Fuel Allowance', width: 14, num: true, dp: 2 },
  { key: 'car', header: 'Car Allowance', width: 14, num: true, dp: 2 },
  { key: 'total', header: 'Total Travel Expense', width: 18, num: true, dp: 2 },
];

async function fetchReportData(pool, employeeId, from, to) {
  const { rows: userRows } = await pool.query('SELECT * FROM users WHERE id = $1', [employeeId]);
  if (userRows.length === 0) return null;
  const u = userRows[0];

  const { rows } = await pool.query(
    `SELECT e.*,
            to_char(COALESCE(e.start_date, (e.expense_date AT TIME ZONE $4)::date), 'YYYY-MM-DD') AS d_start,
            to_char(COALESCE(e.end_date,   (e.expense_date AT TIME ZONE $4)::date), 'YYYY-MM-DD') AS d_end
       FROM expenses e
      WHERE e.user_id = $1
        AND COALESCE(e.start_date, (e.expense_date AT TIME ZONE $4)::date) <= $3::date
        AND COALESCE(e.end_date,   (e.expense_date AT TIME ZONE $4)::date) >= $2::date
      ORDER BY d_start, e.id`,
    [employeeId, from, to, REPORT_TZ]
  );

  const lines = rows.map((e) => {
    const label = TYPE_LABEL[e.expense_type] || e.expense_type;
    let detail = e.detail || '';
    if (!detail) {
      detail = e.category ? `${label} - ${e.category}` : label;
      if (e.expense_type === 'absence') detail = `Absent - ${e.absence_reason || 'Other'}`;
      if (e.remarks && !detail.includes(e.remarks)) detail += ` (${e.remarks})`;
    }
    const isAbsence = e.expense_type === 'absence';
    return {
      date: e.d_start === e.d_end ? fmtDate(e.d_start) : `${fmtDate(e.d_start)} to ${fmtDate(e.d_end)}`,
      detail,
      start: e.from_location || '',
      end: e.to_location || '',
      km: e.km === null ? null : num(e.km),
      rate: e.rate_per_km === null ? null : num(e.rate_per_km),
      tada: e.expense_type === 'travel' || e.expense_type === 'ta_da' ? num(e.ta_amount) + num(e.da_amount) : null,
      fuel: e.fuel_allowance === null || e.fuel_allowance === undefined ? null : num(e.fuel_allowance),
      car: e.car_allowance === null || e.car_allowance === undefined ? null : num(e.car_allowance),
      total: isAbsence ? null : num(e.amount),
    };
  });

  const totals = { km: 0, tada: 0, fuel: 0, car: 0, total: 0 };
  for (const l of lines) for (const k of Object.keys(totals)) totals[k] += num(l[k]);

  return {
    employee: {
      name: u.name,
      id: u.sap_sales_employee_code || u.sap_user_code || String(u.id),
      designation: u.designation || '',
    },
    from, to, lines, totals,
    periodLabel: from === to ? fmtDate(from) : `${fmtDate(from)} to ${fmtDate(to)}`,
  };
}

async function buildXlsx(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Expense Sheet');
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };

  ws.mergeCells('A1:J1');
  ws.getCell('A1').value = 'Employee Expense Sheet';
  ws.getCell('A1').font = { bold: true, size: 14 };

  ws.getCell('A3').value = 'Header Information';
  ws.getCell('A3').font = { bold: true };
  const head = [['Employee Name', data.employee.name], ['Employee ID', data.employee.id],
                ['Date', data.periodLabel], ['Employee Designation', data.employee.designation]];
  head.forEach(([k, v], i) => {
    const r = 4 + i;
    ws.getCell(`A${r}`).value = k; ws.getCell(`A${r}`).font = { bold: true };
    ws.mergeCells(`B${r}:C${r}`); ws.getCell(`B${r}`).value = v;
    ws.getCell(`A${r}`).border = box; ws.getCell(`B${r}`).border = box; ws.getCell(`C${r}`).border = box;
  });

  const hr = 9;
  COLUMNS.forEach((c, i) => {
    const cell = ws.getCell(hr, i + 1);
    cell.value = c.header; cell.font = { bold: true }; cell.border = box;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EEF8' } };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: c.num ? 'right' : 'left' };
  });
  ws.getRow(hr).height = 30;

  let r = hr + 1;
  for (const l of data.lines) {
    COLUMNS.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = l[c.key] === null || l[c.key] === undefined ? '' : l[c.key];
      cell.border = box;
      if (c.num) { cell.numFmt = c.dp === 1 ? '#,##0.0' : '#,##0.00'; cell.alignment = { horizontal: 'right' }; }
    });
    r++;
  }
  const t = r;
  ws.getCell(t, 1).value = 'TOTAL';
  COLUMNS.forEach((c, i) => {
    const cell = ws.getCell(t, i + 1); cell.font = { bold: true }; cell.border = box;
    if (['km', 'tada', 'fuel', 'car', 'total'].includes(c.key)) {
      cell.value = data.totals[c.key]; cell.numFmt = c.key === 'km' ? '#,##0.0' : '#,##0.00'; cell.alignment = { horizontal: 'right' };
    }
  });
  ws.views = [{ state: 'frozen', ySplit: hr }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

    const money = (n, dp = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    doc.fontSize(15).font('Helvetica-Bold').text('Employee Expense Sheet');
    doc.moveDown(0.4).fontSize(9).font('Helvetica');
    doc.text(`Employee Name: ${data.employee.name}      Employee ID: ${data.employee.id}      Date: ${data.periodLabel}      Designation: ${data.employee.designation}`);
    doc.moveDown(0.8);

    const widths = [62, 130, 85, 85, 48, 46, 56, 58, 56, 70];
    const x0 = doc.page.margins.left;
    const rowH = 18;
    const drawRow = (vals, y, bold, fill) => {
      let x = x0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      vals.forEach((v, i) => {
        if (fill) doc.rect(x, y, widths[i], rowH).fillAndStroke('#E7EEF8', '#999999');
        else doc.rect(x, y, widths[i], rowH).stroke('#999999');
        doc.fillColor('black').text(String(v ?? ''), x + 3, y + 5, { width: widths[i] - 6, height: rowH - 6, ellipsis: true, align: COLUMNS[i].num ? 'right' : 'left', lineBreak: false });
        x += widths[i];
      });
    };
    let y = doc.y;
    drawRow(COLUMNS.map((c) => c.header), y, true, true); y += rowH;
    const fmt = (l, c) => (l[c.key] === null || l[c.key] === undefined || l[c.key] === '' ? '' : c.num ? money(l[c.key], c.dp) : l[c.key]);
    for (const l of data.lines) {
      if (y + rowH > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); y = doc.page.margins.top; drawRow(COLUMNS.map((c) => c.header), y, true, true); y += rowH; }
      drawRow(COLUMNS.map((c) => fmt(l, c)), y, false, false); y += rowH;
    }
    drawRow(COLUMNS.map((c) => (c.key === 'date' ? 'TOTAL' : ['km', 'tada', 'fuel', 'car', 'total'].includes(c.key) ? money(data.totals[c.key], c.key === 'km' ? 1 : 2) : '')), y, true, false);
    doc.end();
  });
}

module.exports = { fetchReportData, buildXlsx, buildPdf };
