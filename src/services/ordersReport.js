// Orders (Sales) Report -- same approach as the other two reports: built and
// formatted by us, same From Date / To Date / Employee ID parameters. One
// row per order line item, with a subtotal row after each order, so it
// reads the same way a real sales order printout would.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const REPORT_TZ = process.env.REPORT_TZ || 'Asia/Karachi';

function fmtDate(s) { const [y, m, d] = s.split('-'); return `${d}-${m}-${y.slice(2)}`; }
function fmtDateTime(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: REPORT_TZ }).replace(/\//g, '-');
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: REPORT_TZ });
  return `${date} ${time}`;
}

async function fetchOrdersReportData(pool, employeeId, from, to) {
  const { rows: userRows } = await pool.query(
    `SELECT id, name, sap_sales_employee_code AS employee_code, manager_name FROM users WHERE id = $1`,
    [employeeId]
  );
  if (userRows.length === 0) return null;
  const u = userRows[0];

  const { rows: orders } = await pool.query(
    `SELECT o.id, o.order_date, o.total_amount, o.sync_status, c.card_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.user_id = $1
        AND (o.order_date AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY o.order_date ASC`,
    [employeeId, from, to, REPORT_TZ]
  );

  const lines = [];
  const totals = { orderCount: orders.length, itemCount: 0, value: 0 };

  for (const o of orders) {
    const { rows: items } = await pool.query(
      `SELECT oi.quantity, oi.unit_price, oi.line_total, COALESCE(i.item_name, 'Unknown Item') AS item_name
         FROM order_items oi LEFT JOIN items i ON i.id = oi.item_id
        WHERE oi.order_id = $1
        ORDER BY oi.id ASC`,
      [o.id]
    );
    items.forEach((it, idx) => {
      lines.push({
        date: idx === 0 ? fmtDateTime(o.order_date) : '',
        customer: idx === 0 ? (o.card_name || 'Unknown Customer') : '',
        item: it.item_name,
        qty: Number(it.quantity) || 0,
        unitPrice: Number(it.unit_price) || 0,
        lineTotal: Number(it.line_total) || 0,
        isOrderTotal: false,
      });
      totals.itemCount += Number(it.quantity) || 0;
    });
    lines.push({
      date: '', customer: '', item: `Order Total (${o.sync_status === 'synced' ? 'Synced to SAP' : 'Pending sync'})`,
      qty: null, unitPrice: null, lineTotal: Number(o.total_amount) || 0, isOrderTotal: true,
    });
    totals.value += Number(o.total_amount) || 0;
  }

  return {
    employee: { code: u.employee_code || String(u.id), name: u.name, manager: u.manager_name || '' },
    from, to, lines, totals, generatedAt: new Date(),
  };
}

const COLS = [
  { key: 'date',      label: 'Date',      w: 78,  xw: 16 },
  { key: 'customer',  label: 'Customer',  w: 130, xw: 26 },
  { key: 'item',      label: 'Item',      w: 150, xw: 30 },
  { key: 'qty',       label: 'Qty',       w: 42,  xw: 8,  num: true, dec: 0 },
  { key: 'unitPrice', label: 'Unit Price', w: 60, xw: 12, num: true, dec: 0 },
  { key: 'lineTotal', label: 'Line Total', w: 66, xw: 13, num: true, dec: 0 },
];
const money = (n, dec = 0) => (n === null || n === undefined) ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec === 0 ? 2 : dec });

async function buildXlsx(data) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders Report', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = COLS.map((c) => ({ width: c.xw }));
  const bold = { bold: true };
  const thin = { style: 'thin', color: { argb: 'FF999999' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
  const totalFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

  ws.mergeCells(1, 1, 1, COLS.length);
  ws.getCell(1, 1).value = 'Orders Report';
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

  if (data.lines.length === 0) {
    ws.mergeCells(r, 1, r, COLS.length);
    const cell = ws.getCell(r, 1);
    cell.value = 'No orders were booked in this period.';
    cell.font = { italic: true, color: { argb: 'FF666666' } };
    cell.border = box;
    r += 1;
  } else {
    for (const line of data.lines) {
      COLS.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = c.num ? (line[c.key] ?? '') : (line[c.key] || '');
        cell.border = box;
        if (line.isOrderTotal) { cell.font = bold; cell.fill = totalFill; }
        if (c.num && line[c.key] !== null) { cell.numFmt = c.dec === 1 ? '#,##0.0' : '#,##0'; cell.alignment = { horizontal: 'right' }; }
      });
      r += 1;
    }
  }

  r += 1;
  ws.getCell(r, 1).value = 'Total Orders'; ws.getCell(r, 1).font = bold;
  ws.getCell(r, 3).value = data.totals.orderCount;
  r += 1;
  ws.getCell(r, 1).value = 'Total Items Sold'; ws.getCell(r, 1).font = bold;
  ws.getCell(r, 3).value = data.totals.itemCount;
  r += 1;
  ws.getCell(r, 1).value = 'Grand Total (Rs)'; ws.getCell(r, 1).font = bold;
  ws.getCell(r, 3).value = data.totals.value;
  ws.getCell(r, 3).numFmt = '#,##0';
  r += 2;
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

    doc.font('Helvetica-Bold').fontSize(15).text('Orders Report', left, 30);

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
    if (data.lines.length === 0) {
      doc.rect(left, y, tableWidth, 24).stroke('#999');
      doc.font('Helvetica-Oblique').fillColor('#555').text('No orders were booked in this period.', left + PAD, y + 8, { width: tableWidth - 2 * PAD });
      doc.fillColor('#000');
      y += 24;
    }

    for (const line of data.lines) {
      const rowH = 16;
      if (y + rowH > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; drawHeader(); }
      let x = left;
      for (const c of COLS) {
        doc.rect(x, y, c.w, rowH).fillAndStroke(line.isOrderTotal ? '#F2F2F2' : '#FFFFFF', '#BBB');
        const val = c.num ? (line[c.key] === null ? '' : money(line[c.key], c.dec)) : (line[c.key] || '');
        doc.fillColor('#000').font(line.isOrderTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS)
          .text(val, x + PAD, y + 4, { width: c.w - 2 * PAD, align: c.num ? 'right' : 'left', lineBreak: false });
        x += c.w;
      }
      y += rowH;
    }

    y += 10;
    if (y + 60 > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; }
    doc.font('Helvetica-Bold').fontSize(9).text('Summary', left, y);
    y += 14;
    [['Total Orders', String(data.totals.orderCount)], ['Total Items Sold', String(data.totals.itemCount)], ['Grand Total (Rs)', money(data.totals.value, 0) || '0']].forEach(([k, v]) => {
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

module.exports = { fetchOrdersReportData, buildXlsx, buildPdf };