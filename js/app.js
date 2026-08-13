/**
 * FlotaControl v2.0 - Core Application Logic
 */

// Import data modules
import { initDB } from './data/database.js';
import { initUploadUI } from './ui/upload.js';
import { renderCards } from './ui/cards.js';
import { renderDashboard } from './ui/dashboard.js';
import { openConfigModal } from './ui/config.js';
import { initAIChat } from './ai/chat.js';
import { renderDataTable, saveDBRow } from './ui/datatable.js';
import * as Exporter from './export/exporter.js';

// Application State (UI runtime state)
export const AppState = {
    currentView: 'upload',
    filesQueue: [], // Files waiting to be processed
    dateFilter: {
        from: null,
        to: null
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    console.log("FlotaControl v2.0 Initializing...");
    
    // 1. Initialize Database
    try {
        await initDB();
        console.log("IndexedDB initialized successfully.");
    } catch (e) {
        console.error("Failed to initialize database:", e);
        alert("Error crítico: No se pudo inicializar la base de datos local.");
    }

    // 2. Setup UI Components
    setupNavigation();
    initUploadUI();
    
    // 3. Setup AI Panel Toggle and Config
    setupAIPanel();
    initAIChat();
    
    document.getElementById('btn-config').addEventListener('click', openConfigModal);

    // 4. Expose globals for inline events
    window.exportUnitToPDF = Exporter.exportUnitToPDF;
    window.exportTableToXLSX = Exporter.exportTableToXLSX;
    window.showDataTable = renderDataTable;
    window.saveDBRow = saveDBRow;
});

function setupNavigation() {
    const navButtons = document.querySelectorAll('.app-nav button');
    const views = document.querySelectorAll('.view-section');

    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Update active button
            navButtons.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');

            // Determine target view
            const targetViewId = e.currentTarget.id.replace('nav-', 'view-');
            AppState.currentView = targetViewId.replace('view-', '');

            // Hide all views, show target
            views.forEach(v => {
                if (v.id === targetViewId) {
                    v.classList.add('active');
                    v.classList.remove('hidden');
                } else {
                    v.classList.remove('active');
                    v.classList.add('hidden');
                }
            });

            // Re-render if navigating to cards
            if (AppState.currentView === 'cards') {
                renderCards();
            } else if (AppState.currentView === 'dashboard') {
                renderDashboard();
            }
        });
    });
}

function setupAIPanel() {
    const aiPanel = document.getElementById('ai-panel');
    const aiHeader = aiPanel?.querySelector('.ai-header');
    const toggleBtn = aiPanel?.querySelector('#btn-toggle-ai');
    
    if (aiHeader && aiPanel && toggleBtn) {
        aiHeader.addEventListener('click', () => {
            aiPanel.classList.toggle('collapsed');
            const icon = toggleBtn.querySelector('i');
            if (icon) {
                if (aiPanel.classList.contains('collapsed')) {
                    icon.classList.replace('fa-chevron-up', 'fa-chevron-down');
                } else {
                    icon.classList.replace('fa-chevron-down', 'fa-chevron-up');
                }
            }
            console.log("AI Panel toggled. Collapsed:", aiPanel.classList.contains('collapsed'));
        });
        console.log("AI Panel click handler attached successfully");
    } else {
        console.warn("AI Panel elements not found. aiHeader:", !!aiHeader, "aiPanel:", !!aiPanel, "toggleBtn:", !!toggleBtn);
    }
}
