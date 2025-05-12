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
        default: return String(value); // Ensure everything else is a string if not null
    }
}

function getDeDuplicatedColumnMappings(airtableFields, tableSchemaPrimaryFieldId, existingPKSqliteName = 'id') {
    const mappings = [];
    const usedSQLiteNames = new Set([existingPKSqliteName.toLowerCase()]);

    for (const field of airtableFields) {
        let sqliteColumnName = sanitizeColumnName(field.name);
        let baseNameForSuffixing = sqliteColumnName;

        if (sqliteColumnName.toLowerCase() === existingPKSqliteName.toLowerCase() || usedSQLiteNames.has(sqliteColumnName.toLowerCase())) {
            if (sqliteColumnName.toLowerCase() === existingPKSqliteName.toLowerCase()) {
                baseNameForSuffixing = existingPKSqliteName;
            }
            let suffix = 1;
            let newNameTry = `${baseNameForSuffixing}_${suffix}`;
            while (usedSQLiteNames.has(newNameTry.toLowerCase())) {
                suffix++;
                newNameTry = `${baseNameForSuffixing}_${suffix}`;
            }
            sqliteColumnName = newNameTry;
        }
        usedSQLiteNames.add(sqliteColumnName.toLowerCase());
        mappings.push({
            airtableFieldId: field.id,
            airtableName: field.name,
            airtableType: field.type,
            airtableOptions: field.options,
            airtableDescription: field.description,
            sqliteName: sqliteColumnName, // Final, de-duplicated name
            isAirtablePrimaryField: field.id === tableSchemaPrimaryFieldId
        });
    }
    return mappings;
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
            CREATE TABLE IF NOT EXISTS _airtable_meta_tables (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sqlite_name TEXT NOT NULL,
                primary_field_id TEXT
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS _airtable_meta_fields (
                id TEXT PRIMARY KEY,              -- Airtable Field ID
                table_id TEXT NOT NULL,           -- Airtable Table ID (references _airtable_meta_tables.id)
                name TEXT NOT NULL,               -- Original Airtable field name
                sqlite_name TEXT NOT NULL,        -- Sanitized SQLite column name
                type TEXT NOT NULL,               -- Airtable field type
                options_json TEXT,                -- JSON string of field options (e.g., for select, linkedRecord)
                airtable_description TEXT,        -- Airtable field description
                is_primary_key INTEGER DEFAULT 0, -- Boolean (0 or 1), for the synthetic 'id' PK column
                FOREIGN KEY (table_id) REFERENCES _airtable_meta_tables(id)
            );
        `);
        console.log('[LOG] Created metadata tables (_airtable_meta_tables, _airtable_meta_fields).');
        // --- End Create Metadata Tables ---

        const viewerConfigData = { // This structure will be used to populate metadata tables
            dbFileName: `data/${path.basename(tempDbFilePath)}`, // This specific field might be less relevant if DB is standalone
            tables: []
        };

        // Prepare statements for inserting metadata
        const insertMetaTableStmt = db.prepare(
            `INSERT INTO _airtable_meta_tables (id, name, sqlite_name, primary_field_id) VALUES (@id, @name, @sqlite_name, @primary_field_id)`
        );
        const insertMetaFieldStmt = db.prepare(
            `INSERT INTO _airtable_meta_fields (id, table_id, name, sqlite_name, type, options_json, airtable_description, is_primary_key) VALUES (@id, @table_id, @name, @sqlite_name, @type, @options_json, @airtable_description, @is_primary_key)`
        );

        // Start transaction for metadata insertion
        db.transaction(() => {
            for (const tableSchema of tablesSchema) {
                const sqliteTableName = sanitizeColumnName(tableSchema.name);
                insertMetaTableStmt.run({
                    id: tableSchema.id,
                    name: tableSchema.name,
                    sqlite_name: sqliteTableName,
                    primary_field_id: tableSchema.primaryFieldId || null
                });

                const tableConfigEntry = {
                    id: tableSchema.id,
                    name: tableSchema.name,
                    sqliteName: sqliteTableName,
                    fields: [],
                    primaryFieldId: tableSchema.primaryFieldId
                };

                // Insert metadata for the 'id' primary key column (represents Airtable Record ID)
                insertMetaFieldStmt.run({
                    id: `synthetic_pk_id_for_${tableSchema.id}`,
                    table_id: tableSchema.id,
                    name: 'Record ID', // Display name for the PK
                    sqlite_name: 'id', // Actual SQLite column name for the PK
                    type: 'id', // Synthetic type
                    options_json: null,
                    airtable_description: 'Airtable Record ID (Primary Key)',
                    is_primary_key: 1
                });

                // Get de-duplicated column mappings for user fields
                const finalFieldMappings = getDeDuplicatedColumnMappings(tableSchema.fields, tableSchema.primaryFieldId, 'id');

                for (const mapping of finalFieldMappings) {
                    // Insert into _airtable_meta_fields with de-duplicated name
                    insertMetaFieldStmt.run({
                        id: mapping.airtableFieldId,
                        table_id: tableSchema.id,
                        name: mapping.airtableName, // Original Airtable field name
                        sqlite_name: mapping.sqliteName, // De-duplicated SQLite name
                        type: mapping.airtableType,
                        options_json: mapping.airtableOptions ? JSON.stringify(mapping.airtableOptions) : null,
                        airtable_description: mapping.airtableDescription || null,
                        is_primary_key: 0 // User fields are not the synthetic PK
                    });

                    // Populate tableConfigEntry.fields for viewerConfigData with de-duplicated names
                    tableConfigEntry.fields.push({
                        id: mapping.airtableFieldId,
                        name: mapping.airtableName, // Original Airtable field name for display
                        sqliteName: mapping.sqliteName, // De-duplicated SQLite name for querying
                        type: mapping.airtableType,
                        options: mapping.airtableOptions || null,
                        description: mapping.airtableDescription || null,
                        isAirtablePrimary: mapping.isAirtablePrimaryField
                    });
                }
                viewerConfigData.tables.push(tableConfigEntry);
            }
        })();
        console.log('[LOG] Populated metadata tables and prepared viewerConfigData.');

        // 2. Process each table (for data)
        for (const tableSchema of tablesSchema) {
            console.log(`\n[LOG] Processing table: '${tableSchema.name}' (ID: ${tableSchema.id})`);
            
            const sqliteTableName = sanitizeColumnName(tableSchema.name);
            // Retrieve the de-duplicated field configurations from viewerConfigData
            const tableViewerConfig = viewerConfigData.tables.find(t => t.id === tableSchema.id);
            if (!tableViewerConfig) {
                console.error(`[CRITICAL] No viewerConfigData entry for table ${tableSchema.name} (${tableSchema.id}). Skipping table creation.`);
                continue; 
            }

            let createTableQuery = `CREATE TABLE IF NOT EXISTS "${sqliteTableName}" (id TEXT PRIMARY KEY`;
            const fieldDefinitionsForCreateTable = [];
            // This columnMappings is for the data insertion step, ensuring it uses the same names as table creation
            const columnMappingsForInsert = [{ airtableName: 'id', sqliteName: 'id', airtableType: 'text', airtableOptions: null }]; 

            for (const fieldConfig of tableViewerConfig.fields) {
                // fieldConfig.sqliteName is already de-duplicated
                // fieldConfig.type is airtableType
                const sqliteType = mapAirtableTypeToSQLite(fieldConfig.type, fieldConfig.options);
                fieldDefinitionsForCreateTable.push(`"${fieldConfig.sqliteName}" ${sqliteType}`);
                columnMappingsForInsert.push({
                    airtableName: fieldConfig.name, // Original Airtable name, for matching with fetched data
                    sqliteName: fieldConfig.sqliteName, // De-duplicated SQLite name
                    airtableType: fieldConfig.type,
                    airtableOptions: fieldConfig.options
                });
            }

            if (fieldDefinitionsForCreateTable.length > 0) {
                createTableQuery += `, ${fieldDefinitionsForCreateTable.join(', ')}`;
            }
            createTableQuery += ');';

            console.log(`[LOG] CREATE TABLE statement for '${sqliteTableName}': ${createTableQuery}`);
            db.exec(createTableQuery);

            // Fetch all records for this table
            console.log(`[LOG] Fetching records for table '${tableSchema.name}'...`);
            let allRecords = [];
            let offset = null;
            do {
                await new Promise(resolve => setTimeout(resolve, AIRTABLE_RATE_LIMIT_DELAY));
                const airtableApiUrl = `${AIRTABLE_API_BASE_URL}/${baseId}/${tableSchema.id}`;
                const response = await axios.get(airtableApiUrl, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    params: { offset: offset }
                });
                allRecords = allRecords.concat(response.data.records);
                offset = response.data.offset;
            } while (offset);
            console.log(`[LOG] Fetched ${allRecords.length} records for table '${tableSchema.name}'.`);

            if (allRecords.length === 0) {
                console.log(`[LOG] No records to insert for table '${sqliteTableName}'.`);
                continue;
            }

            // Prepare insert statement dynamically based on de-duplicated column names
            const insertColumnNames = columnMappingsForInsert.map(m => `"${m.sqliteName}"`).join(', ');
            const insertPlaceholders = columnMappingsForInsert.map(() => '?').join(', ');
            const insertSql = `INSERT INTO "${sqliteTableName}" (${insertColumnNames}) VALUES (${insertPlaceholders})`;
            console.log(`[LOG] Insert SQL for ${sqliteTableName}: ${insertSql}`)
            const insertStmt = db.prepare(insertSql);

            let successfulInserts = 0;
            let failedInserts = 0;

            // Batch insert records
            const insertMany = db.transaction((records) => {
                for (const record of records) {
                    const valuesToInsert = columnMappingsForInsert.map(mapping => {
                        if (mapping.sqliteName === 'id') {
                            return record.id; // Airtable Record ID for our 'id' PK column
                        }
                        // For other columns, use mapping.airtableName (original) to find data in record.fields
                        const rawValue = record.fields[mapping.airtableName];
                        return formatValueForSQLite(rawValue, mapping.airtableType, mapping.airtableOptions);
                    });

                    try {
                        const info = insertStmt.run(valuesToInsert);
                        if (info.changes > 0) successfulInserts++;
                    } catch (insertError) {
                        failedInserts++;
                        console.error(`[IMPORTANT ERROR] Skipping record due to insert error in table ${sqliteTableName}: ${insertError.message} Record ID: ${record.id} Problematic Data: ${JSON.stringify(record.fields)} Raw values for insert: ${JSON.stringify(valuesToInsert)}`);
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