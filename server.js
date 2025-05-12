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
    // Allow alphanumeric and underscore, replace others with underscore, collapse multiple underscores
    let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_{2,}/g, '_');
    // Remove leading/trailing underscores if the name isn't just underscores
    if (sanitized.length > 1) {
        sanitized = sanitized.replace(/^_+|_+$/g, '');
    }
    // Handle potential empty string after sanitization (e.g., if input was just '-')
    if (!sanitized) {
        return '_invalid_name_';
    }
    return sanitized;
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

function generateJunctionTableName(sourceTableSqliteName, fieldSqliteName) {
    return `_link_${sourceTableSqliteName}_${fieldSqliteName}`;
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
                table_id TEXT NOT NULL,           -- Foreign key to _airtable_meta_tables
                name TEXT NOT NULL,               -- Original Airtable field name
                sqlite_name TEXT NOT NULL,        -- De-duplicated SQLite column name (for non-link fields)
                type TEXT NOT NULL,               -- Airtable field type
                options_json TEXT,                -- JSON string of field options (e.g., for select, linkedRecord)
                airtable_description TEXT,        -- Airtable field description
                is_primary_key INTEGER DEFAULT 0, -- Boolean (0 or 1), for the synthetic 'id' PK column
                junction_table_name TEXT,         -- Name of the junction table if type is 'multipleRecordLinks'
                FOREIGN KEY (table_id) REFERENCES _airtable_meta_tables(id)
            );
        `);
        console.log('[LOG] Created/verified metadata tables (_airtable_meta_tables, _airtable_meta_fields).');
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
            `INSERT INTO _airtable_meta_fields (id, table_id, name, sqlite_name, type, options_json, airtable_description, is_primary_key, junction_table_name) VALUES (@id, @table_id, @name, @sqlite_name, @type, @options_json, @airtable_description, @is_primary_key, @junction_table_name)`
        );

        // Structure to hold info about junction tables needed
        const junctionTablesToCreate = [];

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
                    is_primary_key: 1,
                    junction_table_name: null // PK is never a junction table
                });

                // Get de-duplicated column mappings for user fields
                // IMPORTANT: This mapping now includes fields that WON'T become direct columns (like multipleRecordLinks)
                // but we need their final SQLite name for generating junction table names correctly.
                const finalFieldMappings = getDeDuplicatedColumnMappings(tableSchema.fields, tableSchema.primaryFieldId, 'id');

                for (const mapping of finalFieldMappings) {
                    let junctionTableName = null;
                    // Generate junction table info if it's a link field
                    if (mapping.airtableType === 'multipleRecordLinks') {
                        junctionTableName = generateJunctionTableName(sqliteTableName, mapping.sqliteName);
                        junctionTablesToCreate.push({
                            name: junctionTableName,
                            sourceTableSqliteName: sqliteTableName,
                            fieldSqliteName: mapping.sqliteName, // Store the sanitized field name too
                            linkedTableId: mapping.airtableOptions?.linkedTableId // Store linked table Airtable ID
                        });
                    }

                    // Insert into _airtable_meta_fields with de-duplicated name AND junction table name if applicable
                    insertMetaFieldStmt.run({
                        id: mapping.airtableFieldId,
                        table_id: tableSchema.id,
                        name: mapping.airtableName, // Original Airtable field name
                        sqlite_name: mapping.sqliteName, // De-duplicated SQLite name (used for junction name generation)
                        type: mapping.airtableType,
                        options_json: mapping.airtableOptions ? JSON.stringify(mapping.airtableOptions) : null,
                        airtable_description: mapping.airtableDescription || null,
                        is_primary_key: 0, // User fields are never the synthetic PK
                        junction_table_name: junctionTableName // Store junction table name here
                    });

                    // Add field info to viewerConfigData
                    const fieldConfig = {
                        id: mapping.airtableFieldId,
                        name: mapping.airtableName, // Original Airtable field name for display
                        sqliteName: mapping.sqliteName, // De-duplicated SQLite name (relevant for non-links or junction naming)
                        type: mapping.airtableType,
                        options: mapping.airtableOptions || null,
                        description: mapping.airtableDescription || null,
                        isAirtablePrimary: mapping.isAirtablePrimaryField
                    };
                    // Add junction table info to viewer config if applicable
                    if (junctionTableName) {
                        fieldConfig.junctionTable = junctionTableName;
                        fieldConfig.sourceColumn = 'source_id'; // Standardize junction column names
                        fieldConfig.targetColumn = 'target_id';
                        // linkedTableId is already in options, but could be duplicated for easier access
                        // fieldConfig.linkedTableId = mapping.airtableOptions?.linkedTableId;
                    }
                    tableConfigEntry.fields.push(fieldConfig);
                }
                viewerConfigData.tables.push(tableConfigEntry);
            }
        })();
        console.log('[LOG] Populated metadata tables and prepared viewerConfigData.');

        // 2. Create ACTUAL Data Tables (Main + Junction)
        // A map to store prepared statements for junction table inserts, keyed by junction table name
        const junctionInsertStmts = {};

        db.transaction(() => {
            // First create all main tables
            for (const tableSchema of tablesSchema) {
                console.log(`\n[LOG] Defining schema for table: '${tableSchema.name}' (ID: ${tableSchema.id})`);

                const sqliteTableName = sanitizeColumnName(tableSchema.name);
                // Find the corresponding viewer config entry which now contains final field mappings
                const tableViewerConfig = viewerConfigData.tables.find(t => t.id === tableSchema.id);
                if (!tableViewerConfig) {
                    console.error(`[CRITICAL] No viewerConfigData entry for table ${tableSchema.name} (${tableSchema.id}). Skipping table creation.`);
                    continue;
                }

                let createTableQuery = `CREATE TABLE IF NOT EXISTS "${sqliteTableName}" (id TEXT PRIMARY KEY`;
                const fieldDefinitionsForCreateTable = [];

                // Iterate through the fields DEFINED FOR THE VIEWER CONFIG for this table
                for (const fieldConfig of tableViewerConfig.fields) {
                    // *** Only add column definition if it's NOT a linked record field ***
                    if (fieldConfig.type !== 'multipleRecordLinks') {
                        const sqliteType = mapAirtableTypeToSQLite(fieldConfig.type, fieldConfig.options);
                        // fieldConfig.sqliteName is the de-duplicated name
                        fieldDefinitionsForCreateTable.push(`"${fieldConfig.sqliteName}" ${sqliteType}`);
                    }
                }

                if (fieldDefinitionsForCreateTable.length > 0) {
                    createTableQuery += `, ${fieldDefinitionsForCreateTable.join(', ')}`;
                }
                createTableQuery += ');';

                console.log(`[LOG] CREATE TABLE statement for main table '${sqliteTableName}': ${createTableQuery}`);
                db.exec(createTableQuery);
                // Create basic index on primary key
                db.exec(`CREATE INDEX IF NOT EXISTS idx_${sqliteTableName}_pk ON "${sqliteTableName}" (id);`);
            }

            // Now create all necessary junction tables
            console.log('\n[LOG] Creating junction tables...');
            const createdJunctionTables = new Set();
            for (const junctionInfo of junctionTablesToCreate) {
                if (createdJunctionTables.has(junctionInfo.name)) continue; // Avoid duplicate creation attempts

                const createJunctionQuery = `
                    CREATE TABLE IF NOT EXISTS "${junctionInfo.name}" (
                        source_id TEXT NOT NULL, 
                        target_id TEXT NOT NULL,
                        PRIMARY KEY (source_id, target_id)
                        -- Optional: FOREIGN KEY(source_id) REFERENCES "${junctionInfo.sourceTableSqliteName}"(id), 
                        -- Optional: Add foreign key for target_id if we map linkedTableId to its sqlite name
                    );
                `;
                console.log(`[LOG] CREATE TABLE statement for junction table '${junctionInfo.name}': ${createJunctionQuery}`);
                db.exec(createJunctionQuery);
                // Create indexes for faster lookups on junction tables
                db.exec(`CREATE INDEX IF NOT EXISTS idx_${junctionInfo.name}_source ON "${junctionInfo.name}" (source_id);`);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_${junctionInfo.name}_target ON "${junctionInfo.name}" (target_id);`);
                
                // Prepare the insert statement for this junction table
                const insertJunctionSql = `INSERT OR IGNORE INTO "${junctionInfo.name}" (source_id, target_id) VALUES (?, ?)`;
                junctionInsertStmts[junctionInfo.name] = db.prepare(insertJunctionSql);
                
                createdJunctionTables.add(junctionInfo.name);
            }
            console.log('[LOG] Finished creating junction tables.');

        })(); // End transaction for table creation

        // 3. Process each table (Fetch data and Populate Main + Junction Tables)
        for (const tableSchema of tablesSchema) {
            const sqliteTableName = sanitizeColumnName(tableSchema.name);
            const tableViewerConfig = viewerConfigData.tables.find(t => t.id === tableSchema.id);

            if (!tableViewerConfig) {
                console.warn(`[WARN] Skipping data population for table ${tableSchema.name} (${tableSchema.id}) as its config was not found.`);
                continue; 
            }
            console.log(`\n[LOG] Fetching and populating data for table: '${tableSchema.name}' (SQLite: '${sqliteTableName}')`);

            // Fetch all records for this table (same as before)
            console.log(`[LOG] Fetching records for table '${tableSchema.name}'...`);
            let allRecords = [];
            let offset = null;
            do {
                // Ensure rate limiting between fetches
                await new Promise(resolve => setTimeout(resolve, AIRTABLE_RATE_LIMIT_DELAY)); 
                const airtableApiUrl = `${AIRTABLE_API_BASE_URL}/${baseId}/${tableSchema.id}`;
                try {
                    const response = await axios.get(airtableApiUrl, {
                        headers: { 'Authorization': `Bearer ${apiKey}` },
                        params: { offset: offset }
                    });
                    allRecords = allRecords.concat(response.data.records);
                    offset = response.data.offset;
                    console.log(`[LOG] Fetched ${response.data.records.length} records for ${tableSchema.name}. Total: ${allRecords.length}. Next offset: ${offset}`);
                } catch (fetchError) {
                    console.error(`[ERROR] Failed to fetch records for table ${tableSchema.name} (offset: ${offset}):`, fetchError.response?.data || fetchError.message);
                    offset = null; // Stop fetching for this table on error
                    // Decide if you want to throw or just log and continue with partial data
                    // For now, log and break the loop for this table
                    break; 
                }
            } while (offset);
            console.log(`[LOG] Finished fetching. Total ${allRecords.length} records for table '${tableSchema.name}'.`);

            // Prepare insert statement dynamically for the MAIN table
            // Only include columns that are NOT link types
            const columnsForMainInsert = tableViewerConfig.fields
                .filter(f => f.type !== 'multipleRecordLinks')
                .map(f => ({ 
                    airtableName: f.name, 
                    sqliteName: f.sqliteName, 
                    airtableType: f.type, 
                    airtableOptions: f.options 
                }));
            // Add the 'id' primary key column mapping explicitly
            const allMappingsForMainInsert = [
                { airtableName: 'id', sqliteName: 'id', airtableType: 'text', airtableOptions: null },
                ...columnsForMainInsert
            ];

            const insertColumnNames = allMappingsForMainInsert.map(m => `"${m.sqliteName}"`).join(', ');
            const insertPlaceholders = allMappingsForMainInsert.map(() => '?').join(', ');
            const insertSql = `INSERT INTO "${sqliteTableName}" (${insertColumnNames}) VALUES (${insertPlaceholders})`;
            console.log(`[LOG] Insert SQL for ${sqliteTableName} (Main Table): ${insertSql}`) 
            const insertStmt = db.prepare(insertSql);

            // Get info about link fields for THIS table to populate junction tables
            const linkFieldsForThisTable = tableViewerConfig.fields.filter(f => f.type === 'multipleRecordLinks');

            // Batch insert records (Main Table and Junction Tables)
            const insertTransaction = db.transaction((records) => {
                let successfulMainInserts = 0;
                let failedMainInserts = 0;
                let successfulJunctionInserts = 0;
                let failedJunctionInserts = 0;

                for (const record of records) {
                    // 1. Prepare values for the MAIN table insert
                    const valuesToInsertMain = allMappingsForMainInsert.map(mapping => {
                        if (mapping.sqliteName === 'id') {
                            return record.id; // Airtable Record ID for our 'id' PK column
                        }
                        const rawValue = record.fields[mapping.airtableName];
                        return formatValueForSQLite(rawValue, mapping.airtableType, mapping.airtableOptions);
                    });

                    // 2. Insert into the MAIN table
                    try {
                        insertStmt.run(valuesToInsertMain);
                        successfulMainInserts++;
                    } catch (insertError) {
                        failedMainInserts++;
                        console.error(`[IMPORTANT ERROR] Skipping main record insert due to error in table ${sqliteTableName}: ${insertError.message} Record ID: ${record.id} Problematic Data: ${JSON.stringify(record.fields)} Raw values for insert: ${JSON.stringify(valuesToInsertMain)}`);
                        // If main insert fails, skip junction inserts for this record
                        continue; 
                    }

                    // 3. Insert into JUNCTION tables for this record
                    for (const linkField of linkFieldsForThisTable) {
                        const linkedRecordIds = record.fields[linkField.name]; // Original Airtable name to get data
                        const junctionTableName = linkField.junctionTable;
                        const junctionStmt = junctionInsertStmts[junctionTableName]; // Get the prepared statement

                        if (linkedRecordIds && Array.isArray(linkedRecordIds) && junctionStmt) {
                            for (const linkedRecordId of linkedRecordIds) {
                                try {
                                    // Insert pair: (source record ID, target record ID)
                                    junctionStmt.run(record.id, linkedRecordId);
                                    successfulJunctionInserts++;
                                } catch (junctionError) {
                                    // Use OR IGNORE in junction insert, so duplicates aren't errors
                                    // Log other potential errors
                                    if (!junctionError.message.includes('UNIQUE constraint failed')) { 
                                        failedJunctionInserts++;
                                        console.error(`[ERROR] Inserting into junction table ${junctionTableName}: ${junctionError.message} SourceID: ${record.id}, TargetID: ${linkedRecordId}`);
                                    }
                                }
                            }
                        }
                    }
                }
                // Return stats from transaction
                return { successfulMainInserts, failedMainInserts, successfulJunctionInserts, failedJunctionInserts }; 
            });

            console.log(`[LOG] Starting batch insert transaction for ${allRecords.length} records into main table '${sqliteTableName}' and related junction tables...`);
            const insertStats = insertTransaction(allRecords);
            console.log(`[LOG] Main Table ('${sqliteTableName}') Inserts: ${insertStats.successfulMainInserts} successful, ${insertStats.failedMainInserts} failed.`);
            console.log(`[LOG] Junction Table Inserts (related to ${sqliteTableName}): ${insertStats.successfulJunctionInserts} successful, ${insertStats.failedJunctionInserts} failed.`);

            // Remove main table index creation from here, as it's done during table creation
            // db.exec(`CREATE INDEX IF NOT EXISTS idx_${sqliteTableName}_pk ON "${sqliteTableName}" (id);`);
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