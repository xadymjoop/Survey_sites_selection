// State Management
let surveyData = [];
let filteredData = [];
let dbFilteredData = [];
let selectedSite = null;
let map = null;
let markersGroup = null;
let charts = {};

// // Default URL from User (not strictly needed, but kept as fallback)
const DEFAULT_URL = "https://services3.arcgis.com/g35I7H3cawmNpwmT/arcgis/rest/services/survey123_7d08f5aee5704a449e7a65e0c08ce250_results/FeatureServer";
let currentUser = null; // Stores { username, role }

// Initialize the Application
document.addEventListener("DOMContentLoaded", () => {
    setupAuthListeners();
    checkAuthAndInit();
});

// Authenticate session and initialize views
async function checkAuthAndInit() {
    const token = localStorage.getItem("auth_token");
    const overlay = document.getElementById("login-overlay");
    
    if (!token) {
        overlay.classList.remove("hidden");
        return;
    }
    
    try {
        const response = await fetch("/api/auth/me", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        
        if (!response.ok) {
            throw new Error("Session expirée");
        }
        
        currentUser = await response.json();
        overlay.classList.add("hidden");
        
        // Hide admin-only tabs for standard readers
        const adminNavItems = document.querySelectorAll('[data-view="connection"], [data-view="users"]');
        if (currentUser.role !== "admin") {
            adminNavItems.forEach(item => {
                if (item) item.parentElement.style.display = "none";
            });
        }
        
        initViews();
        loadConnectionSettings();
        initApp();
        
    } catch (err) {
        console.error("Auth check failed:", err);
        localStorage.removeItem("auth_token");
        overlay.classList.remove("hidden");
    }
}

// Bind Login Form and Logout Events
function setupAuthListeners() {
    const form = document.getElementById("login-form");
    const errEl = document.getElementById("login-error");
    const logoutBtn = document.getElementById("btn-logout");
    
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = document.getElementById("login-username").value.trim();
        const password = document.getElementById("login-password").value.trim();
        
        errEl.textContent = "";
        
        try {
            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password })
            });
            
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.detail || "Échec de la connexion");
            }
            
            const data = await res.json();
            localStorage.setItem("auth_token", data.token);
            checkAuthAndInit();
            
        } catch (err) {
            errEl.textContent = err.message;
        }
    });
    
    logoutBtn.addEventListener("click", () => {
        localStorage.removeItem("auth_token");
        location.reload();
    });
}

// Setup View Navigation
function initViews() {
    const navItems = document.querySelectorAll(".nav-item");
    const views = document.querySelectorAll(".view-container");

    navItems.forEach(item => {
        item.addEventListener("click", (e) => {
            const targetView = item.getAttribute("data-view");
            
            // Access control check
            if (currentUser.role !== "admin" && (targetView === "connection" || targetView === "users")) {
                return;
            }
            
            navItems.forEach(n => n.classList.remove("active"));
            views.forEach(v => v.classList.remove("active"));
            
            item.classList.add("active");
            document.getElementById(targetView).classList.add("active");
            
            // Re-render map/charts when viewing dashboard
            if (targetView === "dashboard") {
                if (map) {
                    setTimeout(() => map.invalidateSize(), 100);
                }
            }
            
            // Load users list if administrator visits users view
            if (targetView === "users") {
                loadUsersList();
            }
            
            // Populate database table grid view
            if (targetView === "database") {
                populateDatabaseTable();
            }
        });
    });
}

// Load configurations from Backend (Admin only)
async function loadConnectionSettings() {
    if (!currentUser || currentUser.role !== "admin") return;
    
    const urlInput = document.getElementById("arcgis-url");
    const tokenInput = document.getElementById("arcgis-token");
    const geminiKeyInput = document.getElementById("gemini-key");
    const openaiKeyInput = document.getElementById("openai-key");
    
    try {
        const token = localStorage.getItem("auth_token");
        const response = await fetch("/api/settings", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        
        if (!response.ok) throw new Error("Impossible de charger les réglages");
        
        const data = await response.json();
        if (urlInput) urlInput.value = data.arcgis_url || DEFAULT_URL;
        if (tokenInput) tokenInput.value = data.arcgis_token || "";
        if (geminiKeyInput) geminiKeyInput.value = data.gemini_api_key || "";
        if (openaiKeyInput) openaiKeyInput.value = data.openai_api_key || "";
    } catch (err) {
        console.error("Error loading settings:", err);
    }
}

// Initialize Map and Data
async function initApp() {
    initMap();
    
    // Bind search and filter change listeners
    document.getElementById("filter-region").addEventListener("change", applyFilters);
    document.getElementById("filter-status").addEventListener("change", applyFilters);
    document.getElementById("filter-difficulty").addEventListener("change", applyFilters);
    document.getElementById("site-search").addEventListener("input", applyFilters);
    
    // Bind connection form listeners
    if (currentUser.role === "admin") {
        document.getElementById("btn-test-connection").addEventListener("click", () => testAndFetchData(true));
        document.getElementById("btn-load-mock").addEventListener("click", loadMockData);
        
        // Bind AI config listeners
        document.getElementById("btn-save-ai-config").addEventListener("click", async () => {
            const url = document.getElementById("arcgis-url").value.trim();
            const token = document.getElementById("arcgis-token").value.trim();
            const geminiKey = document.getElementById("gemini-key").value.trim();
            const openaiKey = document.getElementById("openai-key").value.trim();
            const statusMsg = document.getElementById("ai-status-msg");
            
            try {
                const authToken = localStorage.getItem("auth_token");
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${authToken}`
                    },
                    body: JSON.stringify({
                        arcgis_url: url,
                        arcgis_token: token,
                        gemini_api_key: geminiKey,
                        openai_api_key: openaiKey,
                        storytelling_mode: localStorage.getItem("storytelling_mode") || "standard"
                    })
                });
                
                if (!res.ok) throw new Error("Échec d'enregistrement");
                
                statusMsg.className = "kpi-desc text-success";
                statusMsg.innerHTML = "✅ Configuration enregistrée avec succès !";
                setTimeout(() => { statusMsg.innerHTML = ""; }, 3000);
            } catch (err) {
                statusMsg.className = "kpi-desc text-danger";
                statusMsg.innerHTML = `❌ Erreur : ${err.message}`;
            }
        });
        
        // Bind user management form submit listener
        const userForm = document.getElementById("create-user-form");
        if (userForm) {
            userForm.addEventListener("submit", createNewUser);
        }
    }
    
    // Bind database export button listeners
    const exportCsvBtn = document.getElementById("btn-export-csv");
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener("click", exportToCSV);
    }
    const exportXlsBtn = document.getElementById("btn-export-xls");
    if (exportXlsBtn) {
        exportXlsBtn.addEventListener("click", exportToXLS);
    }
    
    // Bind database filters
    const dbFilterSite = document.getElementById("db-filter-site");
    if (dbFilterSite) dbFilterSite.addEventListener("input", applyDatabaseFilters);
    const dbFilterRegion = document.getElementById("db-filter-region");
    if (dbFilterRegion) dbFilterRegion.addEventListener("change", applyDatabaseFilters);
    const dbFilterVillage = document.getElementById("db-filter-village");
    if (dbFilterVillage) dbFilterVillage.addEventListener("change", applyDatabaseFilters);
    const dbResetBtn = document.getElementById("btn-db-reset-filters");
    if (dbResetBtn) dbResetBtn.addEventListener("click", resetDatabaseFilters);
    
    // Load initial data from server
    await loadInitialData();
}

// Initialize Leaflet Map
function initMap() {
    if (map) return;
    map = L.map('map').setView([11.85, -15.5], 8.5);
    
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    }).addTo(map);
    
    L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}').addTo(map);
    markersGroup = L.featureGroup().addTo(map);
}

// Load initial data on startup
async function loadInitialData() {
    updateStatusPill("local", "Chargement...");
    const success = await fetchDataFromServer();
    if (success) return;
    
    loadMockData();
}

// Load mock database from mockData.js
function loadMockData() {
    console.log("Loading mock data...");
    surveyData = [...window.mockSurveyData];
    updateStatusPill("local", "Mode Démo (Données Mock)");
    processLoadedData();
}

// Update Status Pill in header
function updateStatusPill(status, label) {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    
    dot.className = "status-dot " + status;
    text.textContent = label;
}

// Test Connection & Load data from UI action
async function testAndFetchData(saveConfig = true) {
    const url = document.getElementById("arcgis-url").value.trim();
    const token = document.getElementById("arcgis-token").value.trim();
    const statusMsg = document.getElementById("connection-status-msg");
    
    if (!url) {
        statusMsg.className = "kpi-desc text-danger";
        statusMsg.innerHTML = "⚠️ Veuillez saisir l'URL du Feature Service.";
        return;
    }
    
    statusMsg.className = "kpi-desc text-secondary";
    statusMsg.innerHTML = '<span class="loader"></span> Connexion & Synchronisation...';
    
    updateStatusPill("local", "Synchronisation...");
    
    try {
        const authToken = localStorage.getItem("auth_token");
        if (saveConfig) {
            const geminiKey = document.getElementById("gemini-key").value.trim();
            const openaiKey = document.getElementById("openai-key").value.trim();
            await fetch("/api/settings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    arcgis_url: url,
                    arcgis_token: token,
                    gemini_api_key: geminiKey,
                    openai_api_key: openaiKey,
                    storytelling_mode: localStorage.getItem("storytelling_mode") || "standard"
                })
            });
        }
        
        const success = await fetchDataFromServer();
        if (success) {
            statusMsg.className = "kpi-desc text-success";
            statusMsg.innerHTML = "✅ Connexion & Synchronisation réussies !";
        } else {
            throw new Error("Échec du chargement des données depuis le serveur");
        }
    } catch (err) {
        statusMsg.className = "kpi-desc text-danger";
        statusMsg.innerHTML = `❌ Échec : ${err.message}`;
        updateStatusPill("error", "Erreur de connexion");
    }
}

// Main API fetching function using backend proxy
async function fetchDataFromServer() {
    window.lastArcGISError = null;
    try {
        const token = localStorage.getItem("auth_token");
        const response = await fetch("/api/sites", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || `HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        surveyData = data;
        
        updateStatusPill("connected", `Connecté à Survey123 (${surveyData.length} sites)`);
        processLoadedData();
        return true;
        
    } catch (err) {
        console.error("Error fetching Survey123 data from server:", err);
        window.lastArcGISError = err.message;
        return false;
    }
}

// Run mapping, calculations, and update dashboard
function processLoadedData() {
    dbFilteredData = [...surveyData];
    populateFilterOptions();
    populateDatabaseFilterOptions();
    applyFilters();
    populateRawDataTable();
    applyDatabaseFilters();
}

// Fill filters dynamically based on dataset
function populateFilterOptions() {
    const regionSelect = document.getElementById("filter-region");
    const currentRegionVal = regionSelect.value;
    
    // Get unique regions
    const regions = [...new Set(surveyData.map(item => item.region_admin))].filter(Boolean);
    
    regionSelect.innerHTML = '<option value="">Toutes les régions</option>';
    regions.sort().forEach(r => {
        const option = document.createElement("option");
        option.value = r;
        option.textContent = r;
        regionSelect.appendChild(option);
    });
    
    // Keep selection if it exists
    if (regions.includes(currentRegionVal)) {
        regionSelect.value = currentRegionVal;
    }
}

// Apply searches and filter constraints
function applyFilters() {
    const regionVal = document.getElementById("filter-region").value;
    const statusVal = document.getElementById("filter-status").value;
    const diffVal = document.getElementById("filter-difficulty").value;
    const searchVal = document.getElementById("site-search").value.toLowerCase();
    
    filteredData = surveyData.filter(item => {
        // Region filter
        if (regionVal && item.region_admin !== regionVal) return false;
        
        // Status filter
        if (statusVal) {
            if (statusVal === "selected" && item.site_selectionne !== "oui") return false;
            if (statusVal === "eligible_not_selected" && (item.site_eligible !== "oui" || item.site_selectionne === "oui")) return false;
            if (statusVal === "rejected" && item.site_eligible !== "oui") return false;
        }
        
        // Difficulty filter
        if (diffVal) {
            const score = item.score_final;
            if (diffVal === "easy" && score > 8) return false;
            if (diffVal === "medium" && (score <= 8 || score > 11)) return false;
            if (diffVal === "hard" && score <= 11) return false;
        }
        
        // Search filter
        if (searchVal) {
            const name = item.nom_site.toLowerCase();
            const village = item.village.toLowerCase();
            const sector = item.secteur_admin.toLowerCase();
            if (!name.includes(searchVal) && !village.includes(searchVal) && !sector.includes(searchVal)) return false;
        }
        
        return true;
    });
    
    updateKPIs();
    updateCharts();
    updateMap();
    populateSiteList();
    
    // Auto-select first site in storytelling if list is updated
    if (filteredData.length > 0) {
        selectSite(filteredData[0].objectid);
    } else {
        clearStorytellingDetails();
    }
}

// Update Top KPI Cards
function updateKPIs() {
    const total = filteredData.length;
    const eligible = filteredData.filter(item => item.site_eligible === "oui").length;
    const selected = filteredData.filter(item => item.site_selectionne === "oui").length;
    
    const rate = total > 0 ? Math.round((selected / total) * 100) : 0;
    
    // Average restorability score
    const totalScore = filteredData.reduce((acc, item) => acc + item.score_final, 0);
    const avgScore = total > 0 ? (totalScore / total).toFixed(1) : "0.0";
    
    document.getElementById("kpi-total-sites").textContent = total;
    document.getElementById("kpi-eligible-sites").textContent = eligible;
    document.getElementById("kpi-selected-sites").textContent = selected;
    document.getElementById("kpi-selection-rate").textContent = `${rate}%`;
    document.getElementById("kpi-avg-difficulty").textContent = `${avgScore}/15`;
}

// Update Map markers
function updateMap() {
    markersGroup.clearLayers();
    
    if (filteredData.length === 0) return;
    
    filteredData.forEach(item => {
        // Choose color based on selection status
        let color = varColor(item);
        
        const marker = L.circleMarker([item.latitude, item.longitude], {
            radius: 8,
            fillColor: color,
            color: "#fff",
            weight: 1.5,
            opacity: 1,
            fillOpacity: 0.85
        });
        
        // Pop-up details
        const popupContent = `
            <div style="font-family: var(--font-body);">
                <h4 style="margin-bottom: 4px; font-weight:600; color:var(--text-primary); font-family: var(--font-heading);">${item.nom_site}</h4>
                <p style="margin: 0; color:var(--text-secondary); font-size:11px;">Région: <b>${item.region_admin}</b>, Secteur: <b>${item.secteur_admin}</b></p>
                <p style="margin: 4px 0 0 0; color:var(--text-secondary); font-size:11px;">Éligible: <b>${item.site_eligible.toUpperCase()}</b> | Sélectionné: <b>${item.site_selectionne.toUpperCase()}</b></p>
                <p style="margin: 4px 0 0 0; color:var(--text-secondary); font-size:11px;">Score Difficulté: <b style="color:${difficultyColor(item.score_final)}">${item.score_final}/15</b></p>
                <button onclick="zoomToAndSelectSite(${item.objectid})" style="margin-top: 8px; width: 100%; border: none; padding: 4px 8px; border-radius: 4px; background-color:var(--primary); color:#fff; font-size: 11px; font-weight:600; cursor:pointer;">
                    Voir la Fiche Site
                </button>
            </div>
        `;
        
        marker.bindPopup(popupContent);
        markersGroup.addLayer(marker);
    });
    
    // Zoom to show all active markers
    if (markersGroup.getLayers().length > 0) {
        map.fitBounds(markersGroup.getBounds().pad(0.1));
    }
}

// Helpers for color codes
function varColor(item) {
    if (item.site_selectionne === "oui") return "#10b981"; // green (selected)
    if (item.site_eligible === "oui") return "#fbbf24"; // yellow (eligible but not selected)
    return "#ef4444"; // red (ineligible/rejected)
}

function difficultyColor(score) {
    if (score <= 8) return "#34d399"; // easy (green)
    if (score <= 11) return "#fbbf24"; // medium (orange)
    return "#f87171"; // hard (red)
}

// Open storytelling, zoom and select site from map
window.zoomToAndSelectSite = function(objectid) {
    // Switch to storytelling view
    const storyNavItem = document.querySelector('.nav-item[data-view="storytelling"]');
    storyNavItem.click();
    
    // Select site
    selectSite(objectid);
};

// Render Dashboard Analytics charts
function updateCharts() {
    // Destroy previous charts to redraw
    if (charts.eligibility) charts.eligibility.destroy();
    if (charts.status) charts.status.destroy();
    
    const ctxElig = document.getElementById("chart-eligibility").getContext("2d");
    const ctxStat = document.getElementById("chart-status").getContext("2d");
    
    // Compute data
    const eligibleCount = filteredData.filter(item => item.site_eligible === "oui").length;
    const ineligibleCount = filteredData.length - eligibleCount;
    
    const selectedCount = filteredData.filter(item => item.site_selectionne === "oui").length;
    const rejectedCount = filteredData.length - selectedCount;
    
    // 1. Eligibility Doughnut
    charts.eligibility = new Chart(ctxElig, {
        type: 'doughnut',
        data: {
            labels: ['Éligible', 'Non Éligible'],
            datasets: [{
                data: [eligibleCount, ineligibleCount],
                backgroundColor: ['rgba(16, 185, 129, 0.7)', 'rgba(239, 68, 68, 0.7)'],
                borderColor: ['#10b981', '#ef4444'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#9ca3af', font: { family: 'Inter', size: 10 } }
                }
            }
        }
    });
    
    // 2. Selection Bar Chart
    charts.status = new Chart(ctxStat, {
        type: 'bar',
        data: {
            labels: ['Sélectionné (Oui)', 'Non Sélectionné'],
            datasets: [{
                label: 'Nombre de sites',
                data: [selectedCount, rejectedCount],
                backgroundColor: ['rgba(52, 211, 153, 0.7)', 'rgba(251, 191, 36, 0.7)'],
                borderColor: ['#34d399', '#fbbf24'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    ticks: { color: '#9ca3af', font: { family: 'Inter', size: 10 } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' }
                },
                y: {
                    ticks: { color: '#9ca3af', precision: 0 },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' }
                }
            }
        }
    });
}

// Populate Site sidebar in storytelling view
function populateSiteList() {
    const listContainer = document.getElementById("site-list-items");
    listContainer.innerHTML = "";
    
    if (filteredData.length === 0) {
        listContainer.innerHTML = '<div style="padding:16px; color:var(--text-muted); font-size:12px; text-align:center;">Aucun site trouvé</div>';
        return;
    }
    
    filteredData.forEach(item => {
        const itemEl = document.createElement("div");
        itemEl.className = "site-item";
        if (selectedSite && selectedSite.objectid === item.objectid) {
            itemEl.classList.add("active");
        }
        
        let badgeClass = "badge-rejected";
        let badgeLabel = "Rejeté";
        
        if (item.site_selectionne === "oui") {
            badgeClass = "badge-selected";
            badgeLabel = "Sélectionné";
        } else if (item.site_eligible === "oui") {
            badgeClass = "badge-eligible";
            badgeLabel = "Éligible";
        }
        
        itemEl.innerHTML = `
            <div class="site-item-title">
                <span>${item.nom_site}</span>
                <span class="site-badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="site-item-sub">${item.region_admin} - ${item.village} | Score: ${item.score_final}/15</div>
        `;
        
        itemEl.addEventListener("click", () => selectSite(item.objectid));
        listContainer.appendChild(itemEl);
    });
}

// Trigger selection of single site on storytelling panel
function selectSite(objectid) {
    selectedSite = surveyData.find(item => item.objectid === objectid);
    if (!selectedSite) return;
    
    // Highlight in list
    const items = document.querySelectorAll(".site-item");
    items.forEach(el => el.classList.remove("active"));
    
    // Search list container for selected index to apply active styling
    const index = filteredData.findIndex(item => item.objectid === objectid);
    if (index !== -1 && items[index]) {
        items[index].classList.add("active");
    }
    
    renderSiteDetails();
}

// Clear detail page
function clearStorytellingDetails() {
    selectedSite = null;
    document.getElementById("fiche-details-container").innerHTML = `
        <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:var(--text-muted); gap: 16px;">
            <span style="font-size: 48px;">📄</span>
            <p>Sélectionnez un site dans la liste de gauche pour visualiser sa fiche détaillée et son storytelling.</p>
        </div>
    `;
}

// Generate HTML structures for Site details
function renderSiteDetails() {
    const container = document.getElementById("fiche-details-container");
    const item = selectedSite;
    
    let statusBadge = `<span class="site-badge badge-rejected" style="font-size:14px; padding: 6px 14px;">Rejeté</span>`;
    if (item.site_selectionne === "oui") {
        statusBadge = `<span class="site-badge badge-selected" style="font-size:14px; padding: 6px 14px;">Sélectionné pour Restauration</span>`;
    } else if (item.site_eligible === "oui") {
        statusBadge = `<span class="site-badge badge-eligible" style="font-size:14px; padding: 6px 14px;">Éligible (Non Sélectionné)</span>`;
    }
    
    // Generate checklist of 10 eligibility criteria
    const criteriaMeta = [
        { key: "crit_1", num: "Critère 1", desc: "Anciennes rizières salinisées ou déboisées sans régénération." },
        { key: "crit_2", num: "Critère 2", desc: "Dans les aires protégées / périphériques du Parc de Cacheu ou Cantanhez." },
        { key: "crit_3", num: "Critère 3", desc: "Absence d'autre projet ou initiative de restauration concurrente." },
        { key: "crit_4", num: "Critère 4", desc: "Non classé comme « forêt » sur la carte de référence REDD+ 2011." },
        { key: "crit_5", num: "Critère 5", desc: "Abandonné depuis ≥ 2 ans, aucune activité agricole en cours/prévue." },
        { key: "crit_6", num: "Critère 6", desc: "Facteurs anthropiques créant une hydrologie défavorable." },
        { key: "crit_7", num: "Critère 7", desc: "Mangrove adulte inexistante ou extrêmement clairsemée." },
        { key: "crit_8", num: "Critère 8", desc: "Régénération naturelle absente ou très limitée sur le site." },
        { key: "crit_9", num: "Critère 9", desc: "Consentement Libre, Informé et Préalable (CLIP) signé." },
        { key: "crit_10", num: "Critère 10", desc: "Absence totale de litige sur la propriété ou l'accès foncier." }
    ];
    
    let checklistHtml = "";
    criteriaMeta.forEach(crit => {
        const value = item[crit.key];
        const isPass = String(value).toLowerCase() === "oui";
        const icon = isPass ? "✓" : "✗";
        const iconClass = isPass ? "pass" : "fail";
        const justif = item[`${crit.key}_justif`] || "";
        
        checklistHtml += `
            <div class="criteria-card">
                <div class="criteria-icon ${iconClass}">${icon}</div>
                <div class="criteria-body">
                    <div class="criteria-num">${crit.num}</div>
                    <div class="criteria-text">${crit.desc}</div>
                    ${justif ? `<div class="criteria-justification">${justif}</div>` : ""}
                </div>
            </div>
        `;
    });
    
    // Generate difficulty indicators
    const diffMeta = [
        { label: "Difficulté Technique", value: item.diff_technique, justif: item.diff_technique_justif, desc: "Digues, canaux, distance eau..." },
        { label: "Implication Communautaire", value: item.diff_communaute, justif: item.diff_communaute_justif, desc: "Main d'œuvre, adhésion locale..." },
        { label: "Accessibilité Géographique", value: item.diff_accessibilite, justif: item.diff_accessibilite_justif, desc: "Pistes d'accès, saisons, transports..." },
        { label: "Adéquation Taille", value: item.diff_taille, justif: item.diff_taille_justif, desc: "Taille du site vs logistique requise..." },
        { label: "Conditions Physico-Chimiques", value: item.diff_physicochimique, justif: item.diff_physicochimique_justif, desc: "Salinité, sol, pH, semences sources..." }
    ];
    
    let diffsHtml = "";
    diffMeta.forEach(diff => {
        let scoreClass = "filled-easy";
        if (diff.value === 2) scoreClass = "filled-medium";
        if (diff.value === 3) scoreClass = "filled-hard";
        
        diffsHtml += `
            <div class="diff-bar-item">
                <div class="diff-bar-label">
                    <span>${diff.label}</span>
                    <span style="font-weight:700;">${diff.value} / 3</span>
                </div>
                <div class="diff-bar-desc">${diff.desc}</div>
                <div class="diff-track">
                    <div class="diff-step ${diff.value >= 1 ? scoreClass : ''}"></div>
                    <div class="diff-step ${diff.value >= 2 ? scoreClass : ''}"></div>
                    <div class="diff-step ${diff.value >= 3 ? scoreClass : ''}"></div>
                </div>
                ${diff.justif ? `<p style="font-size:11px; color:var(--text-secondary); margin-top:2px; font-style:italic;">Note: ${diff.justif}</p>` : ""}
            </div>
        `;
    });
    
    // Narrative synthesis (storytelling description)
    const narrativeText = item.narrative || generateNarrative(item);
    
    // Before/After comparison images mockup
    // We display stylized placeholders or generate drawings using local files
    // Let's create an elegant visual compare panel
    
    container.innerHTML = `
        <div class="fiche-header">
            <div class="fiche-title-group">
                <h2>${item.nom_site}</h2>
                <div class="fiche-meta">
                    <span>📅 Date: <b>${item.date_mission}</b></span>
                    <span>📍 Localisation: <b>${item.region_admin} (${item.secteur_admin}, ${item.village})</b></span>
                </div>
            </div>
            <div>
                ${statusBadge}
            </div>
        </div>
        
        <!-- Storytelling Section -->
        <div class="fiche-section">
            <div class="section-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>📖 Histoire du Site & Synthèse de Sélection</span>
                <select id="storytelling-mode" class="form-select" style="padding: 4px 8px; font-size: 11px; width: auto; height: auto; margin: 0; background: var(--bg-card); border-color: var(--border-color); ${currentUser && currentUser.role === 'admin' ? '' : 'display: none;'}">
                    <option value="standard">Moteur Local (Correction + Fidèle)</option>
                    <option value="gemini">Assistant IA (Gemini 2.5 Flash)</option>
                    <option value="openai-mini">Assistant IA (ChatGPT gpt-4o-mini)</option>
                    <option value="openai-gpt4">Assistant IA (ChatGPT gpt-4o)</option>
                </select>
            </div>
            <div class="storytelling-narrative">
                <div class="narrative-title">Résumé exécutif & Enjeux du site</div>
                <p id="narrative-text-container" class="narrative-text">${narrativeText}</p>
                ${item.decision_commentaire ? `
                    <div style="margin-top:12px; padding:12px; background:rgba(0,0,0,0.2); border-left:4px solid var(--primary); border-radius:4px; font-size:13px; color:var(--text-primary)">
                        <b>Décision Finale :</b> ${item.decision_commentaire}
                    </div>
                ` : ""}
            </div>
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:24px;">
            <!-- Eligibility Checklist -->
            <div class="fiche-section">
                <div class="section-title">✅ Évaluation d'Éligibilité (${item.site_eligible === 'oui' ? 'Éligible' : 'Non Éligible'})</div>
                <div class="eligibility-checklist">
                    ${checklistHtml}
                </div>
            </div>
            
            <!-- Restorability difficulty -->
            <div class="fiche-section">
                <div class="section-title">📊 Index de Difficulté de Restauration (<span style="color:${difficultyColor(item.score_final)}">${item.score_final}/15</span>)</div>
                <div class="difficulty-bars">
                    ${diffsHtml}
                </div>
                <div style="margin-top:16px; background-color:rgba(0,0,0,0.1); border: 1px solid var(--border-color); padding: 16px; border-radius: 8px; font-size:12px; color:var(--text-secondary);">
                    <p style="font-weight:600; margin-bottom:4px; color:var(--text-primary);">Interprétation du score final :</p>
                    <ul style="margin-left: 16px; display:flex; flex-direction:column; gap:4px;">
                        <li><span style="color:#34d399; font-weight:700;">5 - 8 : Facile.</span> Les canaux se réparent aisément et la communauté est très investie.</li>
                        <li><span style="color:#fbbf24; font-weight:700;">9 - 11 : Moyen.</span> Quelques verrous techniques ou d'accessibilité à résoudre.</li>
                        <li><span style="color:#f87171; font-weight:700;">12 - 15 : Difficile.</span> Contraintes lourdes (salinité extrême, conflits d'accès ou éloignement majeur).</li>
                    </ul>
                </div>
            </div>
        </div>
    `;

    // Bind event listeners for IA Storyteller mode dropdown
    setTimeout(() => {
        const modeSelect = document.getElementById("storytelling-mode");
        if (modeSelect) {
            const currentMode = item.narrative_model || "standard";
            modeSelect.value = currentMode;
            
            modeSelect.addEventListener("change", (e) => {
                const newMode = e.target.value;
                loadAISubstitutedStory(item, newMode);
            });
        }
    }, 0);
}

// Clean common spelling & grammar errors from surveyor inputs
function cleanSpellingAndGrammar(text) {
    if (!text) return "";
    let cleaned = text.trim();
    
    const dictionary = [
        { regex: /a ét[eé]/g, replacement: "a été" },
        { regex: /ont ét[eé]/g, replacement: "ont été" },
        { regex: /ét[eé] abandonn[eé]/g, replacement: "été abandonné" },
        { regex: /\btecnique\b/gi, replacement: "technique" },
        { regex: /\btecniques\b/gi, replacement: "techniques" },
        { regex: /\bsens\b/gi, replacement: "sans" },
        { regex: /\bSens l'\b/g, replacement: "Sans l'" },
        { regex: /\bSens l'intervention\b/gi, replacement: "Sans l'intervention" },
        { regex: /\btr[o0]s\b/gi, replacement: "trop" },
        { regex: /\bbeacoub\b/gi, replacement: "beaucoup" },
        { regex: /\bbeacoud\b/gi, replacement: "beaucoup" },
        { regex: /\bbeacoud'autres\b/gi, replacement: "beaucoup d'autres" },
        { regex: /\bbeacoub de\b/gi, replacement: "beaucoup de" },
        { regex: /\bsuplimentaire\b/gi, replacement: "supplémentaire" },
        { regex: /\bsuplimentaires\b/gi, replacement: "supplémentaires" },
        { regex: /\beccessible\b/gi, replacement: "accessible" },
        { regex: /\banviron\b/gi, replacement: "environ" },
        { regex: /\bneveau\b/gi, replacement: "niveau" },
        { regex: /\bcana\b/gi, replacement: "canal" },
        { regex: /\bdesçandant\b/gi, replacement: "descendant" },
        { regex: /\bsint\b/gi, replacement: "sont" },
        { regex: /\bors\b/gi, replacement: "hors" },
        { regex: /\bclocal\b/gi, replacement: "local" },
        { regex: /\bconsantement\b/gi, replacement: "consentement" },
        { regex: /\bconsentiment\b/gi, replacement: "consentement" },
        { regex: /\baccuille\b/gi, replacement: "accueille" },
        { regex: /\bsute\b/gi, replacement: "site" },
        { regex: /\bsutes\b/gi, replacement: "sites" },
        { regex: /\baloigner\b/gi, replacement: "éloigné" },
        { regex: /\baloigners\b/gi, replacement: "éloignés" },
        { regex: /\bhydroligique\b/gi, replacement: "hydrologique" },
        { regex: /\bhydroligiques\b/gi, replacement: "hydrologiques" },
        { regex: /\bfacil\b/gi, replacement: "facile" },
        { regex: /\bfacils\b/gi, replacement: "faciles" },
        { regex: /\bactivé\b/gi, replacement: "activité" },
        { regex: /\bactivés\b/gi, replacement: "activités" },
        { regex: /\bcomlunauté\b/gi, replacement: "communauté" },
        { regex: /\bcomlunautés\b/gi, replacement: "communautés" },
        { regex: /\bcreusege\b/gi, replacement: "creusement" },
        { regex: /\bnecessaire\b/gi, replacement: "nécessaire" },
        { regex: /\bnecessaires\b/gi, replacement: "nécessaires" },
        { regex: /\bnecessite\b/gi, replacement: "nécessite" },
        { regex: /\bencache\b/gi, replacement: "encastre" },
        { regex: /\briziere\b/gi, replacement: "rizière" },
        { regex: /\briziere active\b/gi, replacement: "rizière active" },
        { regex: /\brizières actives\b/gi, replacement: "rizières actives" },
        { regex: /\bproximit[eé]\b/gi, replacement: "proximité" },
        { regex: /\bparipherie\b/gi, replacement: "périphérie" },
        { regex: /\bperipherie\b/gi, replacement: "périphérie" },
        { regex: /\bcenture\b/gi, replacement: "ceinture" },
        { regex: /\bcanaux vers le site\b/gi, replacement: "canaux vers le site" },
        { regex: /\bprés ou coté\b/gi, replacement: "près ou à côté" },
        { regex: /\bprés\b/gi, replacement: "près" },
        { regex: /\bcoté\b/gi, replacement: "côté" },
        { regex: /\bdispinible\b/gi, replacement: "disponible" },
        { regex: /\bdispinibles\b/gi, replacement: "disponibles" },
        { regex: /\bdesacorde\b/gi, replacement: "désaccord" },
        { regex: /\bconffirmée\b/gi, replacement: "confirmée" },
        { regex: /\bconffirmé\b/gi, replacement: "confirmé" },
        { regex: /\bleurs conffirmation\b/gi, replacement: "leur confirmation" },
        { regex: /\bmain d'ouevre\b/gi, replacement: "main d'œuvre" },
        { regex: /\bmain d'oeuvre\b/gi, replacement: "main d'œuvre" },
        { regex: /\bmotiver\b/gi, replacement: "motivée" },
        { regex: /\brapide\b/gi, replacement: "rapide" },
        { regex: /\brappide\b/gi, replacement: "rapide" },
        { regex: /\brepartition\b/gi, replacement: "répartition" },
        { regex: /\bsegregational\b/gi, replacement: "ségréguée" },
        { regex: /\bencien\b/gi, replacement: "ancien" },
        { regex: /\benciennes\b/gi, replacement: "anciennes" },
        { regex: /\bunpeu\b/gi, replacement: "un peu" },
        { regex: /\btraveaux\b/gi, replacement: "travaux" }
    ];
    
    dictionary.forEach(entry => {
        cleaned = cleaned.replace(entry.regex, entry.replacement);
    });
    
    if (cleaned.length > 0) {
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        if (!cleaned.endsWith(".") && !cleaned.endsWith("!") && !cleaned.endsWith("?")) {
            cleaned += ".";
        }
    }
    
    return cleaned;
}

// Generate Storytelling paragraphs using actual justifications from source data
function generateNarrative(site) {
    const region = site.region_admin;
    const sector = site.secteur_admin;
    const village = site.village;
    const name = site.nom_site;
    const eligible = site.site_eligible === "oui";
    const selected = site.site_selectionne === "oui";
    const score = site.score_final;
    
    let paragraph = `Le site <b>${name}</b>, situé dans le village de <b>${village}</b> (secteur de ${sector}, région de ${region}), a été inspecté lors de la mission de terrain. `;
    
    // Stitch justifications of critical criteria
    let critText = [];
    if (site.crit_1_justif) critText.push(cleanSpellingAndGrammar(site.crit_1_justif));
    if (site.crit_6_justif) critText.push(cleanSpellingAndGrammar(site.crit_6_justif));
    if (site.crit_7_justif) critText.push(cleanSpellingAndGrammar(site.crit_7_justif));
    if (site.crit_8_justif) critText.push(cleanSpellingAndGrammar(site.crit_8_justif));
    
    let socioText = [];
    if (site.crit_2_justif) socioText.push(`Localisation : ${cleanSpellingAndGrammar(site.crit_2_justif)}`);
    if (site.crit_3_justif) socioText.push(`Concurrence : ${cleanSpellingAndGrammar(site.crit_3_justif)}`);
    if (site.crit_5_justif) socioText.push(`Historique : ${cleanSpellingAndGrammar(site.crit_5_justif)}`);
    if (site.crit_9_justif) socioText.push(`Engagement social : ${cleanSpellingAndGrammar(site.crit_9_justif)}`);
    if (site.crit_10_justif) socioText.push(`Foncier : ${cleanSpellingAndGrammar(site.crit_10_justif)}`);
    
    if (eligible) {
        paragraph += `Ce site remplit <b>la totalité des 10 critères d'éligibilité réglementaires</b> du projet de restauration. `;
        if (critText.length > 0) {
            paragraph += `<br><br><b>Diagnostic écologique du terrain :</b> ${critText.join(" ")} `;
        }
        if (socioText.length > 0) {
            paragraph += `<br><br><b>Contexte social et foncier :</b> ${socioText.join(" ")} `;
        }
    } else {
        // Find failed criteria
        const fails = [];
        for (let i = 1; i <= 10; i++) {
            if (site[`crit_${i}`] !== "oui") {
                fails.push(`Critère ${i}`);
            }
        }
        paragraph += `L'évaluation a conclu que <b>ce site n'est pas éligible</b> en raison de la non-conformité de certains verrous majeurs : <b>${fails.join(', ')}</b>. `;
        
        let failedJustifs = [];
        for (let i = 1; i <= 10; i++) {
            if (site[`crit_${i}`] !== "oui" && site[`crit_${i}_justif`]) {
                failedJustifs.push(`<b>Critère ${i}</b> : ${cleanSpellingAndGrammar(site[`crit_${i}_justif`])}`);
            }
        }
        if (failedJustifs.length > 0) {
            paragraph += `<br><br><b>Justification de la non-éligibilité :</b><br>${failedJustifs.join("<br>")}`;
        }
    }
    
    // Difficulties
    let diffJustifs = [];
    if (site.diff_technique_justif) diffJustifs.push(`Technique : ${cleanSpellingAndGrammar(site.diff_technique_justif)}`);
    if (site.diff_communaute_justif) diffJustifs.push(`Communauté : ${cleanSpellingAndGrammar(site.diff_communaute_justif)}`);
    if (site.diff_accessibilite_justif) diffJustifs.push(`Accessibilité : ${cleanSpellingAndGrammar(site.diff_accessibilite_justif)}`);
    if (site.diff_taille_justif) diffJustifs.push(`Taille : ${cleanSpellingAndGrammar(site.diff_taille_justif)}`);
    if (site.diff_physicochimique_justif) diffJustifs.push(`Physico-chimie : ${cleanSpellingAndGrammar(site.diff_physicochimique_justif)}`);
    
    paragraph += `<br><br>Concernant la faisabilité technique et l'index de difficulté (évalué à <b>${score}/15</b>) : `;
    if (diffJustifs.length > 0) {
        paragraph += `${diffJustifs.join(" ")}`;
    } else {
        if (score <= 8) {
            paragraph += `le site présente une faisabilité optimale (Facile). Les travaux légers requis et l'implication de la communauté facilitent grandement l'intervention.`;
        } else if (score <= 11) {
            paragraph += `le site présente une difficulté modérée. Les verrous techniques ou d'accessibilité devront être suivis de près lors des travaux.`;
        } else {
            paragraph += `le site présente des contraintes logistiques et écologiques substantielles qui complexifient grandement le reboisement.`;
        }
    }
    
    // Final Selection summary
    if (selected) {
        paragraph += `<br><br><b>Décision stratégique :</b> Le site est <b>sélectionné pour la restauration active</b>.`;
    } else {
        paragraph += `<br><br><b>Décision stratégique :</b> Le site <b>n'est pas retenu</b> pour la restauration active.`;
    }
    
    return paragraph;
}

// Loads narrative from chosen AI Model or API via server-side generation
async function loadAISubstitutedStory(site, mode) {
    const textContainer = document.getElementById("narrative-text-container");
    if (!textContainer) return;
    
    textContainer.innerHTML = '<div style="display:flex; align-items:center; gap:8px;"><span class="loader"></span> Génération du récit avec l\'IA...</div>';
    
    try {
        const token = localStorage.getItem("auth_token");
        const response = await fetch(`/api/sites/${site.objectid}/regenerate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ mode: mode })
        });
        
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || "Erreur de régénération côté serveur");
        }
        
        const data = await response.json();
        const story = data.narrative;
        
        // Update in-memory data
        site.narrative = story;
        site.narrative_model = mode;
        const index = surveyData.findIndex(s => s.objectid === site.objectid);
        if (index !== -1) {
            surveyData[index].narrative = story;
            surveyData[index].narrative_model = mode;
        }
        
        textContainer.innerHTML = story.replace(/\n/g, "<br>");
    } catch (err) {
        console.error(err);
        textContainer.innerHTML = `
            <div style="color: var(--danger); padding: 12px; border: 1px dashed var(--danger); border-radius: 8px; font-size:12px; margin-top: 8px; background: rgba(248, 113, 113, 0.05);">
                ❌ Échec de génération IA : ${err.message}<br>
                <button onclick="document.getElementById('storytelling-mode').value='standard'; document.getElementById('narrative-text-container').innerHTML = generateNarrative(selectedSite);" class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px; margin-top:8px;">
                    Retourner au moteur local
                </button>
            </div>
        `;
    }
}

// Populate raw survey database table
function populateRawDataTable() {
    const tbody = document.getElementById("raw-data-body");
    tbody.innerHTML = "";
    
    if (surveyData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">Aucune donnée chargée</td></tr>';
        return;
    }
    
    surveyData.forEach(item => {
        const tr = document.createElement("tr");
        
        let statusText = "Non Éligible";
        let statusStyle = "color: var(--danger); font-weight:600;";
        if (item.site_selectionne === "oui") {
            statusText = "Sélectionné";
            statusStyle = "color: var(--success); font-weight:600;";
        } else if (item.site_eligible === "oui") {
            statusText = "Éligible";
            statusStyle = "color: var(--warning); font-weight:600;";
        }
        
        tr.innerHTML = `
            <td><b>${item.nom_site}</b></td>
            <td>${item.date_mission}</td>
            <td>${item.region_admin}</td>
            <td>${item.village}</td>
            <td style="${statusStyle}">${statusText}</td>
            <td><span style="font-weight:600; color:${difficultyColor(item.score_final)}">${item.score_final}/15</span></td>
            <td>
                <button onclick="zoomToAndSelectSite(${item.objectid})" class="btn btn-secondary" style="padding: 4px 8px; font-size:11px;">
                    Voir
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// User Management helpers (Admin only)
let editingUserId = null;

async function loadUsersList() {
    const tbody = document.getElementById("users-list-body");
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;"><span class="loader"></span> Chargement...</td></tr>';
    
    try {
        const token = localStorage.getItem("auth_token");
        const response = await fetch("/api/users", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        
        if (!response.ok) throw new Error("Impossible de charger les utilisateurs");
        
        const users = await response.json();
        tbody.innerHTML = "";
        
        users.forEach(u => {
            const tr = document.createElement("tr");
            
            let roleBadge = `<span class="site-badge badge-eligible">${u.role.toUpperCase()}</span>`;
            if (u.role === "admin") {
                roleBadge = `<span class="site-badge badge-selected">${u.role.toUpperCase()}</span>`;
            }
            
            const isSelf = u.username === currentUser.username;
            
            tr.innerHTML = `
                <td><b>${u.username}</b></td>
                <td>${roleBadge}</td>
                <td class="user-actions-cell"></td>
            `;
            
            const actionsCell = tr.querySelector(".user-actions-cell");
            if (isSelf) {
                actionsCell.innerHTML = `<span style="font-size:11px; color:var(--text-muted);">Administrateur Actif</span>`;
            } else {
                const editBtn = document.createElement("button");
                editBtn.className = "btn btn-secondary";
                editBtn.style.padding = "4px 8px";
                editBtn.style.fontSize = "11px";
                editBtn.style.marginRight = "8px";
                editBtn.textContent = "Modifier";
                editBtn.addEventListener("click", () => startEditUser(u.id, u.username, u.role));
                
                const deleteBtn = document.createElement("button");
                deleteBtn.className = "btn btn-secondary";
                deleteBtn.style.padding = "4px 8px";
                deleteBtn.style.fontSize = "11px";
                deleteBtn.style.color = "var(--danger)";
                deleteBtn.style.borderColor = "rgba(248,113,113,0.3)";
                deleteBtn.textContent = "Supprimer";
                deleteBtn.addEventListener("click", () => deleteUserAccount(u.id, u.username));
                
                actionsCell.appendChild(editBtn);
                actionsCell.appendChild(deleteBtn);
            }
            
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--danger);">❌ Erreur : ${err.message}</td></tr>`;
    }
}

async function createNewUser(e) {
    e.preventDefault();
    const usernameInput = document.getElementById("new-username");
    const passwordInput = document.getElementById("new-password");
    const roleInput = document.getElementById("new-role");
    const statusMsg = document.getElementById("create-user-status");
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    const role = roleInput.value;
    
    statusMsg.className = "kpi-desc text-secondary";
    statusMsg.innerHTML = editingUserId 
        ? '<span class="loader"></span> Enregistrement...' 
        : '<span class="loader"></span> Création...';
    
    try {
        const token = localStorage.getItem("auth_token");
        
        let url = "/api/users";
        let method = "POST";
        let bodyObj = { username, password, role };
        
        if (editingUserId) {
            url = `/api/users/${editingUserId}`;
            method = "PUT";
            bodyObj = { username, role };
            if (password) {
                bodyObj.password = password;
            }
        }
        
        const response = await fetch(url, {
            method: method,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify(bodyObj)
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || "Échec de l'opération");
        }
        
        statusMsg.className = "kpi-desc text-success";
        statusMsg.innerHTML = editingUserId 
            ? "✅ Utilisateur mis à jour avec succès !" 
            : "✅ Utilisateur créé avec succès !";
        
        cancelEditUser();
        loadUsersList();
        
        setTimeout(() => { statusMsg.innerHTML = ""; }, 3000);
    } catch (err) {
        statusMsg.className = "kpi-desc text-danger";
        statusMsg.innerHTML = `❌ Erreur : ${err.message}`;
    }
}

async function deleteUserAccount(id, username) {
    if (!confirm(`Voulez-vous vraiment supprimer l'utilisateur "${username}" ?`)) return;
    
    try {
        const token = localStorage.getItem("auth_token");
        const response = await fetch(`/api/users/${id}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${token}` }
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || "Échec de la suppression");
        }
        
        loadUsersList();
    } catch (err) {
        alert(`Erreur : ${err.message}`);
    }
}

function startEditUser(id, username, role) {
    editingUserId = id;
    
    document.getElementById("new-username").value = username;
    document.getElementById("new-password").value = "";
    document.getElementById("new-password").required = false; 
    document.getElementById("new-role").value = role;
    
    const titleEl = document.querySelector("#create-user-form").previousElementSibling;
    if (titleEl) titleEl.textContent = "Modifier l'Utilisateur";
    
    const submitBtn = document.querySelector("#create-user-form button[type='submit']");
    if (submitBtn) {
        submitBtn.innerHTML = "💾 Enregistrer les modifications";
    }
    
    let cancelBtn = document.getElementById("btn-cancel-edit");
    if (!cancelBtn) {
        cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.id = "btn-cancel-edit";
        cancelBtn.className = "btn btn-secondary";
        cancelBtn.style.marginTop = "8px";
        cancelBtn.style.width = "100%";
        cancelBtn.style.padding = "10px";
        cancelBtn.textContent = "❌ Annuler la modification";
        cancelBtn.addEventListener("click", cancelEditUser);
        
        document.getElementById("create-user-form").appendChild(cancelBtn);
    }
}

function cancelEditUser() {
    editingUserId = null;
    
    document.getElementById("new-username").value = "";
    document.getElementById("new-password").value = "";
    document.getElementById("new-password").required = true; 
    document.getElementById("new-role").value = "user";
    
    const titleEl = document.querySelector("#create-user-form").previousElementSibling;
    if (titleEl) titleEl.textContent = "Créer un Nouvel Utilisateur";
    
    const submitBtn = document.querySelector("#create-user-form button[type='submit']");
    if (submitBtn) {
        submitBtn.innerHTML = "➕ Créer l'utilisateur";
    }
    
    const cancelBtn = document.getElementById("btn-cancel-edit");
    if (cancelBtn) cancelBtn.remove();
    
    document.getElementById("create-user-status").innerHTML = "";
}

// Bind to window for compatibility
window.deleteUserAccount = deleteUserAccount;
window.startEditUser = startEditUser;
window.cancelEditUser = cancelEditUser;

// Database View Grid & Export helpers
function populateDatabaseFilterOptions() {
    const regionSelect = document.getElementById("db-filter-region");
    const villageSelect = document.getElementById("db-filter-village");
    if (!regionSelect || !villageSelect) return;

    const currentRegion = regionSelect.value;
    const currentVillage = villageSelect.value;

    // Get unique regions
    const regions = [...new Set(surveyData.map(item => item.region_admin))].filter(Boolean).sort();
    regionSelect.innerHTML = '<option value="">Toutes les régions</option>';
    regions.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r;
        regionSelect.appendChild(opt);
    });
    if (regions.includes(currentRegion)) {
        regionSelect.value = currentRegion;
    } else {
        regionSelect.value = "";
    }

    // Get unique villages
    const villages = [...new Set(surveyData.map(item => item.village))].filter(Boolean).sort();
    villageSelect.innerHTML = '<option value="">Tous les villages</option>';
    villages.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        villageSelect.appendChild(opt);
    });
    if (villages.includes(currentVillage)) {
        villageSelect.value = currentVillage;
    } else {
        villageSelect.value = "";
    }
}

function applyDatabaseFilters() {
    const siteInput = document.getElementById("db-filter-site");
    const regionSelect = document.getElementById("db-filter-region");
    const villageSelect = document.getElementById("db-filter-village");
    
    if (!siteInput || !regionSelect || !villageSelect) return;
    
    const siteVal = siteInput.value.trim().toLowerCase();
    const regionVal = regionSelect.value;
    const villageVal = villageSelect.value;
    
    dbFilteredData = surveyData.filter(item => {
        if (siteVal && (!item.nom_site || !item.nom_site.toLowerCase().includes(siteVal))) {
            return false;
        }
        if (regionVal && item.region_admin !== regionVal) {
            return false;
        }
        if (villageVal && item.village !== villageVal) {
            return false;
        }
        return true;
    });
    
    populateDatabaseTable();
}

function resetDatabaseFilters() {
    const siteInput = document.getElementById("db-filter-site");
    const regionSelect = document.getElementById("db-filter-region");
    const villageSelect = document.getElementById("db-filter-village");
    
    if (siteInput) siteInput.value = "";
    if (regionSelect) regionSelect.value = "";
    if (villageSelect) villageSelect.value = "";
    
    applyDatabaseFilters();
}

function populateDatabaseTable() {
    const tbody = document.getElementById("db-table-body");
    if (!tbody) return;
    
    tbody.innerHTML = "";
    
    if (dbFilteredData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="41" style="text-align:center; color:var(--text-muted);">Aucune donnée ne correspond aux filtres</td></tr>';
        return;
    }
    
    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
    
    dbFilteredData.forEach(item => {
        const tr = document.createElement("tr");
        
        let eligibleBadge = item.site_eligible === "oui" ? `<span class="site-badge badge-selected">Oui</span>` : `<span class="site-badge badge-rejected">Non</span>`;
        let selectedBadge = item.site_selectionne === "oui" ? `<span class="site-badge badge-selected">Oui</span>` : `<span class="site-badge badge-rejected">Non</span>`;
        
        tr.innerHTML = `
            <td><b>${item.objectid}</b></td>
            <td><b>${escapeHTML(item.nom_site)}</b></td>
            <td>${escapeHTML(item.date_mission)}</td>
            <td>${escapeHTML(item.region_admin)}</td>
            <td>${escapeHTML(item.secteur_admin)}</td>
            <td>${escapeHTML(item.village)}</td>
            
            <!-- Criteria 1 to 10 with Justifications -->
            <td>${item.crit_1 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_1_justif)}">${escapeHTML(item.crit_1_justif) || '-'}</td>
            <td>${item.crit_2 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_2_justif)}">${escapeHTML(item.crit_2_justif) || '-'}</td>
            <td>${item.crit_3 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_3_justif)}">${escapeHTML(item.crit_3_justif) || '-'}</td>
            <td>${item.crit_4 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_4_justif)}">${escapeHTML(item.crit_4_justif) || '-'}</td>
            <td>${item.crit_5 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_5_justif)}">${escapeHTML(item.crit_5_justif) || '-'}</td>
            <td>${item.crit_6 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_6_justif)}">${escapeHTML(item.crit_6_justif) || '-'}</td>
            <td>${item.crit_7 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_7_justif)}">${escapeHTML(item.crit_7_justif) || '-'}</td>
            <td>${item.crit_8 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_8_justif)}">${escapeHTML(item.crit_8_justif) || '-'}</td>
            <td>${item.crit_9 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_9_justif)}">${escapeHTML(item.crit_9_justif) || '-'}</td>
            <td>${item.crit_10 === 'oui' ? 'Oui' : 'Non'}</td>
            <td title="${escapeHTML(item.crit_10_justif)}">${escapeHTML(item.crit_10_justif) || '-'}</td>
            
            <!-- Difficulties with Justifications -->
            <td>${item.diff_technique || 0}/3</td>
            <td title="${escapeHTML(item.diff_technique_justif)}">${escapeHTML(item.diff_technique_justif) || '-'}</td>
            <td>${item.diff_communaute || 0}/3</td>
            <td title="${escapeHTML(item.diff_communaute_justif)}">${escapeHTML(item.diff_communaute_justif) || '-'}</td>
            <td>${item.diff_accessibilite || 0}/3</td>
            <td title="${escapeHTML(item.diff_accessibilite_justif)}">${escapeHTML(item.diff_accessibilite_justif) || '-'}</td>
            <td>${item.diff_taille || 0}/3</td>
            <td title="${escapeHTML(item.diff_taille_justif)}">${escapeHTML(item.diff_taille_justif) || '-'}</td>
            <td>${item.diff_physicochimique || 0}/3</td>
            <td title="${escapeHTML(item.diff_physicochimique_justif)}">${escapeHTML(item.diff_physicochimique_justif) || '-'}</td>
            
            <td>${eligibleBadge}</td>
            <td>${selectedBadge}</td>
            <td title="${escapeHTML(item.decision_commentaire)}">${escapeHTML(item.decision_commentaire) || '-'}</td>
            <td>${item.latitude}</td>
            <td>${item.longitude}</td>
        `;
        
        tbody.appendChild(tr);
    });
}

function exportToCSV() {
    if (dbFilteredData.length === 0) {
        alert("Aucune donnée à exporter.");
        return;
    }
    
    const headers = [
        "ID", "Nom du Site", "Date de Mission", "Région", "Secteur", "Village",
        "Anciennes rizières salinisées ou déboisées sans régénération (C1)", "Justification C1",
        "Dans PN Cacheu/Cantanhez ou périphérie (C2)", "Justification C2",
        "Absence de projet de restauration concurrent (C3)", "Justification C3",
        "Non classé comme « forêt » REDD+ 2011 (C4)", "Justification C4",
        "Abandonné >= 2 ans (aucune activité agricole) (C5)", "Justification C5",
        "Hydrologie défavorable créée par l'homme (C6)", "Justification C6",
        "Mangrove adulte inexistante ou très clairsemée (C7)", "Justification C7",
        "Régénération naturelle absente ou limitée (C8)", "Justification C8",
        "Consentement CLIP signé par la communauté (C9)", "Justification C9",
        "Absence de litige foncier ou d'accès (C10)", "Justification C10",
        "Diff Technique", "Commentaire Technique",
        "Diff Communauté", "Commentaire Communauté",
        "Diff Accessibilité", "Commentaire Accessibilité",
        "Diff Taille", "Commentaire Taille",
        "Diff Physicochimique", "Commentaire Physicochimique",
        "Éligible", "Sélectionné", "Commentaire Décision",
        "Latitude", "Longitude"
    ];
    
    const rows = dbFilteredData.map(item => [
        item.objectid,
        item.nom_site || '',
        item.date_mission || '',
        item.region_admin || '',
        item.secteur_admin || '',
        item.village || '',
        item.crit_1 === 'oui' ? 'Oui' : 'Non', item.crit_1_justif || '',
        item.crit_2 === 'oui' ? 'Oui' : 'Non', item.crit_2_justif || '',
        item.crit_3 === 'oui' ? 'Oui' : 'Non', item.crit_3_justif || '',
        item.crit_4 === 'oui' ? 'Oui' : 'Non', item.crit_4_justif || '',
        item.crit_5 === 'oui' ? 'Oui' : 'Non', item.crit_5_justif || '',
        item.crit_6 === 'oui' ? 'Oui' : 'Non', item.crit_6_justif || '',
        item.crit_7 === 'oui' ? 'Oui' : 'Non', item.crit_7_justif || '',
        item.crit_8 === 'oui' ? 'Oui' : 'Non', item.crit_8_justif || '',
        item.crit_9 === 'oui' ? 'Oui' : 'Non', item.crit_9_justif || '',
        item.crit_10 === 'oui' ? 'Oui' : 'Non', item.crit_10_justif || '',
        item.diff_technique || 0, item.diff_technique_justif || '',
        item.diff_communaute || 0, item.diff_communaute_justif || '',
        item.diff_accessibilite || 0, item.diff_accessibilite_justif || '',
        item.diff_taille || 0, item.diff_taille_justif || '',
        item.diff_physicochimique || 0, item.diff_physicochimique_justif || '',
        item.site_eligible === 'oui' ? 'Oui' : 'Non',
        item.site_selectionne === 'oui' ? 'Oui' : 'Non',
        item.decision_commentaire || '',
        item.latitude || '',
        item.longitude || ''
    ]);
    
    const csvContent = [
        headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(";"),
        ...rows.map(row => row.map(val => {
            const strVal = val === null || val === undefined ? "" : String(val);
            return `"${strVal.replace(/"/g, '""')}"`;
        }).join(";"))
    ].join("\n");
    
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Greenchoice_Donnees_Mangroves_${new Date().toISOString().slice(0,10)}.csv`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportToXLS() {
    if (dbFilteredData.length === 0) {
        alert("Aucune donnée à exporter.");
        return;
    }
    
    const headers = [
        "ID", "Nom du Site", "Date de Mission", "Région", "Secteur", "Village",
        "Anciennes rizières salinisées ou déboisées sans régénération (C1)", "Justification C1",
        "Dans PN Cacheu/Cantanhez ou périphérie (C2)", "Justification C2",
        "Absence de projet de restauration concurrent (C3)", "Justification C3",
        "Non classé comme « forêt » REDD+ 2011 (C4)", "Justification C4",
        "Abandonné >= 2 ans (aucune activité agricole) (C5)", "Justification C5",
        "Hydrologie défavorable créée par l'homme (C6)", "Justification C6",
        "Mangrove adulte inexistante ou très clairsemée (C7)", "Justification C7",
        "Régénération naturelle absente ou limitée (C8)", "Justification C8",
        "Consentement CLIP signé par la communauté (C9)", "Justification C9",
        "Absence de litige foncier ou d'accès (C10)", "Justification C10",
        "Diff Technique", "Commentaire Technique",
        "Diff Communauté", "Commentaire Communauté",
        "Diff Accessibilité", "Commentaire Accessibilité",
        "Diff Taille", "Commentaire Taille",
        "Diff Physicochimique", "Commentaire Physicochimique",
        "Éligible", "Sélectionné", "Commentaire Décision",
        "Latitude", "Longitude"
    ];
    
    const rows = dbFilteredData.map(item => [
        item.objectid,
        item.nom_site || '',
        item.date_mission || '',
        item.region_admin || '',
        item.secteur_admin || '',
        item.village || '',
        item.crit_1 === 'oui' ? 'Oui' : 'Non', item.crit_1_justif || '',
        item.crit_2 === 'oui' ? 'Oui' : 'Non', item.crit_2_justif || '',
        item.crit_3 === 'oui' ? 'Oui' : 'Non', item.crit_3_justif || '',
        item.crit_4 === 'oui' ? 'Oui' : 'Non', item.crit_4_justif || '',
        item.crit_5 === 'oui' ? 'Oui' : 'Non', item.crit_5_justif || '',
        item.crit_6 === 'oui' ? 'Oui' : 'Non', item.crit_6_justif || '',
        item.crit_7 === 'oui' ? 'Oui' : 'Non', item.crit_7_justif || '',
        item.crit_8 === 'oui' ? 'Oui' : 'Non', item.crit_8_justif || '',
        item.crit_9 === 'oui' ? 'Oui' : 'Non', item.crit_9_justif || '',
        item.crit_10 === 'oui' ? 'Oui' : 'Non', item.crit_10_justif || '',
        item.diff_technique || 0, item.diff_technique_justif || '',
        item.diff_communaute || 0, item.diff_communaute_justif || '',
        item.diff_accessibilite || 0, item.diff_accessibilite_justif || '',
        item.diff_taille || 0, item.diff_taille_justif || '',
        item.diff_physicochimique || 0, item.diff_physicochimique_justif || '',
        item.site_eligible === 'oui' ? 'Oui' : 'Non',
        item.site_selectionne === 'oui' ? 'Oui' : 'Non',
        item.decision_commentaire || '',
        item.latitude || '',
        item.longitude || ''
    ]);
    
    let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
    html += '<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Mangroves Data</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>';
    html += '<body><table border="1">';
    
    html += '<tr>';
    headers.forEach(h => {
        html += `<th style="background-color: #10b981; color: white; font-weight: bold;">${h}</th>`;
    });
    html += '</tr>';
    
    rows.forEach(row => {
        html += '<tr>';
        row.forEach(val => {
            const strVal = val === null || val === undefined ? "" : String(val);
            html += `<td>${strVal}</td>`;
        });
        html += '</tr>';
    });
    
    html += '</table></body></html>';
    
    const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Greenchoice_Donnees_Mangroves_${new Date().toISOString().slice(0,10)}.xls`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
