// Synapse Content Script Initialized
// Note: Interceptor injection removed to ensure compatibility with Brave/Security Shields.
// Sync is now 100% manual via the UI.

const BACKEND_URL = "http://127.0.0.1:8000";

// Generate a content hash for deduplication (replaces Python's server-side MD5)
async function simpleHash(str) {
    const msgBuffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function cleanTitle(title) {
    return title.replace(' - Claude', '').replace(' - ChatGPT', '').trim();
}

function showSynapseToast(message, type = 'info') {
    let toastContainer = document.getElementById('synapse-toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'synapse-toast-container';
        document.body.appendChild(toastContainer);
    }
    
    const toast = document.createElement('div');
    toast.className = `synapse-toast synapse-toast-${type}`;
    
    const icon = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
    
    toast.innerHTML = `
        <span class="synapse-toast-icon">${icon}</span>
        <span class="synapse-toast-msg">${message}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showSynapseConfirm(message) {
    return new Promise((resolve) => {
        let container = document.getElementById('synapse-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'synapse-toast-container';
            document.body.appendChild(container);
        }
        
        const confirmBox = document.createElement('div');
        confirmBox.className = `synapse-toast synapse-toast-warning`;
        // Make it interactive
        confirmBox.style.pointerEvents = 'auto';
        
        confirmBox.innerHTML = `
            <span class="synapse-toast-msg" style="margin-right: 15px;">${message}</span>
            <button id="synapse-confirm-yes" style="background: #ef4444; color: white; border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; margin-right: 5px;">Yes</button>
            <button id="synapse-confirm-no" style="background: rgba(255,255,255,0.1); color: white; border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;">No</button>
        `;
        
        container.appendChild(confirmBox);
        setTimeout(() => confirmBox.classList.add('show'), 10);
        
        const cleanup = (result) => {
            confirmBox.classList.remove('show');
            setTimeout(() => confirmBox.remove(), 300);
            resolve(result);
        };
        
        confirmBox.querySelector('#synapse-confirm-yes').addEventListener('click', () => cleanup(true));
        confirmBox.querySelector('#synapse-confirm-no').addEventListener('click', () => cleanup(false));
    });
}

// Bypass Content Security Policy (CSP) by sending requests through the background worker
async function apiCall(endpoint, method, body) {
    let action = "api_fetch";
    let messageBody = {};
    
    // Route to new cloud pipeline in background.js
    if (endpoint === '/ingest' && method === 'POST') {
        action = 'ingest_chunks';
        // Generate content_hash client-side (replaces Python's server-side hash)
        const hash = await simpleHash(body.content);
        let source = 'chatgpt';
        if (window.location.hostname.includes('claude')) source = 'claude';
        else if (window.location.hostname.includes('deepseek')) source = 'deepseek';
        const chunk = { ...body, content_hash: hash, source: source };
        messageBody = { chunks: [chunk] }; // Always send as array
    } else if (endpoint === '/retrieve' && method === 'POST') {
        action = 'retrieve_context';
        messageBody = { prompt: body.prompt, session_id: body.session_id };
    } else if (endpoint.startsWith('/sessions') && method === 'GET') {
        action = 'fetch_sessions';
    } else if (endpoint === '/sessions' && method === 'DELETE') {
        action = 'delete_session';
        messageBody = { session_id: body.session_id };
    } else {
        // Legacy fallback
        messageBody = {
            url: `${BACKEND_URL}${endpoint}`,
            options: {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : null
            }
        };
    }

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action, ...messageBody }, response => {
            if (response && response.success) resolve(response.data || {});
            else reject(response ? response.error : "Unknown error");
        });
    });
}

window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'CONTEXT_BRIDGE_API_INTERCEPT') {
        processInterceptedData(event.data.url, event.data.data);
    }
});

function processInterceptedData(url, rawData) {
    // Auto-ingestion disabled as per user request.
    // Manual upload via "Upload to Memory" button is now the only way to sync.
}

// --- UI INJECTION ---
console.log("SYNAPSE: Content script loaded on", window.location.hostname);

if (window.location.hostname.includes('chatgpt.com') || 
    window.location.hostname.includes('claude.ai') || 
    window.location.hostname.includes('chat.openai.com') ||
    window.location.hostname.includes('gemini.google.com') ||
    window.location.hostname.includes('deepseek.com')) {
    
    // Aggressive MutationObserver to fight React wiping the DOM
    const observer = new MutationObserver((mutations) => {
        if (document.body && !document.getElementById('synapse-ui-container')) {
            console.log("SYNAPSE: DOM changed, injecting UI...");
            injectUI();
        }
    });
    
    // Start observing as soon as body is available
    const startObserver = setInterval(() => {
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
            injectUI();
            clearInterval(startObserver);
        }
    }, 100);

    window.addEventListener('load', injectUI);
}

function injectUI() {
    if (document.getElementById('synapse-ui-container')) return; 
    
    const container = document.createElement('div');
    container.id = 'synapse-ui-container';
    container.style.cssText = 'position:fixed !important; bottom:30px !important; right:30px !important; z-index:2147483647 !important; width:40px !important; height:40px !important; display:block !important; visibility:visible !important; opacity:1 !important; pointer-events:auto !important;';
    container.innerHTML = `
        <div id="synapse-fab" style="width:40px !important; height:40px !important; border-radius:50% !important; background:#1a1a2e !important; color:#fff !important; font-size:22px !important; display:flex !important; align-items:center !important; justify-content:center !important; cursor:grab !important; box-shadow:0 4px 12px rgba(0,0,0,0.5) !important; border:1.5px solid rgba(255,255,255,0.3) !important; position:relative !important; z-index:2 !important; visibility:visible !important; opacity:1 !important;"><span style="line-height: 0; position: relative; top: -1px;">∞</span></div>
        <div id="synapse-panel" class="hidden">
            <div class="synapse-header" style="justify-content: space-between;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="synapse-logo">∞</span>
                    <span style="font-weight: 600; letter-spacing: 2px;">SYNAPSE</span>
                </div>
                <div id="synapse-auth-status" style="display: flex; gap: 5px;">
                    <span class="synapse-spinner" style="width: 10px; height: 10px;"></span>
                </div>
            </div>
            
            <div id="synapse-auth-overlay" style="display: none; flex-direction: column; gap: 8px; margin-top: 10px; margin-bottom: 5px;">
                <button id="synapse-login-github" class="synapse-btn" style="background: rgba(255,255,255,0.08); color: white; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                    Continue with GitHub
                </button>
                <button id="synapse-login-google" class="synapse-btn" style="background: rgba(255,255,255,0.08); color: white; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                    Continue with Google
                </button>
                <div style="font-size: 10px; color: rgba(255,255,255,0.4); text-align: center; margin-top: 5px;">
                    Built with ❤️ by Geervan
                </div>
            </div>

            <div id="synapse-main-ui" style="display: block;">
                <div style="position: relative; width: 100%;">
                    <input type="text" id="synapse-search" placeholder="Search chats..." class="synapse-input" style="margin-bottom: 5px; padding: 6px 12px;">
                    <div id="synapse-search-dropdown" class="synapse-dropdown-menu hidden" style="top: calc(100% - 5px); margin-bottom: 10px; padding: 0;">
                        <div id="synapse-search-list" class="synapse-list" style="max-height: 200px; margin-bottom: 0;"></div>
                    </div>
                </div>
                <div style="display: flex; gap: 5px; margin-bottom: 10px;">
                    <select id="synapse-session-select" class="synapse-input" style="margin-bottom: 0; flex: 1;">
                        <option value="">Select memory...</option>
                    </select>
                    <button id="synapse-delete-btn" class="synapse-btn" style="padding: 0 10px; margin-bottom: 0; width: auto;" title="Delete selected chat">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                    </button>
                </div>
                <div style="display: flex; gap: 5px; margin-bottom: 5px;">
                    <button id="synapse-inject-btn" class="synapse-btn" style="flex: 1; padding: 10px 0; background: #ffffff; color: #000000; box-shadow: 0 4px 14px rgba(255,255,255,0.1);">
                        Inject Context
                    </button>
                </div>
                <button id="synapse-force-btn" class="synapse-btn" style="margin-top: 5px;">
                    Upload to Memory
                </button>
            </div>
        </div>
    `;
    
    const savedPos = localStorage.getItem('synapse-pos');
    if (savedPos) {
        const pos = JSON.parse(savedPos);
        // Bounds check — never let the button go off-screen
        const maxX = window.innerWidth - 50;
        const maxY = window.innerHeight - 50;
        const safeX = Math.max(0, Math.min(pos.x, maxX));
        const safeY = Math.max(0, Math.min(pos.y, maxY));
        container.style.bottom = 'auto';
        container.style.right = 'auto';
        container.style.left = safeX + 'px';
        container.style.top = safeY + 'px';
    }

    document.body.appendChild(container);
    
    const fab = document.getElementById('synapse-fab');
    const panel = document.getElementById('synapse-panel');
    const injectBtn = document.getElementById('synapse-inject-btn');
    const forceBtn = document.getElementById('synapse-force-btn');
    const searchInput = document.getElementById('synapse-search');
    const searchDropdown = document.getElementById('synapse-search-dropdown');
    const selectEl = document.getElementById('synapse-session-select');
    const deleteBtn = document.getElementById('synapse-delete-btn');
    let uploadInProgress = false;
    let hasKey = false;
    
    // Auth UI elements
    const authStatus = document.getElementById('synapse-auth-status');
    const authOverlay = document.getElementById('synapse-auth-overlay');
    const mainUI = document.getElementById('synapse-main-ui');
    const btnLoginGoogle = document.getElementById('synapse-login-google');
    const btnLoginGithub = document.getElementById('synapse-login-github');
    let setupUI = document.getElementById('synapse-setup-ui');
    if (!setupUI) {
        setupUI = document.createElement('div');
        setupUI.id = 'synapse-setup-ui';
        setupUI.style.display = 'none';
        mainUI.parentElement.insertBefore(setupUI, mainUI);
    }

    async function checkAuth() {
        authStatus.innerHTML = '<span class="synapse-spinner" style="width: 10px; height: 10px;"></span>';
        try {
            const data = await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'get_auth' }, resolve));
            if (data && data.user) {
                const storage = await new Promise(r => chrome.storage.local.get(['synapse_encryption_key'], r));
                hasKey = !!storage.synapse_encryption_key;

                const userEmail = data.user.email || "Logged in";
                authStatus.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <button id="synapse-key-mgmt-btn" title="Manage Encryption & Sync" style="background: transparent; border: none; padding: 4px; cursor: pointer; color: ${hasKey ? '#a1a1aa' : '#fbbf24'}; display: flex; align-items: center; transition: color 0.2s;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"></path></svg>
                        </button>
                        <span style="color: #10b981; font-size: 10px; display: inline-flex; align-items: center; margin-right: 4px;" title="${userEmail}">●</span>
                        <button id="synapse-logout-btn" title="Logout (${userEmail})" style="background: transparent; border: none; padding: 4px; cursor: pointer; color: #a1a1aa; display: flex; align-items: center; transition: color 0.2s;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                        </button>
                    </div>
                    <div id="synapse-key-portal" class="hidden" hidden aria-hidden="true" style="display: none; position: absolute; top: 56px; left: 18px; right: 18px; background: #0d0d12; backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 16px; box-shadow: 0 20px 45px rgba(0,0,0,0.62); z-index: 100;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px;">
                            <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 1.2px;">Key Management</div>
                            <button id="synapse-close-portal-btn" title="Close" style="width: 28px; height: 28px; min-width: 28px; padding: 0; border-radius: 7px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.06); color: #a1a1aa; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; line-height: 1;">&times;</button>
                        </div>
                        
                        <div style="font-size: 12px; color: rgba(255,255,255,0.62); margin-bottom: 16px; line-height: 1.5;">
                            Paste your key from another device below to instantly decrypt your memories.
                        </div>

                        <button id="synapse-copy-key-btn" class="synapse-btn" style="width: 100%; padding: 11px 14px; font-size: 12px; background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.28); margin-bottom: 16px; display: flex; gap: 10px;">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            Copy Current Key
                        </button>

                        <div style="font-size: 11px; color: #6b7280; margin-bottom: 9px;">Sync from Another Device</div>
                        <input type="text" id="synapse-import-key-input" placeholder="Paste external key..." class="synapse-input" style="font-size: 12px; margin-bottom: 14px; background: rgba(0,0,0,0.24);">
                        
                        <div style="display: flex;">
                            <button id="synapse-save-key-btn" class="synapse-btn" style="width: 100%; padding: 10px 14px; font-size: 12px; background: #ffffff; color: #000;">Update & Unlock</button>
                        </div>
                    </div>
                `;
                
                const mgmtBtn = document.getElementById('synapse-key-mgmt-btn');
                const portal = document.getElementById('synapse-key-portal');
                const importInput = document.getElementById('synapse-import-key-input');
                let keyPortalOpen = false;

                const setKeyPortalOpen = (open) => {
                    keyPortalOpen = open;
                    portal.classList.toggle('hidden', !open);
                    portal.hidden = !open;
                    portal.setAttribute('aria-hidden', String(!open));
                    panel.style.zIndex = open ? '4' : '1';
                    fab.style.setProperty('display', open ? 'none' : 'flex', 'important');
                    fab.style.setProperty('opacity', open ? '0' : '1', 'important');
                    fab.style.setProperty('pointer-events', open ? 'none' : 'auto', 'important');
                    portal.style.setProperty('display', open ? 'flex' : 'none', 'important');
                    if (open) {
                        portal.style.setProperty('flex-direction', 'column', 'important');
                    }
                };

                setKeyPortalOpen(false);

                mgmtBtn.addEventListener('click', () => {
                    setKeyPortalOpen(!keyPortalOpen);
                });
                
                const keyColor = hasKey ? '#a1a1aa' : '#fbbf24';
                mgmtBtn.addEventListener('mouseenter', () => mgmtBtn.style.color = '#10b981');
                mgmtBtn.addEventListener('mouseleave', () => mgmtBtn.style.color = keyColor);

                const logoutBtn = document.getElementById('synapse-logout-btn');
                logoutBtn.addEventListener('mouseenter', () => logoutBtn.style.color = '#ef4444');
                logoutBtn.addEventListener('mouseleave', () => logoutBtn.style.color = '#a1a1aa');

                document.getElementById('synapse-copy-key-btn').addEventListener('click', () => {
                    chrome.storage.local.get(['synapse_encryption_key'], (result) => {
                        if (result.synapse_encryption_key) {
                            navigator.clipboard.writeText(result.synapse_encryption_key).then(() => {
                                showSynapseToast("Key copied to clipboard!", "success");
                            });
                        } else {
                            showSynapseToast("Key not found!", "error");
                        }
                    });
                });

                document.getElementById('synapse-close-portal-btn').addEventListener('click', () => setKeyPortalOpen(false));

                document.getElementById('synapse-save-key-btn').addEventListener('click', async () => {
                    const newKey = importInput.value.trim();
                    if (!newKey) return;
                    
                    await chrome.storage.local.set({ synapse_encryption_key: newKey });
                    showSynapseToast("link updated!", "success");
                    setKeyPortalOpen(false);
                    importInput.value = '';
                    checkAuth(); 
                });
                document.getElementById('synapse-logout-btn').addEventListener('click', async () => {
                    authStatus.innerHTML = '<span class="synapse-spinner" style="width: 10px; height: 10px;"></span>';
                    await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'oauth_logout' }, resolve));
                    checkAuth();
                });
                if (!hasKey) {
                    setupUI.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 30px 20px; min-height: 200px;">
                            <div style="font-size: 32px; margin-bottom: 16px; filter: drop-shadow(0 0 10px rgba(251, 191, 36, 0.3));">🔑</div>
                            <div style="font-weight: 600; font-size: 16px; margin-bottom: 8px; color: #fff; letter-spacing: -0.01em;">Setup Encryption</div>
                            <div style="font-size: 12px; color: rgba(255,255,255,0.5); margin-bottom: 24px; line-height: 1.6; max-width: 220px;">
                                You're on a new browser. To access your memories, you need your encryption key.
                            </div>
                            
                            <button id="synapse-setup-import-btn" class="synapse-btn" style="width: 100%; max-width: 220px; background: #ffffff; color: #000; font-weight: 500; border-radius: 8px; padding: 12px; margin-bottom: 12px; transition: transform 0.2s;">
                                I have a key (Import)
                            </button>
                            
                            <div style="font-size: 10px; color: rgba(255,255,255,0.2); margin: 8px 0; text-transform: uppercase; letter-spacing: 1px;">or</div>
                            
                            <button id="synapse-setup-generate-btn" class="synapse-btn" style="width: 100%; max-width: 220px; background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; font-size: 11px; transition: all 0.2s;">
                                I'm new (Generate Fresh)
                            </button>
                        </div>
                    `;
                    document.getElementById('synapse-setup-import-btn').addEventListener('click', () => setKeyPortalOpen(true));
                    document.getElementById('synapse-setup-generate-btn').addEventListener('click', async () => {
                        const confirm = await showSynapseConfirm("Generate a fresh key? Old memories won't be readable.");
                        if (confirm) {
                            chrome.runtime.sendMessage({ action: 'generate_new_key' }, () => {
                                showSynapseToast("Fresh key generated!", "success");
                                checkAuth();
                            });
                        }
                    });
                    setupUI.style.display = 'block';
                    mainUI.style.display = 'none';
                } else {
                    setupUI.style.display = 'none';
                    mainUI.style.display = 'block';
                    fetchSessions();
                }
                authOverlay.style.display = 'none';
            } else {
                hasKey = false;
                authStatus.innerHTML = `<span style="color: #ef4444; font-size: 10px; display: inline-flex; align-items: center;">●</span>`;
                authOverlay.style.display = 'flex';
                mainUI.style.display = 'none';
            }
        } catch (e) {
            hasKey = false;
            authStatus.innerHTML = `<span style="color: #ef4444; font-size: 10px; display: inline-flex; align-items: center;">●</span>`;
            authOverlay.style.display = 'flex';
            mainUI.style.display = 'none';
        }
    }

    async function handleLogin(provider) {
        authStatus.innerHTML = 'Connecting...';
        try {
            const data = await new Promise(resolve => chrome.runtime.sendMessage({ action: 'oauth_login', provider }, resolve));
            if (data && data.success) {
                showSynapseToast("Login successful!", "success");
                checkAuth();
            } else {
                showSynapseToast(data?.error || "Login failed", "error");
                checkAuth();
            }
        } catch(e) {
            showSynapseToast(e.message || "Login failed", "error");
            checkAuth();
        }
    }

    btnLoginGoogle.addEventListener('click', () => handleLogin('google'));
    btnLoginGithub.addEventListener('click', () => handleLogin('github'));
    
    let isDragging = false;
    let dragTimeout;

    searchInput.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        if (q.length > 0) {
            searchDropdown.classList.remove('hidden');
            const filtered = allSessions.filter(s => (s.title || s.id).toLowerCase().includes(q));
            renderSearchAutocomplete(filtered);
        } else {
            searchDropdown.classList.add('hidden');
        }
    });

    searchInput.addEventListener('focus', (e) => {
        if (e.target.value.length > 0) searchDropdown.classList.remove('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#synapse-search') && !e.target.closest('#synapse-search-dropdown')) {
            if (searchDropdown) searchDropdown.classList.add('hidden');
        }
    });

    selectEl.addEventListener('change', (e) => {
        localStorage.setItem('synapse_last_session', e.target.value);
    });

    deleteBtn.addEventListener('click', async () => {
        const sid = selectEl.value;
        if (!sid) return showSynapseToast("Select a chat to delete", "error");
        
        const isConfirmed = await showSynapseConfirm("Delete this memory permanently?");
        if (isConfirmed) {
            deleteBtn.disabled = true;
            deleteBtn.innerHTML = `<span class="synapse-spinner" style="margin-right: 0;"></span>`;
            await apiCall('/sessions', 'DELETE', { session_id: sid });
            localStorage.removeItem('synapse_last_session');
            if (hasKey) await fetchSessions();
            deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
            deleteBtn.disabled = false;
            showSynapseToast("Memory deleted.", "success");
        }
    });

    fab.addEventListener('mousedown', () => {
        isDragging = false;
        dragTimeout = setTimeout(() => isDragging = true, 150);
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            e.preventDefault();
            container.style.bottom = 'auto';
            container.style.right = 'auto';
            container.style.left = (e.clientX - 20) + 'px';
            container.style.top = (e.clientY - 20) + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        clearTimeout(dragTimeout);
        if (isDragging) {
            const rect = container.getBoundingClientRect();
            localStorage.setItem('synapse-pos', JSON.stringify({x: rect.left, y: rect.top}));
            setTimeout(() => isDragging = false, 100); 
        }
    });
    
    fab.addEventListener('click', (e) => {
        if (isDragging) return; 
        
        const rect = container.getBoundingClientRect();
        const vW = window.innerWidth;
        const vH = window.innerHeight;
        
        panel.style.top = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = 'auto';
        panel.style.right = 'auto';
        
        let originY = '';
        let originX = '';

        if (rect.top > vH / 2) {
            panel.style.bottom = '45px'; 
            originY = 'bottom';
        } else {
            panel.style.top = '45px'; 
            originY = 'top';
        }

        if (rect.left > vW / 2) {
            panel.style.right = '0'; 
            originX = 'right';
        } else {
            panel.style.left = '0'; 
            originX = 'left';
        }
        
        panel.style.transformOrigin = `${originY} ${originX}`;
        
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            checkAuth(); // This will fetch sessions if authed
        }
    });
    
    forceBtn.addEventListener('click', async () => {
        forceBtn.innerText = "Reading...";
        // Expanded selectors for Gemini and DeepSeek
        let textBlocks = document.querySelectorAll('.font-claude-message, [data-message-author-role], .prose, .markdown, .message-content, .ds-markdown');
        let sessionId = window.location.pathname;
        if (sessionId === "/") sessionId = "New Chat";
        
        let textsToIngest = [];
        const synapseUI = document.getElementById('synapse-ui-container');
        if (synapseUI) synapseUI.style.display = 'none';

        let rawChunks = [];
        if (textBlocks.length > 0) {
            textBlocks.forEach(b => {
                let text = b.innerText || b.textContent;
                rawChunks.push(...text.split(/\n\s*\n/));
            });
        } else {
            let navs = document.querySelectorAll('nav, aside, [role="navigation"]');
            navs.forEach(n => n.style.display = 'none'); 
            
            let chatContainer = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
            rawChunks = chatContainer.innerText.split(/\n\s*\n/);
            
            navs.forEach(n => n.style.display = ''); 
        }
        
        const ignoreList = ['Claude is AI', 'Sonnet', 'Share', 'Copy', 'Read frontend design skill'];
        let cleanedParagraphs = [];
        
        for (let p of rawChunks) {
            let text = p.trim();
            if (text.length < 20) continue;
            
            let skip = false;
            for (let ignore of ignoreList) {
                if (text.includes(ignore)) skip = true;
            }
            if (skip) continue;
            cleanedParagraphs.push(text);
        }
        
        // Group paragraphs into ~1200 char chunks (Best granularity)
        let groupedChunks = [];
        let currentChunk = "";
        
        for (let text of cleanedParagraphs) {
            if (currentChunk.length + text.length > 1200) {
                if (currentChunk) {
                    groupedChunks.push(currentChunk);
                }
                currentChunk = text;
            } else {
                currentChunk += (currentChunk ? "\n\n" : "") + text;
            }
        }
        if (currentChunk.length > 0) groupedChunks.push(currentChunk);
        
        textsToIngest = groupedChunks;
        if (synapseUI) synapseUI.style.display = 'flex';

        let count = 0;
        let batchChunks = [];
        let source = 'chatgpt';
        if (window.location.hostname.includes('claude')) source = 'claude';
        else if (window.location.hostname.includes('deepseek')) source = 'deepseek';
        
        for (let text of textsToIngest) {
            if (text && text.trim().length > 5) {
                const hash = await simpleHash(text);
                batchChunks.push({
                    session_id: sessionId,
                    session_title: cleanTitle(document.title) || "New Chat",
                    source: source,
                    content: text,
                    content_hash: hash
                });
                count++;
            }
        }

        if (batchChunks.length > 0) {
            uploadInProgress = true;
            forceBtn.disabled = true;
            forceBtn.innerHTML = `<span class="synapse-spinner" style="margin-right: 6px;"></span> Syncing 0/${batchChunks.length}`;
            // Safety fallback: if completion event is missed, reset after 90s
            const syncFallback = setTimeout(() => {
                if (uploadInProgress) {
                    uploadInProgress = false;
                    forceBtn.disabled = false;
                    forceBtn.innerText = "Upload to Memory";
                    if (hasKey) fetchSessions();
                    showSynapseToast("Sync finished in background (fallback).", "info");
                }
            }, 90000);
            try {
                await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: 'ingest_chunks', chunks: batchChunks }, response => {
                        if (response && response.success) resolve(response);
                        else reject(response ? response.error : "Unknown error");
                    });
                });
                showSynapseToast(`Syncing ${batchChunks.length} chunks to cloud...`, "info");
                
                // Poll for completion instead of relying on broadcasts
                const pollInterval = setInterval(() => {
                    chrome.runtime.sendMessage({ action: 'check_sync_status' }, response => {
                        if (response && response.done) {
                            clearInterval(pollInterval);
                            clearTimeout(syncFallback);
                            uploadInProgress = false;
                            forceBtn.disabled = false;
                            forceBtn.innerText = "Upload to Memory";
                            if (hasKey) fetchSessions();
                            showSynapseToast(`Successfully saved ${response.count} chunks!`, "success");
                        } else if (response && response.progress) {
                            forceBtn.innerHTML = `<span class="synapse-spinner" style="margin-right: 6px;"></span> Syncing ${response.progress.current}/${response.progress.total}`;
                        }
                    });
                }, 3000);
                window.__synapseSyncFallback = syncFallback;
            } catch (e) {
                console.error("Synapse Upload Error:", e);
                uploadInProgress = false;
                forceBtn.disabled = false;
                forceBtn.innerText = "Upload failed!";
                clearTimeout(syncFallback);
            }
        } else {
            forceBtn.innerText = "Nothing to save";
        }
        
        if (!uploadInProgress) {
            setTimeout(() => { forceBtn.innerText = "Upload to Memory"; }, 2000);
        }
    });

    async function handleInjection(mode) {
        const sessionId = document.getElementById('synapse-session-select').value;
        if (!sessionId) return showSynapseToast("Please select a session to inject.", "error");
        
        const textarea = document.getElementById('prompt-textarea') || 
                         document.querySelector('textarea[placeholder*="DeepSeek"]') ||
                         document.querySelector('div[contenteditable="true"]') ||
                         document.querySelector('textarea');

        if (!textarea) return showSynapseToast("Text box not found on this page.", "error");
        
        const originalText = injectBtn.innerText;
        injectBtn.innerText = "Retrieving...";
        
        let promptText = textarea.value || textarea.innerText || textarea.textContent || "";
        
        try {
            const data = await apiCall('/retrieve', 'POST', { 
                session_id: sessionId, 
                prompt: promptText, 
                mode: mode 
            });
            
            if (data.context) {
                const scrubbedPrompt = promptText.replace(/\[Context from Previous AI:[\s\S]*?\]\n\n/g, "");
                const finalStr = `[Context from Previous AI:\n${data.context}\n]\n\n${scrubbedPrompt}`;
                
                if (textarea.tagName === 'TEXTAREA') {
                    textarea.value = finalStr;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                    textarea.innerText = finalStr;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
                panel.classList.add('hidden');
                showSynapseToast(`Context injected!`, "success");
            } else {
                showSynapseToast("No relevant context found.", "error");
            }
        } catch (e) {
            showSynapseToast("Decryption failed. Check your Key in the Portal", "error");
        }
        injectBtn.innerText = originalText;
    }

    injectBtn.addEventListener('click', () => handleInjection('hybrid'));
}

    let allSessions = [];
    function renderSessions(sessionsToRender) {
        const select = document.getElementById('synapse-session-select');
        const savedSession = localStorage.getItem('synapse_last_session');
        if (!select) return;
        select.innerHTML = '';
        
        if (sessionsToRender.length === 0) {
            select.innerHTML = '<option value="">No memory found</option>';
            return;
        }
        
        select.innerHTML = '<option value="">Select memory...</option>';
        sessionsToRender.forEach(session => {
            const opt = document.createElement('option');
            opt.value = session.id;
            opt.textContent = session.title || session.id;
            select.appendChild(opt);
        });
        
        if (savedSession && sessionsToRender.some(s => s.id === savedSession)) {
            select.value = savedSession;
        }
    }

    function renderSearchAutocomplete(sessionsToRender) {
        const list = document.getElementById('synapse-search-list');
        if (!list) return;
        list.innerHTML = '';
        
        if (sessionsToRender.length === 0) {
            list.innerHTML = '<div style="padding: 10px; text-align: center; color: #888; font-size: 12px;">No memory found</div>';
            return;
        }
        
        sessionsToRender.forEach(session => {
            const item = document.createElement('div');
            item.className = 'synapse-list-item';
            
            const title = document.createElement('span');
            title.className = 'synapse-item-title';
            title.textContent = session.title || session.id;
            title.title = session.title || session.id;
            
            const delBtn = document.createElement('button');
            delBtn.className = 'synapse-item-delete';
            delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
            
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const isConfirmed = await showSynapseConfirm("Delete this memory permanently?");
                if (isConfirmed) {
                    delBtn.disabled = true;
                    delBtn.innerHTML = `<span class="synapse-spinner" style="margin-right: 0;"></span>`;
                    await apiCall('/sessions', 'DELETE', { session_id: session.id });
                    if (localStorage.getItem('synapse_last_session') === session.id) {
                        localStorage.removeItem('synapse_last_session');
                    }
                    if (hasKey) await fetchSessions();
                    document.getElementById('synapse-search').dispatchEvent(new Event('input'));
                    showSynapseToast("Memory deleted.", "success");
                }
            });
            
            item.addEventListener('click', () => {
                const selectEl = document.getElementById('synapse-session-select');
                if (selectEl) {
                    selectEl.value = session.id;
                    localStorage.setItem('synapse_last_session', session.id);
                }
                const dropdown = document.getElementById('synapse-search-dropdown');
                if (dropdown) dropdown.classList.add('hidden');
                
                const searchInput = document.getElementById('synapse-search');
                if (searchInput) searchInput.value = '';
            });
            
            item.appendChild(title);
            item.appendChild(delBtn);
            list.appendChild(item);
        });
    }

    async function fetchSessions() {
        try {
            const data = await apiCall(`/sessions?_t=${Date.now()}`, 'GET');
            if (data.sessions) {
                allSessions = data.sessions;
                renderSessions(allSessions);
            }
        } catch (error) {}
    }

// Listen for cross-tab sync broadcasts
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'refresh_sessions') {
        fetchSessions();
    } else if (request.action === 'upload_progress') {
        if (uploadInProgress && forceBtn) {
            forceBtn.disabled = true;
            if (request.phase === 'loading') {
                forceBtn.innerHTML = `<span class="synapse-spinner" style="margin-right: 6px;"></span> Loading model...`;
            } else {
                forceBtn.innerHTML = `<span class="synapse-spinner" style="margin-right: 6px;"></span> Syncing ${request.current}/${request.total}`;
            }
        }
    } else if (request.action === 'upload_complete' || request.action === 'sync_complete') {
        uploadInProgress = false;
        if (window.__synapseSyncFallback) {
            clearTimeout(window.__synapseSyncFallback);
            window.__synapseSyncFallback = null;
        }
        if (forceBtn) {
            forceBtn.disabled = false;
            forceBtn.innerText = "Upload to Memory";
        }
        if (hasKey) fetchSessions();
        showSynapseToast(`Successfully finished saving ${request.count} chunks!`, "success");
    } else if (request.action === 'upload_error' || request.action === 'sync_error') {
        uploadInProgress = false;
        if (forceBtn) {
            forceBtn.disabled = false;
            forceBtn.innerText = "Upload failed!";
        }
        showSynapseToast(`Memory sync failed: ${request.error}`, "error");
    } else if (request.action === 'auth_changed') {
        checkAuth();
    }
});
// Data-Saver Realtime: Only listen for changes when the sidebar is actually open
let realtimeChannel = null;

function connectRealtime() {
    if (realtimeChannel) return; // Already connected
    
    console.log("SYNAPSE: Data-Saver Realtime Connected (Sidebar Open).");
    chrome.runtime.sendMessage({ action: 'subscribe_deletes' });
}

function disconnectRealtime() {
    if (!realtimeChannel) return;
    
    console.log("SYNAPSE: Data-Saver Realtime Disconnected (Sidebar Closed).");
    chrome.runtime.sendMessage({ action: 'unsubscribe_deletes' });
    realtimeChannel = null;
}

// Monitor the sidebar visibility to manage the connection
const observer = new MutationObserver(() => {
    const panel = document.getElementById('synapse-sidebar');
    if (panel && panel.classList.contains('show')) {
        connectRealtime();
    } else {
        disconnectRealtime();
    }
});

// Start observing when the panel is injected
function startVisibilityObserver() {
    const panel = document.getElementById('synapse-sidebar');
    if (panel) {
        observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
        // Initial check
        if (panel.classList.contains('show')) connectRealtime();
    }
}

// Listen for the Sync Pulse from background.js
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'refresh_sessions' || request.action === 'refresh_ui') {
        console.log("SYNAPSE: Sync Pulse received! Instant sync triggered.");
        fetchSessions();
    }
});

// Pulse Check: Refresh whenever the user switches back to this tab
window.addEventListener('focus', () => {
    console.log("SYNAPSE: Tab focused. Performing Pulse Check...");
    fetchSessions();
});

// Initialize observer
setTimeout(startVisibilityObserver, 2000);
