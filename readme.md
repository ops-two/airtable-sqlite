# Airtable to SQLite Snapshot & Offline Viewer

This project allows you to export data from an Airtable base into an SQLite database and then view that data offline using a bundled, self-contained web-based viewer.

## Key Features

*   **List Airtable Bases**: Connect to your Airtable account (via API key) to list available bases.
*   **Generate Snapshots**: Select a base to export its schema (tables, fields, field types) and all records.
*   **SQLite Database**: Data is stored in a local SQLite file, making it portable and accessible with standard SQL tools.
*   **Offline Viewer**: A dynamic web application (HTML, CSS, JavaScript) is packaged with the SQLite database in a ZIP file. This viewer allows you to:
    *   Browse tables and records offline.
    *   Search within tables.
    *   View linked records.
    *   Paginate through large datasets.
*   **Handles Airtable Complexity**: The tool maps various Airtable field types (including lookups, rollups, select options with colors) to appropriate SQLite representations. It ensures unique and valid SQLite table and column names by:
    *   Reserving `id` as the primary key (TEXT) in each main SQLite table to store the original Airtable Record ID.
    *   Renaming any conflicting user-defined Airtable fields named 'ID' (case-insensitive after sanitization) to avoid collision (e.g., to `id_1`).
    *   Resolving other potential naming collisions after sanitizing Airtable field names (e.g., 'Field A' and 'Field_A' might become `Field_A` and `Field_A_1`).
    *   **Representing Airtable 'Linked Record' fields using dedicated Junction Tables.** Instead of storing linked IDs in the main table, a separate table (e.g., `_link_SourceTable_LinkFieldName`) is created for each linked record field. This junction table contains pairs of `source_id` and `target_id`, allowing relationships to be queried using standard SQL `JOIN` operations.
    *   The generated SQLite database includes metadata tables (`_airtable_meta_tables` and `_airtable_meta_fields`) that store details about the original Airtable schema, the SQLite table/column name mappings, and the names of the junction tables used for linked records.
*   **Rate Limiting**: Respects Airtable API rate limits during data fetching.

## Technologies Used

*   **Backend (Server)**:
    *   Node.js
    *   Express.js (for web server and API routes)
    *   Axios (for Airtable API requests)
    *   better-sqlite3 (for SQLite database operations)
    *   JSZip (for creating ZIP archives)
    *   fs-extra (for file system operations)
*   **Frontend (Snapshot Generator UI)**:
    *   HTML, CSS, JavaScript (served from the `public` folder)
*   **Offline Viewer (`viewer_template` & Packaged Output)**:
    *   HTML, CSS, JavaScript
    *   SQL.js (SQLite engine compiled to WebAssembly, allowing database operations directly in the browser)

## Prerequisites

*   **Node.js**: Version 22.0.0 or higher is **required**. Using a Node Version Manager (NVM) is highly recommended to manage Node.js versions easily.
*   **npm**: Comes with Node.js, used for package management.
*   **Airtable Account**: You'll need an Airtable API key from your account page.

## Setup and Installation

1.  **Clone or Download the Repository**:
    ```bash
    # If you have git
    # git clone <repository_url>
    # cd <repository_folder>

    # Or download and extract the ZIP
    ```
2.  **Navigate to the Project Directory**:
    ```bash
    cd /path/to/Airtable-Downloader
    ```
3.  **Install Dependencies**:
    Ensure you are using Node.js v22.x (or the version specified in package.json's "engines" field). This is crucial because native modules like 'better-sqlite3' are compiled against the Node.js version active during 'npm install'. Mismatches can cause runtime errors.
    If you have `nvm`:
    ```bash
    nvm use 22
    # Or nvm install 22 and then nvm use 22
    ```
    Then install the packages:
    ```bash
    npm install
    ```
    This will install all dependencies listed in `package.json`.

## Running the Application (Server)

1.  **Start the Server**:
    ```bash
    npm start
    ```
    Alternatively, for development with automatic restarts on file changes (if `nodemon` is installed as a dev dependency):
    ```bash
    npm run dev
    ```
2.  **Access the Application**:
    Open your web browser and go to `http://localhost:3000` (or the port specified in the console output).

## How to Use

1.  **Enter API Key**: On the web interface, enter your Airtable API Key.
2.  **List Bases**: Click the button to fetch and display a list of your Airtable bases.
3.  **Select Base**: Choose the Airtable base you want to export from the dropdown menu.
4.  **Generate Snapshot**: Click the "Generate Snapshot" button.
5.  **Download ZIP**: The server will process the base, create an SQLite database, and package it with the viewer. A ZIP file will be automatically downloaded by your browser.

## Using the Offline Viewer

1.  **Extract the ZIP File**: Unzip the downloaded file (e.g., `YourBaseName_snapshot_timestamp.zip`) to a folder on your computer.
2.  **Open the Viewer**:
    *   Navigate into the extracted folder, then into the `viewer` subfolder.
    *   Open the `index.html` file in a modern web browser (e.g., Chrome, Firefox, Edge, Safari).

### Viewer Features:

*   **Table Selection**: Use the dropdown to switch between different tables from your Airtable base.
*   **Search**: Type into the search box and click "Search" to filter records in the current table (searches text-based fields).
*   **Pagination**: Use the "Previous" and "Next" buttons to navigate through records if there are many.
*   **View Linked Records**: If a field represents a link to another record (from a `multipleRecordLinks` Airtable field), clicking on the link (often an ID) will open a modal showing the details of that linked record.

## Troubleshooting Server/Snapshot Generation Issues

*   **Error: `NODE_MODULE_VERSION` mismatch for `better-sqlite3` (or other native modules)**
    *   **Symptom**: You might see an error like:
        ```
        Error: The module '/path/to/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
        was compiled against a different Node.js version using
        NODE_MODULE_VERSION XXX. This version of Node.js requires
        NODE_MODULE_VERSION YYY. Please try re-compiling or re-installing
        the module (for instance, using `npm rebuild` or `npm install`).
        ```
    *   **Cause**: This means the Node.js version used to run `npm install` (which compiled `better-sqlite3`) is different from the Node.js version you're currently using to run `npm start`.
    *   **Solution**:
        1.  **Ensure correct Node.js version**: Activate the Node.js version specified in `package.json` (e.g., `v22.0.0` or higher). Using NVM:
            ```bash
            nvm install 22 # Or your target version
            nvm use 22
            node -v # Verify you're on the correct version
            ```
        2.  **Stop the server**: If it's running, stop it (e.g., `Ctrl+C` in the terminal).
        3.  **Clean slate**: Delete the `node_modules` directory and the `package-lock.json` file from your project folder:
            ```bash
            rm -rf node_modules package-lock.json
            ```
        4.  **Reinstall dependencies**: This will recompile native modules with your currently active (and correct) Node.js version:
            ```bash
            npm install
            ```
        5.  **Restart the server**:
            ```bash
            npm start
            ```
        This should resolve the mismatch.

### Troubleshooting Viewer Issues

*   **Error: "Could not load configuration file for the viewer." or "Error loading database..."**
    This is the most common issue when opening `index.html` directly from your local file system (`file:///...` URL).

    **Cause**: Browsers have security restrictions (CORS) that prevent web pages loaded via `file://` from making `fetch` requests to other local files, even if they are in the same directory (like `viewer_config.json` or the SQLite database file).

    **Solution: Serve the Viewer Files Locally via HTTP**
    You need to serve the `viewer` directory's contents through a simple local web server. Here are a few easy ways:

    1.  **Using `npx http-server` (if you have Node.js/npm)**:
        *   Open your terminal or command prompt.
        *   Navigate *inside* the `viewer` folder (the one containing `index.html`, `script.js`, etc.):
            ```bash
            cd /path/to/your_extracted_snapshot/viewer
            ```
        *   Run the following command:
            ```bash
            npx http-server
            ```
        *   This will start a local web server. The terminal will show you one or more URLs, typically `http://localhost:8080` or `http://127.0.0.1:8080`.
        *   Open this URL in your web browser. The viewer should now load correctly.
        *   To stop the server, go back to the terminal and press `Ctrl+C`.

    2.  **Using Python's built-in HTTP server** (if you have Python installed):
        *   Open your terminal or command prompt.
        *   Navigate *inside* the `viewer` folder:
            ```bash
            cd /path/to/your_extracted_snapshot/viewer
            ```
        *   If you have Python 3:
            ```bash
            python3 -m http.server
            ```
        *   If you have Python 2:
            ```bash
            python -m SimpleHTTPServer
            ```
        *   This will start a server, usually on port 8000. Open `http://localhost:8000` in your browser.

    3.  **Using a code editor with a live server extension** (e.g., VS Code with "Live Server" extension):
        *   Open the *entire* `viewer` folder in your code editor.
        *   Right-click on `index.html` and choose "Open with Live Server" (or similar option).

    By using a local HTTP server, the browser can correctly fetch `viewer_config.json` and the database file, allowing the viewer to function as intended.

## Project Structure

```
/Airtable-Downloader
|-- /public                 # Static assets for the snapshot generator UI (HTML, CSS, JS)
|   |-- index.html
|   |-- script.js
|   `-- style.css
|-- /viewer_template        # Template for the offline data viewer
|   |-- /lib                # SQL.js library files (sql-wasm.js, sql-wasm.wasm)
|   |-- index.html
|   |-- script.js
|   `-- style.css
|-- server.js               # Main Express.js application logic
|-- package.json            # Project dependencies and scripts
|-- package-lock.json       # Exact dependency versions
`-- readme.md               # This file
```

## Contributing

(Optional: Add guidelines if you plan for others to contribute.)

## License

(Optional: Add a license if desired, e.g., MIT License.)

## SQLite Schema Details (for Viewer Development)

This section details how Airtable base structures are mapped to the generated SQLite database. Understanding this mapping is crucial for developing or maintaining the offline viewer.

### 1. Table and Column Naming

*   **Sanitization**: Airtable table and field names are sanitized to be valid SQLite identifiers. This typically involves:
    *   Replacing non-alphanumeric characters (except underscores) with underscores (`_`).
    *   Collapsing multiple consecutive underscores into one.
    *   Removing leading/trailing underscores.
    *   Example: An Airtable table "Project Milestones!" might become `Project_Milestones` in SQLite.
*   **Metadata**: The `_airtable_meta_tables` table stores the mapping between the original Airtable table name (`name`) and its sanitized SQLite name (`sqlite_name`). Similarly, `_airtable_meta_fields` maps original field names (`name`) to their SQLite representation (`sqlite_name` or indicates a junction table).

### 2. Primary Keys

*   Each main data table in SQLite has a dedicated primary key column named `id`.
*   This `id` column is of type `TEXT` and stores the **original Airtable Record ID** (e.g., `recXXXXXXXXXXXXXX`).
*   This serves as the unique identifier for rows within the SQLite database and is used for linking records.

### 3. Name De-duplication

SQLite requires unique column names within a table. Conflicts can arise from sanitization or if an Airtable field is named 'ID'.

*   **Reserved `id` Conflict**: If an Airtable field, after sanitization, would be named `id` (case-insensitive), it is renamed by appending `_1`, `_2`, etc. (e.g., `id_1`).
*   **Other Conflicts**: If multiple Airtable fields sanitize to the same name within the same table (e.g., "Status" and "status" might both become `Status`), subsequent occurrences are renamed by appending `_1`, `_2`, etc. (e.g., `Status`, `Status_1`).
*   **Metadata**: The `_airtable_meta_fields` table stores both the original Airtable field name (`name`) and the final, de-duplicated SQLite column name (`sqlite_name`) used in the `CREATE TABLE` statement (for non-linked fields).

### 4. Field Type Mapping (Common Types)

| Airtable Type         | SQLite Type | SQLite Value Representation                                                                 |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `singleLineText`, etc. | `TEXT`      | String value                                                                                |
| `number`, `currency`  | `REAL` / `INTEGER` | Numeric value (REAL if precision > 0)                                                    |
| `checkbox`            | `INTEGER`   | `1` (true) or `0` (false)                                                                   |
| `date`, `dateTime`    | `TEXT`      | ISO 8601 formatted date/time string                                                        |
| `singleSelect`        | `TEXT`      | The name (string) of the selected option                                                    |
| `multipleSelects`     | `TEXT`      | JSON string array of selected option names (e.g., `["Option A", "Option B"]`)           |
| `singleCollaborator`  | `TEXT`      | Collaborator's name or email (best available identifier)                                  |
| `multipleCollaborators`| `TEXT`      | JSON string array of collaborator objects (containing id, email, name)                   |
| `attachment`          | `TEXT`      | JSON string array of attachment objects (id, url, filename, size, type, etc.)             |
| `formula`, `lookup`   | Varies      | Mapped based on the *result type* of the formula/lookup (often `TEXT` or `REAL`/`INTEGER`) |
| **`multipleRecordLinks`** | **(See Below)** | **Handled via Junction Tables**                                                           |

*   **Note**: The `_airtable_meta_fields` table stores the original `type` and `options_json` (e.g., select choices, linked table ID) which the viewer needs for proper display and interaction.

### 5. Linked Records (Junction Tables)

Airtable's `multipleRecordLinks` fields are *not* represented as columns in the main SQLite tables. Instead:

*   **Junction Table**: For each linked record field, a separate **junction table** is created.
*   **Naming Convention**: The junction table is named `_link_<SourceTableSQLiteName>_<FieldSQLiteName>` (e.g., `_link_Projects_Tasks`). The specific name is stored in the `junction_table_name` column of the `_airtable_meta_fields` table for that field.
*   **Columns**: Each junction table has two `TEXT` columns:
    *   `source_id`: Stores the `id` (Airtable Record ID) of the record in the source table.
    *   `target_id`: Stores the `id` (Airtable Record ID) of a linked record in the target table.
*   **Relationship**: A many-to-many relationship is represented by multiple rows in the junction table for a single `source_id`.
*   **Viewer Querying**: To get the linked records for a specific source record (e.g., project `recABC`), the viewer should:
    1.  Find the junction table name from `_airtable_meta_fields` for the relevant field.
    2.  Query the junction table: `SELECT target_id FROM <junction_table_name> WHERE source_id = 'recABC';`
    3.  Use the retrieved `target_id` values to query the target table (whose SQLite name can also be found via `_airtable_meta_fields` options or by joining `_airtable_meta_tables`): `SELECT * FROM <TargetTableSQLiteName> WHERE id IN ('target_id_1', 'target_id_2', ...);`

### 6. Metadata Tables

These tables are essential for the viewer to interpret the data correctly.

*   **`_airtable_meta_tables`**: Stores information about each table.
    *   `id`: Original Airtable Table ID.
    *   `name`: Original Airtable Table Name.
    *   `sqlite_name`: Sanitized name used for the SQLite table.
    *   `primary_field_id`: Original Airtable ID of the table's primary field.
*   **`_airtable_meta_fields`**: Stores information about each field.
    *   `id`: Original Airtable Field ID.
    *   `table_id`: Foreign key to `_airtable_meta_tables.id`.
    *   `name`: Original Airtable Field Name.
    *   `sqlite_name`: Sanitized & de-duplicated name used for the SQLite column (if *not* a link field).
    *   `type`: Original Airtable field type (e.g., `singleLineText`, `multipleRecordLinks`).
    *   `options_json`: JSON string of field options (vital for selects, linked record details like `linkedTableId`).
    *   `airtable_description`: Original Airtable field description.
    *   `is_primary_key`: `1` only for the synthetic `id` column, `0` otherwise.
    *   `junction_table_name`: Contains the name of the junction table if `type` is `multipleRecordLinks`, `NULL` otherwise.

By using these metadata tables, the viewer can dynamically reconstruct the original Airtable structure, display appropriate field types, find linked records via junction tables, and present the data meaningfully.