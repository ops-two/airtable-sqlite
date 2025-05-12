const apiKeyInput = document.getElementById('apiKey');
const loadBasesBtn = document.getElementById('loadBasesBtn');
const basesSection = document.getElementById('basesSection');
const basesDropdown = document.getElementById('basesDropdown');
const generateSnapshotBtn = document.getElementById('generateSnapshotBtn');
const statusText = document.getElementById('statusText');
const progressBarContainer = document.getElementById('progressBarContainer');
const progressBar = document.getElementById('progressBar');

let selectedBaseId = null;
let selectedBaseName = null;

function updateStatus(message, progressPercentage) {
    statusText.textContent = message;
    if (progressPercentage !== undefined) {
        progressBarContainer.style.display = 'block';
        progressBar.style.width = `${progressPercentage}%`;
    } else {
        progressBarContainer.style.display = 'none';
    }
}

loadBasesBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        updateStatus('Please enter an API Key.');
        return;
    }
    updateStatus('Loading bases...', 0);
    loadBasesBtn.disabled = true;
    generateSnapshotBtn.disabled = true;

    try {
        const response = await fetch('/api/list-bases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `Failed to load bases (Status: ${response.status})`);
        }

        const bases = await response.json();
        basesDropdown.innerHTML = '<option value="">-- Select a Base --</option>';
        if (bases.length > 0) {
            bases.forEach(base => {
                const option = document.createElement('option');
                option.value = base.id;
                option.textContent = base.name;
                basesDropdown.appendChild(option);
            });
            basesSection.style.display = 'block';
            updateStatus('Bases loaded. Select one.');
        } else {
            updateStatus('No bases found for this API key.');
        }
    } catch (error) {
        console.error('Error loading bases:', error);
        updateStatus(`Error: ${error.message}`);
    } finally {
        loadBasesBtn.disabled = false;
    }
});

basesDropdown.addEventListener('change', () => {
    selectedBaseId = basesDropdown.value;
    selectedBaseName = basesDropdown.value ? basesDropdown.options[basesDropdown.selectedIndex].text : null;
    generateSnapshotBtn.disabled = !selectedBaseId;
    if (selectedBaseId) {
        updateStatus('Base selected. Ready to generate snapshot.');
    }
});

generateSnapshotBtn.addEventListener('click', async () => {
    if (!selectedBaseId) return;
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        updateStatus('API Key is missing.');
        return;
    }

    updateStatus('Preparing to generate snapshot...', 0);
    generateSnapshotBtn.disabled = true;
    loadBasesBtn.disabled = true;

    // Use a simple polling mechanism for progress (more advanced would use WebSockets or Server-Sent Events)
    // For this example, we'll just show "Processing..." and then "Downloading..."
    // A unique ID could be generated client-side and sent to server to track progress if server supports it.

    try {
        updateStatus('Generating snapshot... This may take several minutes. Please wait.', 10);
        // The actual progress bar won't update dynamically without more complex server setup (SSE/WebSockets)
        // For now, it's a visual cue that something is happening.
        progressBarContainer.style.display = 'block';
        progressBar.style.width = '20%'; // Initial progress

        const response = await fetch('/api/generate-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, baseId: selectedBaseId, baseName: selectedBaseName })
        });

        progressBar.style.width = '80%';

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ message: "Unknown server error during generation." }));
            console.error('Snapshot generation failed:', errorData);
            let details = errorData.message || `Snapshot generation failed (Status: ${response.status})`;
            if (errorData.error) details += `\nServer error: ${errorData.error}`;
            if (errorData.stack) details += `\nStack: ${errorData.stack}`;
            throw new Error(details);
        }

        // Handle file download
        const blob = await response.blob();
        const contentDisposition = response.headers.get('content-disposition');
        let filename = "airtable_snapshot.zip";
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
            if (filenameMatch && filenameMatch.length > 1) {
                filename = filenameMatch[1];
            }
        }

        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        updateStatus(`Snapshot '${filename}' downloaded successfully!`, 100);

    } catch (error) {
        console.error('Error generating snapshot:', error);
        updateStatus(`Error: ${error.message}`);
        progressBarContainer.style.display = 'none';
    } finally {
        generateSnapshotBtn.disabled = false;
        loadBasesBtn.disabled = false;
    }
});