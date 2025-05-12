const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const fs = require('fs-extra');
const path = require('path');
const os = require('os'); // For temporary directory

const app = express();
const port = process.env.PORT || 3000;

// --- Configuration ---
const AIRTABLE_API_BASE_URL = 'https://api.airtable.com/v0';
const AIRTABLE_RATE_LIMIT_DELAY = 220; // ms (Airtable allows ~5 req/sec, be slightly conservative)

// --- Middleware ---
app.use(express.json()); // For parsing application/json
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files for generator UI

// --- Helper Functions ---
function sanitizeColumnName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function mapAirtableTypeToSQLite(airtableType, options) {
    // (Same function as in the Electron main.js example)
    switch (airtableType) {
        case 'singleLineText': case 'multilineText': case 'richText': case 'email':
        case 'url': case 'phoneNumber': case 'singleSelect': case 'multipleSelects':
        case 'formula': case 'rollup':  case 'lookup': case 'singleCollaborator':
        case 'multipleCollaborators': case 'createdBy': case 'lastModifiedBy':
        case 'attachment': case 'barcode': case 'button': case 'externalSyncSource':
        case 'aiText':
            return 'TEXT';
        case 'autonumber': case 'count': case 'rating':
            return 'INTEGER';
        case 'number': case 'currency': case 'percent': case 'duration':
            return options && options.precision > 0 ? 'REAL' : 'INTEGER';
        case 'checkbox':
            return 'INTEGER'; // 0 or 1
        case 'date': case 'dateTime': case 'createdTime': case 'lastModifiedTime':
            return 'TEXT'; // ISO 8601 format
        case 'multipleRecordLinks':
            return 'TEXT';
        default:
            console.warn(`Unknown Airtable type: ${airtableType}. Defaulting to TEXT.`);
            return 'TEXT';
    }
}

function formatValueForSQLite(value, airtableType, airtableOptions) {
    // (Same function as in the Electron main.js example)
    if (value === null || value === undefined) return null;
    switch (airtableType) {
        case 'checkbox': return value ? 1 : 0;
        case 'multipleSelects': case 'multipleCollaborators':
        case 'multipleRecordLinks': case 'attachment':
            return JSON.stringify(value);
        case 'singleCollaborator':
            return typeof value === 'object' ? value.name || value.email || value.id : value;
        case 'date': case 'dateTime': return value;
        case 'number': case 'currency': case 'percent': case 'duration':
            return Number(value);
        default: return value;
    }
}

// --- API Routes ---

// Serve the main generator page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/list-bases', async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey) {
        return res.status(400).json({ message: 'API Key is required.' });
    }
    try {
        const response = await axios.get(`${AIRTABLE_API_BASE_URL}/meta/bases`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        res.json(response.data.bases);
    } catch (error) {
        console.error("Error listing bases:", error.response ? error.response.data : error.message);
        const statusCode = error.response ? error.response.status : 500;
        const message = error.response?.data?.error?.message || 'Failed to fetch bases from Airtable.';
        res.status(statusCode).json({ message });
    }
});

app.post('/api/generate-snapshot', async (req, res) => {
    const { apiKey, baseId, baseName: clientProvidedBaseName } = req.body;
    if (!apiKey || !baseId) {
        return res.status(400).json({ message: 'API Key and Base ID are required.' });
    }

    console.log('\n--- Starting Snapshot Generation ---');
    console.log(`API Key: ${apiKey ? 'Provided' : 'MISSING!'}, Base ID: ${baseId}`);

    let tempDbFilePath = '';
    let sanitizedBaseName = 'AirtableSnapshot'; // Default base name

    try {
        // 1. Fetch Base Schema (Table and Field definitions)
        console.log('[LOG] Fetching base schema...');
        await new Promise(resolve => setTimeout(resolve, AIRTABLE_RATE_LIMIT_DELAY));
        const baseSchemaUrl = `${AIRTABLE_API_BASE_URL}/meta/bases/${baseId}/tables`;
        const baseSchemaResponse = await axios.get(baseSchemaUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const tablesSchema = baseSchemaResponse.data.tables;
        console.log(`[LOG] Fetched schema for ${tablesSchema.length} tables.`);

        // Prioritize client-provided base name
        if (clientProvidedBaseName && clientProvidedBaseName.trim() !== '') {
            sanitizedBaseName = clientProvidedBaseName.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_{2,}/g, '_');
            console.log(`[LOG] Using client-provided base name: '${clientProvidedBaseName}', sanitized to: '${sanitizedBaseName}'`);
        } else if (baseSchemaResponse.data.name) {
            sanitizedBaseName = baseSchemaResponse.data.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_{2,}/g, '_');
            console.log(`[LOG] Using API-fetched base name: '${baseSchemaResponse.data.name}', sanitized to: '${sanitizedBaseName}'`);
        } else {
            console.log(`[LOG] No client-provided or API base name found, using default: '${sanitizedBaseName}'`);
        }

        // --- Aggressive Sanitization --- 
        // Replace dots and hyphens with underscores, then collapse multiple underscores
        sanitizedBaseName = sanitizedBaseName.replace(/[\.\-]/g, '_').replace(/_{2,}/g, '_');

        // Remove trailing underscore (if name is longer than just "_")
        if (sanitizedBaseName.endsWith('_') && sanitizedBaseName.length > 1) {
            sanitizedBaseName = sanitizedBaseName.slice(0, -1);
        }
        // Remove leading underscore (if name is longer than just "_")
        if (sanitizedBaseName.startsWith('_') && sanitizedBaseName.length > 1) {
            sanitizedBaseName = sanitizedBaseName.slice(1);
        }
        // If sanitizedBaseName became empty or is just "_" after aggressive sanitization, revert to default
        if (!sanitizedBaseName || sanitizedBaseName === "_") {
            sanitizedBaseName = 'AirtableSnapshot';
            console.log(`[LOG] Base name became empty/invalid after aggressive sanitization, reverted to default: '${sanitizedBaseName}'`);
        }
        console.log(`[LOG] After aggressive sanitization, base name is: '${sanitizedBaseName}'`);
        // --- End Aggressive Sanitization ---

        // Create a temporary directory for the DB file
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airtable-snapshot-'));
        tempDbFilePath = path.join(tempDir, `${sanitizedBaseName}_${Date.now()}.sqlite`);
        console.log(`[LOG] Temporary DB will be created at: ${tempDbFilePath}`);

        const db = new Database(tempDbFilePath); // verbose: console.log might be useful here for debugging sqlite itself

        // --- Create Metadata Tables ---
        db.exec(`
            CREATE TABLE IF NOT EXISTS _airtable_meta_tables_ (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sqlite_name TEXT NOT NULL,
                primary_field_id TEXT
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS _airtable_meta_fields_v2 (
                id TEXT PRIMARY KEY,
                table_id TEXT NOT NULL,
                name TEXT NOT NULL,
                sqlite_name TEXT NOT NULL,
                type TEXT NOT NULL,
                options_json TEXT, 
                airtable_description TEXT,
                is_primary_key INTEGER,
                FOREIGN KEY (table_id) REFERENCES _airtable_meta_tables_(id)
            );
        `);
        console.log('[LOG] Created metadata tables (_airtable_meta_tables_, _airtable_meta_fields_v2).');
        // --- End Create Metadata Tables ---

        const viewerConfigData = { // This structure will be used to populate metadata tables
            dbFileName: `data/${path.basename(tempDbFilePath)}`, // This specific field might be less relevant if DB is standalone
            tables: []
        };

        // Prepare statements for inserting metadata
        const insertMetaTableStmt = db.prepare(
            `INSERT INTO _airtable_meta_tables_ (id, name, sqlite_name, primary_field_id) VALUES (@id, @name, @sqlite_name, @primary_field_id)`
        );
        const insertMetaFieldStmt = db.prepare(
            `INSERT INTO _airtable_meta_fields_v2 (id, table_id, name, sqlite_name, type, options_json, airtable_description, is_primary_key) VALUES (@id, @table_id, @name, @sqlite_name, @type, @options_json, @airtable_description, @is_primary_key)`
        );

        // Start transaction for metadata insertion
        db.transaction(() => {
            for (const tableSchema of tablesSchema) {
                const sqliteTableName = sanitizeColumnName(tableSchema.name);
                // Insert into _airtable_meta_tables_
                insertMetaTableStmt.run({
                    id: tableSchema.id,
                    name: tableSchema.name,
                    sqlite_name: sqliteTableName,
                    primary_field_id: tableSchema.primaryFieldId || null
                });

                // This part of viewerConfigData is for reference or can be removed if not used later in this function
                const tableConfigEntry = {
                    id: tableSchema.id,
                    name: tableSchema.name,
                    sqliteName: sqliteTableName,
                    fields: []
                };

                // Insert metadata for the 'id' primary key column
                insertMetaFieldStmt.run({
                    id: `synthetic_pk_id_for_${tableSchema.id}`,  // airtable_field_id (synthetic)
                    table_id: tableSchema.id,                             // airtable_table_id
                    name: 'Record ID',                                // airtable_name (display name)
                    sqlite_name: 'id',                                       // sqlite_name (actual column name)
                    type: 'recordId',                                 // airtable_type (custom type for viewer)
                    options_json: null,                                       // options_json
                    airtable_description: 'Airtable Record ID (Primary Key)',         // airtable_description
                    is_primary_key: 1                                           // is_primary_key (true)
                });

                for (const field of tableSchema.fields) {
                    const sqliteColumnName = sanitizeColumnName(field.name);
                    // Insert into _airtable_meta_fields_v2
                    insertMetaFieldStmt.run({
                        id: field.id,
                        table_id: tableSchema.id,
                        name: field.name,
                        sqlite_name: sqliteColumnName,
                        type: field.type,
                        options_json: field.options ? JSON.stringify(field.options) : null,
                        airtable_description: field.description || '',
                        is_primary_key: field.id === tableSchema.primaryFieldId ? 1 : 0
                    });
                    tableConfigEntry.fields.push({
                        id: field.id,
                        name: sqliteColumnName, // In metadata, we should store original name, and sqlite_name as separate
                        originalName: field.name,
                        type: field.type,
                        options: field.options || null
                    });
                }
                viewerConfigData.tables.push(tableConfigEntry); // Still useful for building data tables if logic relies on it
            }
        })();
        console.log('[LOG] Populated metadata tables.');

        // 2. Process each table (for data)
        for (const tableSchema of tablesSchema) {
            console.log(`\n[LOG] Processing table: '${tableSchema.name}' (ID: ${tableSchema.id})`);
            // viewerConfigData.tables.push({ // This logic is now part of metadata population above
            //     id: tableSchema.id,
            //     name: tableSchema.name, // Original name for display
            //     sqliteName: sanitizeColumnName(tableSchema.name), // Sanitized name for DB
            //     fields: tableSchema.fields.map(f => ({
            //         id: f.id,
            //         name: sanitizeColumnName(f.name), // Sanitized name for DB column
            //         originalName: f.name, // Original name for display/logic
            //         type: f.type,
            //         options: f.options || null
            //     }))
            // });

            const sqliteTableName = sanitizeColumnName(tableSchema.name);
            let createTableQuery = `CREATE TABLE IF NOT EXISTS "${sqliteTableName}" (id TEXT PRIMARY KEY`;
            const columnMappings = [{ airtableName: 'id', sqliteName: 'id', airtableType: 'text' }];

            for (const field of tableSchema.fields) {
                const sqliteColumnName = sanitizeColumnName(field.name);
                const sqliteType = mapAirtableTypeToSQLite(field.type, field.options);
                createTableQuery += `, "${sqliteColumnName}" ${sqliteType}`;
                columnMappings.push({ airtableName: field.name, sqliteName: sqliteColumnName, airtableType: field.type, airtableOptions: field.options });
            }
            createTableQuery += ');';
            console.log(`[LOG] CREATE TABLE query for '${sqliteTableName}': ${createTableQuery}`);
            db.exec(createTableQuery);

            // Fetch and Insert Records for the table
            console.log(`[LOG] Fetching records for table '${tableSchema.name}'...`);
            let allRecords = [];
            let offset = null;
            let recordsFetchedThisTable = 0;

            do {
                await new Promise(resolve => setTimeout(resolve, AIRTABLE_RATE_LIMIT_DELAY));
                let recordsUrl = `${AIRTABLE_API_BASE_URL}/${baseId}/${tableSchema.id}`;
                if (offset) {
                    recordsUrl += `?offset=${offset}`;
                }
                console.log(`[LOG] Fetching from URL: ${recordsUrl}`);
                const recordsResponse = await axios.get(recordsUrl, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                const records = recordsResponse.data.records;
                console.log(`[LOG] Fetched ${records.length} records in this batch for table '${tableSchema.name}'.`);
                if (records.length > 0) {
                    allRecords.push(...records);
                    recordsFetchedThisTable += records.length;
                }
                offset = recordsResponse.data.offset;
                if(offset) console.log(`[LOG] Next offset for '${tableSchema.name}': ${offset}`); else console.log(`[LOG] No more records for '${tableSchema.name}'.`);
            } while (offset);
            console.log(`[LOG] Total records fetched for table '${tableSchema.name}': ${recordsFetchedThisTable}`);

            if (allRecords.length === 0) {
                console.log(`[LOG] No records found for table '${tableSchema.name}'. Skipping insertion.`);
                continue;
            }

            console.log(`[DIAGNOSTIC] Table: '${tableSchema.name}', Attempting to prepare INSERT for ${columnMappings.length} columns (parameters).`);

            const insertStmt = db.prepare(`
                INSERT OR IGNORE INTO "${sqliteTableName}" (id, ${columnMappings.slice(1).map(c => `"${c.sqliteName}"`).join(', ')})
                VALUES (@id, ${columnMappings.slice(1).map(c => `@${c.sqliteName}`).join(', ')})
            `);
            console.log(`[LOG] Prepared insert statement for '${sqliteTableName}'. Column mappings:`, JSON.stringify(columnMappings.map(c => c.sqliteName)));

            let successfulInserts = 0;
            let failedInserts = 0;

            const insertMany = db.transaction((records) => {
                for (const i in records) {
                    const record = records[i];
                    const recordToInsert = { id: record.id };
                    for (const mapping of columnMappings.slice(1)) {
                        let val = record.fields[mapping.airtableName];

                        if (val === undefined || val === null) {
                            val = null;
                        } else if (typeof val === 'boolean') {
                            val = val ? 1 : 0; // Convert boolean to 0 or 1
                        } else if (val instanceof Date) {
                            val = val.toISOString(); // Standard format for dates
                        } else if (typeof val === 'object') { // Check for object AFTER boolean and Date
                            // This catches arrays and other JS objects that aren't Dates or Buffers
                            if (!Buffer.isBuffer(val)) { 
                                val = JSON.stringify(val);
                            } else {
                                // If it IS a buffer, better-sqlite3 can handle it directly.
                                // For now, we don't expect direct buffers from Airtable fields treated this way.
                            }
                        } 
                        // Numbers, other strings, null, and Buffers (if any) will pass through
                        recordToInsert[mapping.sqliteName] = val;
                    }

                    if (i === '0') { // Log the first record to be inserted for this table
                        console.log(`[LOG] Sample recordToInsert for '${sqliteTableName}':`, JSON.stringify(recordToInsert, null, 2));
                    }

                    try {
                        const info = insertStmt.run(recordToInsert);
                        if (info.changes > 0) successfulInserts++;
                    } catch (insertError) {
                        failedInserts++;
                        console.error(`[IMPORTANT ERROR] Skipping record due to insert error in table ${sqliteTableName}: ${insertError.message} Record ID: ${record.id} Problematic Data: ${JSON.stringify(record.fields)}`);
                    }
                }
            });

            console.log(`[LOG] Starting batch insert for ${allRecords.length} records into '${sqliteTableName}'...`);
            insertMany(allRecords);
            console.log(`[LOG] Inserted ${successfulInserts} records successfully into '${sqliteTableName}'.`);
            if (failedInserts > 0) {
                console.warn(`[LOG] Failed to insert ${failedInserts} records into '${sqliteTableName}'.`);
            }

            // Create basic indexes
            db.exec(`CREATE INDEX IF NOT EXISTS idx_${sqliteTableName}_pk ON "${sqliteTableName}" (id);`);
        }
        db.close();
        console.log("[LOG] Database closed.");

        const now = new Date(); // Ensure 'now' is defined here for the timestamp
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = now.getDate();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds(); // Added seconds for more uniqueness
        const formattedTimestamp = `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;

        const sqliteFileName = `${sanitizedBaseName}_${formattedTimestamp}.sqlite`;
        const dbFileBuffer = await fs.readFile(tempDbFilePath);

        res.setHeader('Content-Type', 'application/vnd.sqlite3');
        res.setHeader('Content-Disposition', `attachment; filename=${sqliteFileName}`); // Removed quotes around filename
        res.setHeader('Content-Length', dbFileBuffer.length);
        res.send(dbFileBuffer);
        console.log(`[LOG] Sent SQLite file: ${sqliteFileName}`);

    } catch (error) {
        console.error('[ERROR] Detailed error in /api/generate-snapshot:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                message: 'Error generating Airtable snapshot.', 
                error: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    } finally {
        if (tempDbFilePath) {
            try {
                await fs.unlink(tempDbFilePath);
                console.log(`[LOG] Deleted temporary database: ${tempDbFilePath}`);
            } catch (unlinkError) {
                console.error(`[ERROR] Failed to delete temporary database ${tempDbFilePath}:`, unlinkError);
            }
        }
        console.log('[LOG] /api/generate-snapshot processing finished.');
    }
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the application at http://localhost:${port}`);
});