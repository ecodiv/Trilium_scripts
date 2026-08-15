const DEFAULT_SETTINGS = {
  triliumUrl: "",
  etapiToken: "",
  parentNoteId: "",
  importAttachments: true,
  preserveEml: true,
  bodyFormat: "plain",
  dateMode: "both",
  dateLabel: "emailDate"
};

const form = document.getElementById("settingsForm");
const status = document.getElementById("status");

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validateLocalTriliumUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:") {
    throw new Error("For the local Trilium desktop instance, use http://localhost:37840 or http://127.0.0.1:37840.");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("This build is configured for a local Trilium instance only (localhost or 127.0.0.1).");
  }
  return url;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? "error" : "success";
}

async function loadSettings() {
  const settings = await messenger.storage.local.get(DEFAULT_SETTINGS);
  document.getElementById("triliumUrl").value = settings.triliumUrl;
  document.getElementById("etapiToken").value = settings.etapiToken;
  document.getElementById("parentNoteId").value = settings.parentNoteId;
  document.getElementById("importAttachments").checked = settings.importAttachments;
  document.getElementById("preserveEml").checked = settings.preserveEml;
  document.getElementById("bodyFormat").value = settings.bodyFormat || "plain";
  document.getElementById("dateMode").value = settings.dateMode;
  document.getElementById("dateLabel").value = settings.dateLabel || "emailDate";
}

async function testEtapi(settings) {
  const headers = new Headers({
    Authorization: settings.etapiToken
  });

  const appResponse = await fetch(`${settings.triliumUrl}/etapi/app-info`, { headers });
  if (!appResponse.ok) {
    const text = await appResponse.text();
    throw new Error(`ETAPI connection failed (${appResponse.status}): ${text || appResponse.statusText}`);
  }

  const appInfo = await appResponse.json();

  const noteResponse = await fetch(
    `${settings.triliumUrl}/etapi/notes/${encodeURIComponent(settings.parentNoteId)}`,
    { headers }
  );

  if (!noteResponse.ok) {
    const text = await noteResponse.text();
    throw new Error(`Destination note not found (${noteResponse.status}): ${text || noteResponse.statusText}`);
  }

  const note = await noteResponse.json();
  return { appInfo, note };
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  setStatus("");

  try {
    const settings = {
      triliumUrl: normalizeBaseUrl(document.getElementById("triliumUrl").value),
      etapiToken: document.getElementById("etapiToken").value.trim(),
      parentNoteId: document.getElementById("parentNoteId").value.trim(),
      importAttachments: document.getElementById("importAttachments").checked,
      preserveEml: document.getElementById("preserveEml").checked,
      bodyFormat: document.getElementById("bodyFormat").value,
      dateMode: document.getElementById("dateMode").value,
      dateLabel: document.getElementById("dateLabel").value.trim() || "emailDate"
    };

    if (!/^\S+$/.test(settings.dateLabel)) {
      throw new Error("The date label name cannot contain whitespace.");
    }

    validateLocalTriliumUrl(settings.triliumUrl);

    await messenger.storage.local.set(settings);
    setStatus("Settings saved; testing Trilium...");

    const { appInfo, note } = await testEtapi(settings);
    const version = appInfo.appVersion || appInfo.version || "unknown version";
    setStatus(`Connected to Trilium ${version}. Destination: ${note.title} (${note.noteId}).`);
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
  }
});

loadSettings().catch(error => {
  console.error(error);
  setStatus(`Could not load settings: ${error.message}`, true);
});
