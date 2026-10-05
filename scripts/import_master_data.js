// One-time import: pulls real customers (OCRD) and items (OITM) from the
// restored SAP backup (local SQL Server) into your Postgres customers/items tables.
//
// This is READ-ONLY against SQL Server -- it never writes anything back to SAP's
 

require('dotenv').config();
const sql = require('mssql');
const pool = require('../src/db'); // your existing Postgres pool

const sqlServerConfig = {
  server: 'localhost',
  port: 14330, // moved off 1433 to avoid a port conflict with another SQL instance
  database: 'RBQ',
  user: 'sfa_import',
  password: 'ComsaT1122', // match whatever you set for this login
  options: {
    trustServerCertificate: true,
    encrypt: false,
  },
};

async function importCustomers(sqlPool) {
  // CardType = 'C' -> actual customers (not vendors/leads).
  // Skip rows with no name, just in case.
  const result = await sqlPool.request().query(`
    SELECT CardCode, CardName, Address
    FROM OCRD
    WHERE CardType = 'C' AND CardName IS NOT NULL
  `);

  let count = 0;
  for (const row of result.recordset) {
    await pool.query(
      `INSERT INTO customers (card_code, card_name, address, last_synced_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (card_code) DO UPDATE
       SET card_name = EXCLUDED.card_name, address = EXCLUDED.address, last_synced_at = NOW()`,
      [row.CardCode.trim(), row.CardName.trim(), row.Address ? row.Address.trim() : null]
    );
    count++;
  }
  console.log(`Imported ${count} customers.`);
  return count;
}

async function importItems(sqlPool) {
  // SellItem = 'Y' -> only items that are actually sellable (skips raw materials, service-only items etc.)
  // Joined against ITM1 (PriceList = 1) to pull the real sales price -- confirmed via
  // query that Price List 1 is the one actually populated with prices in this database.
  const result = await sqlPool.request().query(`
    SELECT i.ItemCode, i.ItemName, p.Price
    FROM OITM i
    LEFT JOIN ITM1 p ON p.ItemCode = i.ItemCode AND p.PriceList = 1
    WHERE i.SellItem = 'Y' AND i.ItemName IS NOT NULL
  `);

  let count = 0;
  for (const row of result.recordset) {
    await pool.query(
      `INSERT INTO items (item_code, item_name, price, last_synced_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (item_code) DO UPDATE
       SET item_name = EXCLUDED.item_name, price = EXCLUDED.price, last_synced_at = NOW()`,
      [row.ItemCode.trim(), row.ItemName.trim(), row.Price || 0]
    );
    count++;
  }
  console.log(`Imported ${count} items with real prices from Price List 1.`);
  return count;
}

async function run() {
  console.log('Connecting to SQL Server (RBQ)...');
  const sqlPool = await sql.connect(sqlServerConfig);

  try {
    await importCustomers(sqlPool);
    await importItems(sqlPool);
    console.log('Done. Check your Postgres customers/items tables.');
  } finally {
    await sqlPool.close();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});