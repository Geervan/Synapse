import { createClient } from '@supabase/supabase-js';

// ==========================================
// 1. SUPABASE CONFIG (User MUST fill these in)
// ==========================================
const SUPABASE_URL = 'YOUR_SUPABASE_URL_HERE';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY_HERE';

// Only init if keys are provided
let supabase = null;

// Custom Storage Adapter for Manifest V3 Service Worker (localStorage doesn't exist here)
const chromeStorageAdapter = {
    getItem: (key) => new Promise(resolve => chrome.storage.local.get([key], res => resolve(res[key] || null))),
    setItem: (key, value) => new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve)),
    removeItem: (key) => new Promise(resolve => chrome.storage.local.remove([key], resolve))
};

if (SUPABASE_URL !== 'YOUR_SUPABASE_URL_HERE') {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            storage: chromeStorageAdapter,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false
        }
    });
}

let realtimeChannel = null;

// Sync progress tracking (for polling from content script)
let syncStatus = { done: true, count: 0, progress: null };

// ==========================================
// 2. OFFSCREEN DOCUMENT FOR EMBEDDINGS
// ==========================================
let creatingOffscreen = null;

async function ensureOffscreen() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (existingContexts.length > 0) return;
    
    if (creatingOffscreen) {
        await creatingOffscreen;
    } else {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['WORKERS'],
            justification: 'Run Transformers.js for embedding generation'
        });
        await creatingOffscreen;
        creatingOffscreen = null;
    }
    // Wait for the offscreen script to actually load and register its listener
    await new Promise(resolve => setTimeout(resolve, 1500));
}

// Stable embedding with retry to handle transient IPC failures
async function getEmbedding(text, retries = 3) {
    await ensureOffscreen();
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'generate_embedding', text }, response => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.success) {
                        resolve(response.embedding);
                    } else {
                        reject(new Error(response?.error || 'Embedding failed'));
                    }
                });
            });
            return result;
        } catch (e) {
            if (attempt < retries - 1) {
                console.warn(`Embedding attempt ${attempt + 1} failed, retrying...`, e.message);
                await new Promise(r => setTimeout(r, 1000));
                // Force re-check offscreen doc
                creatingOffscreen = null;
                await ensureOffscreen();
            } else {
                throw e;
            }
        }
    }
}

async function getEmbeddingWithTimeout(text, timeoutMs = 60000) {
    return Promise.race([
        getEmbedding(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Embedding timeout')), timeoutMs))
    ]);
}

// RAM Cache for high-speed operations
let cachedEncryptionKey = null;
let cachedUser = null;

async function getEncryptionKey() {
    if (cachedEncryptionKey) return cachedEncryptionKey;
    return new Promise((resolve) => {
        chrome.storage.local.get(['synapse_encryption_key'], async (result) => {
            let key;
            if (result.synapse_encryption_key) {
                const keyBuffer = Uint8Array.from(atob(result.synapse_encryption_key), c => c.charCodeAt(0));
                key = await crypto.subtle.importKey('raw', keyBuffer, 'AES-GCM', true, ['encrypt', 'decrypt']);
            } else {
                key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
                const exported = await crypto.subtle.exportKey('raw', key);
                const exportedBase64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
                chrome.storage.local.set({ synapse_encryption_key: exportedBase64 });
            }
            cachedEncryptionKey = key;
            resolve(key);
        });
    });
}

async function encryptText(text) {
    if (!text) return text;
    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, encoded);
    
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return 'E2EE:' + btoa(String.fromCharCode(...combined));
}

async function decryptText(encryptedStr) {
    if (!encryptedStr || !encryptedStr.startsWith('E2EE:')) return encryptedStr;
    try {
        const key = await getEncryptionKey();
        const combined = Uint8Array.from(atob(encryptedStr.substring(5)), c => c.charCodeAt(0));
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ciphertext);
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        return "[Decryption Error]";
    }
}
// Regex Compressor
function compressContext(text) {
    let codeBlocks = [];
    
    // Protect code blocks
    text = text.replace(/```[\s\S]*?```/g, match => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });
    text = text.replace(/`[^`]+`/g, match => {
        codeBlocks.push(match);
        return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // Strip fillers and noise
    const fillers = [
        "basically", "actually", "just", "really", "simply", "obviously", 
        "clearly", "essentially", "i think", "i believe", "i mean", 
        "you know", "let me know", "feel free", "if you want", "if you need",
        "that being said", "having said that", "at the end of the day"
    ];
    for (const filler of fillers) {
        text = text.replace(new RegExp(`\\b${filler}\\b`, 'gi'), '');
    }

    // Strip stopwords
    const stopwords = ["the", "a", "an", "very", "quite", "rather", "furthermore", "moreover"];
    for (const word of stopwords) {
        text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
    }

    // Collapse spaces and dedup lines safely
    text = text.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    
    let result = text.trim();
    // Restore code blocks
    for (let i = 0; i < codeBlocks.length; i++) {
        result = result.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
    }
    
    return result;
}

// ==========================================
// 4. AUTHENTICATION (Centered OAuth Popup)
// ==========================================
async function authenticate(provider) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectUrl)}`;
    
    return new Promise((resolve, reject) => {
        // Get the current window to center relative to it
        chrome.windows.getLastFocused({ populate: false }, (currentWin) => {
            const width = 500;
            const height = 620;
            
            // Calculate center relative to the browser window
            let left = 100;
            let top = 100;
            
            if (currentWin && currentWin.width && currentWin.height) {
                left = Math.round(currentWin.left + (currentWin.width / 2) - (width / 2));
                top = Math.round(currentWin.top + (currentWin.height / 2) - (height / 2));
            }

            chrome.windows.create({
                url: authUrl,
                type: 'popup',
                width: width,
                height: height,
                left: Math.max(0, left),
                top: Math.max(0, top)
            }, (window) => {
            const tabId = window.tabs[0].id;
            
            // Listen for the redirect URL
            const listener = async (updatedTabId, changeInfo, tab) => {
                if (updatedTabId === tabId && changeInfo.url && changeInfo.url.includes('access_token=')) {
                    chrome.tabs.onUpdated.removeListener(listener);
                    
                    try {
                        const hash = new URL(changeInfo.url).hash;
                        const params = new URLSearchParams(hash.substring(1));
                        const access_token = params.get('access_token');
                        const refresh_token = params.get('refresh_token');
                        
                        if (access_token && refresh_token) {
                            const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
                            if (error) throw error;
                            chrome.windows.remove(window.id);
                            resolve(data.user);
                        }
                    } catch (err) {
                        chrome.windows.remove(window.id);
                        reject(err.message);
                    }
                }
            };
            
            chrome.tabs.onUpdated.addListener(listener);
        });
    });
});
}

// Helper for broadcasting to all tabs
function broadcast(action, payload = {}) {
    chrome.tabs.query({}, function(tabs) {
        for (let tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { action, ...payload }).catch(() => {});
        }
    });
}

// ==========================================
// 5. MESSAGE LISTENER
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // --- 1. Realtime Subscriptions ---
    if (request.action === 'subscribe_deletes') {
        if (supabase && !realtimeChannel) {
            realtimeChannel = supabase
                .channel('synapse-deletes')
                .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chunks' }, (payload) => {
                    console.log('SYNAPSE: Deletion detected in cloud!', payload);
                    chrome.tabs.query({}, (tabs) => {
                        tabs.forEach(tab => {
                            chrome.tabs.sendMessage(tab.id, { action: 'refresh_ui' }).catch(() => {});
                        });
                    });
                })
                .subscribe();
        }
        sendResponse({ success: true });
        return false;
    }
    
    if (request.action === 'unsubscribe_deletes') {
        if (realtimeChannel) {
            realtimeChannel.unsubscribe();
            realtimeChannel = null;
        }
        sendResponse({ success: true });
        return false;
    }

    // --- 2. Legacy / Compatibility ---
    if (request.action === 'api_fetch') {
        const bustedUrl = request.url + (request.url.includes('?') ? '&' : '?') + '_t=' + Date.now();
        fetch(bustedUrl, request.options)
            .then(res => res.json())
            .then(data => sendResponse({success: true, data: data}))
            .catch(err => sendResponse({success: false, error: err.toString()}));
        return true;
    }
    
    // --- 3. Auth Pipeline ---
    if (request.action === 'get_auth') {
        if (!supabase) return sendResponse({success: false, error: "Supabase not configured"});
        supabase.auth.getUser().then(({ data, error }) => {
            if (error || !data.user) sendResponse({ success: true, user: null });
            else sendResponse({ success: true, user: data.user });
        }).catch(err => sendResponse({ success: true, user: null }));
        return true;
    }

    if (request.action === 'oauth_login') {
        authenticate(request.provider)
            .then(user => sendResponse({ success: true, user }))
            .catch(err => sendResponse({ success: false, error: err.toString() }));
        return true;
    }

    if (request.action === 'oauth_logout' || request.action === 'sign_out') {
        if (!supabase) return sendResponse({ success: false, error: "Supabase not configured" });
        supabase.auth.signOut().then(() => {
            cachedUser = null;
            // Notify all tabs that auth state has changed
            broadcast('auth_changed', { user: null });
            sendResponse({ success: true });
        }).catch(err => {
            console.error("SYNAPSE: Signout error", err);
            sendResponse({ success: false, error: err.toString() });
        });
        return true;
    }
    
    // --- 4. Sync / Ingestion ---
    if (request.action === 'check_sync_status') {
        sendResponse(syncStatus);
        return false;
    }
    
    if (request.action === 'ingest_chunks') {
        if (!supabase) return sendResponse({success: false, error: "Supabase not configured"});
        syncStatus = { done: false, count: 0, progress: null };
        sendResponse({success: true, status: "async_started"});
        
        (async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) throw new Error("Please log in to upload memory");
                
                const allHashes = request.chunks.map(c => c.content_hash);
                const { data: existingHashes } = await supabase
                    .from('chunks')
                    .select('content_hash')
                    .in('content_hash', allHashes)
                    .eq('user_id', user.id);
                
                const existingSet = new Set(existingHashes?.map(h => h.content_hash) || []);
                const newChunks = request.chunks.filter(c => !existingSet.has(c.content_hash));
                
                if (newChunks.length === 0) {
                    syncStatus = { done: true, count: 0, progress: null };
                    broadcast("upload_complete", { count: 0 });
                    return;
                }

                const chunksWithEmbeddings = [];
                const CONCURRENCY = 5;
                let processed = 0;
                const total = newChunks.length;
                
                broadcast('upload_progress', { current: 0, total, phase: 'loading' });
                for (let k = 0; k < newChunks.length; k += CONCURRENCY) {
                    const batch = newChunks.slice(k, k + CONCURRENCY);
                    const results = await Promise.all(batch.map(async (chunk) => {
                        const safeContent = chunk.content.toWellFormed ? chunk.content.toWellFormed() : chunk.content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|([^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
                        const embedding = await getEmbeddingWithTimeout(safeContent);
                        const encryptedContent = await encryptText(safeContent);
                        const encryptedTitle = await encryptText(chunk.session_title);
                        
                        return {
                            user_id: user.id,
                            session_id: chunk.session_id,
                            session_title: encryptedTitle,
                            source: chunk.source,
                            content: encryptedContent,
                            content_hash: chunk.content_hash,
                            embedding: embedding
                        };
                    }));
                    chunksWithEmbeddings.push(...results);
                    processed += batch.length;
                    syncStatus.progress = { current: processed, total };
                    broadcast('upload_progress', { current: processed, total, phase: 'embedding' });
                }
                
                for (let i = 0; i < chunksWithEmbeddings.length; i += 50) {
                    const batch = chunksWithEmbeddings.slice(i, i + 50);
                    const { error } = await supabase.from('chunks').upsert(batch, { ignoreDuplicates: true });
                    if (error) {
                        for (const item of batch) {
                            const { error: singleErr } = await supabase.from('chunks').insert([item]);
                            if (singleErr && singleErr.code !== '23505') throw singleErr;
                        }
                    }
                }
                
                syncStatus = { done: true, count: chunksWithEmbeddings.length, progress: null };
                broadcast("upload_complete", { count: chunksWithEmbeddings.length });
            } catch (err) {
                console.error("Synapse Background Sync Error:", err);
                syncStatus = { done: true, count: 0, error: err.toString(), progress: null };
                broadcast("upload_error", { error: err.toString() });
            }
        })();
        return true;
    }

    if (request.action === 'retrieve_context') {
        if (!supabase) return sendResponse({success: false, error: "Supabase not configured"});
        
        (async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) throw new Error("Please log in to retrieve memory");
                
                if (!request.session_id) {
                    throw new Error("No session ID provided for retrieval");
                }
                
                // Fetch all chunks for this session
                const { data: sessionChunks, error: fetchErr } = await supabase
                    .from('chunks')
                    .select('content, embedding')
                    .eq('user_id', user.id)
                    .eq('session_id', request.session_id);
                
                if (fetchErr) throw fetchErr;
                if (!sessionChunks || sessionChunks.length === 0) throw new Error("No memory found for this session");

                // --- HYBRID RETRIEVAL: Centroid + Caveman ---
                
                // 1. Calculate CENTROID (Project Essence)
                let centroid = new Array(384).fill(0);
                let validEmbeddings = 0;
                for (let row of sessionChunks) {
                    if (row.embedding) {
                        let emb = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
                        for (let i = 0; i < centroid.length; i++) centroid[i] += emb[i];
                        validEmbeddings++;
                    }
                }
                if (validEmbeddings > 0) {
                    for (let i = 0; i < centroid.length; i++) centroid[i] /= validEmbeddings;
                }

                // Determine mode based on prompt presence
                let hasPrompt = request.prompt && request.prompt.trim().length > 2;

                let finalContext = "";

                if (!hasPrompt) {
                    // IF NO PROMPT: Exactly replicate VS Code's RAW_MEMORY.md (Grounded Context) behavior
                    // 1. We already have the Centroid computed from sessionChunks.
                    
                    // 2. Fetch the top matches using match_chunks RPC exactly like VS Code
                    const { data: matchedChunks, error: matchErr } = await supabase.rpc('match_chunks', {
                        query_embedding: centroid,
                        match_threshold: 0.3,
                        match_count: 20,
                        p_user_id: user.id
                    });

                    let chunksToUse = sessionChunks;
                    if (!matchErr && matchedChunks && matchedChunks.length > 0) {
                        const sessionSpecific = matchedChunks.filter(c => c.session_id === request.session_id);
                        chunksToUse = sessionSpecific.length > 0 ? sessionSpecific : matchedChunks.slice(0, 10);
                    }

                    // 3. Apply 3000 character hard cap budget
                    let selectedTexts = [];
                    let totalChars = 0;
                    const BUDGET = 3000;

                    for (const row of chunksToUse) {
                        const decryptedContent = await decryptText(row.content);
                        if (selectedTexts.length >= 1 && totalChars + decryptedContent.length > BUDGET) {
                            break;
                        }
                        selectedTexts.push(decryptedContent);
                        totalChars += decryptedContent.length;
                    }

                    const rawContext = selectedTexts.join('\n---\n');
                    finalContext = compressContext(rawContext);
                    
                    // Apply hard trim if it still exceeds budget
                    if (finalContext.length > BUDGET) {
                        const cutIndex = finalContext.lastIndexOf('\n', BUDGET);
                        const safeIndex = cutIndex > 2000 ? cutIndex : BUDGET;
                        finalContext = finalContext.substring(0, safeIndex).trim();
                    }

                } else {
                    // IF PROMPT: Hybrid Mode (2 Centroid + 3 Prompt-Relevant)
                    let centroidRanked = [];
                    for (let row of sessionChunks) {
                        const decryptedContent = await decryptText(row.content);
                        let similarity = 0;
                        if (row.embedding) {
                            let emb = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
                            for (let i = 0; i < centroid.length; i++) similarity += centroid[i] * emb[i];
                        }
                        
                        const isStructured = /:\n|\n-|\n\*|```|^[A-Z][a-z\s]+:/m.test(decryptedContent);
                        if (isStructured) similarity *= 1.3; 
                        
                        centroidRanked.push({ content: decryptedContent, score: similarity });
                    }
                    centroidRanked.sort((a, b) => b.score - a.score);
                    
                    const projectSoul = centroidRanked.slice(0, 2).map(r => r.content).join('\n---\n');
                    
                    let queryEmbedding = await getEmbedding(request.prompt);
                    let cavemanRanked = [];
                    for (let row of sessionChunks) {
                        const decryptedContent = await decryptText(row.content);
                        let similarity = 0;
                        if (row.embedding) {
                            let emb = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
                            for (let i = 0; i < queryEmbedding.length; i++) similarity += queryEmbedding[i] * emb[i];
                        }
                        
                        const isStructured = /:\n|\n-|\n\*|```|^[A-Z][a-z\s]+:/m.test(decryptedContent);
                        if (isStructured) similarity *= 1.3;
                        
                        cavemanRanked.push({ content: decryptedContent, score: similarity });
                    }
                    cavemanRanked.sort((a, b) => b.score - a.score);
                    
                    const soulSet = new Set(centroidRanked.slice(0, 2).map(r => r.content));
                    const filteredCaveman = cavemanRanked.filter(r => !soulSet.has(r.content)).slice(0, 3);
                    const relevantContext = filteredCaveman.map(r => r.content).join('\n---\n');

                    // Run the entire hybrid block through Caveman compression to save tokens
                    finalContext = compressContext(`${projectSoul}\n\n${relevantContext}`);
                }
                
                sendResponse({success: true, data: { context: finalContext }});
            } catch (err) {
                console.error(err);
                sendResponse({success: false, error: err.toString()});
            }
        })();
        return true;
    }

    if (request.action === 'fetch_sessions') {
        if (!supabase) return sendResponse({success: false, error: "Supabase not configured"});
        (async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) return sendResponse({success: true, sessions: []});
                
                const { data, error } = await supabase
                    .from('chunks')
                    .select('session_id, session_title, created_at')
                    .eq('user_id', user.id)
                    .order('created_at', { ascending: false });
                
                if (error) throw error;
                
                const seen = new Set();
                const sessions = [];
                for (let row of data) {
                    if (!seen.has(row.session_id)) {
                        seen.add(row.session_id);
                        const decryptedTitle = await decryptText(row.session_title);
                        sessions.push({ id: row.session_id, title: decryptedTitle });
                    }
                }
                sendResponse({success: true, data: { sessions }});
            } catch (err) {
                console.error(err);
                sendResponse({success: false, error: err.toString()});
            }
        })();
        return true;
    }

    if (request.action === 'delete_session') {
        if (!supabase) return sendResponse({success: false, error: "Supabase not configured"});
        (async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) throw new Error("Not authenticated");
                
                const { error } = await supabase
                    .from('chunks')
                    .delete()
                    .eq('user_id', user.id)
                    .eq('session_id', request.session_id);
                
                if (error) throw error;
                
                broadcast("refresh_sessions");
                sendResponse({success: true});
            } catch (err) {
                console.error(err);
                sendResponse({success: false, error: err.toString()});
            }
        })();
        return true;
    }

    return false;
});
