import * as vscode from 'vscode';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { SynapseCrypto } from './crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class OllamaManager {
    static async checkConnection(url: string): Promise<boolean> {
        try {
            await axios.get(`${url}/api/tags`, { timeout: 2000 });
            return true;
        } catch {
            return false;
        }
    }

    static async checkModel(url: string, model: string): Promise<boolean> {
        try {
            const response = await axios.get(`${url}/api/tags`);
            const models = response.data.models || [];
            return models.some((m: any) => m.name.includes(model));
        } catch {
            return false;
        }
    }

    static async installOllama(): Promise<void> {
        const choice = await vscode.window.showInformationMessage(
            "Synapse: Ollama is not installed. (Tip: You can store models on your D: drive to save space!)",
            "Install via Winget", "Set Model Path (D: Drive)", "Download Manually"
        );

        if (choice === "Install via Winget") {
            const terminal = vscode.window.createTerminal("Synapse Setup");
            terminal.show();
            terminal.sendText("winget install ollama");
            vscode.window.showInformationMessage("Synapse: Installing... Once done, please restart VS Code.");
        } else if (choice === "Set Model Path (D: Drive)") {
            const path = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: "Select Folder for Models (e.g. D:\\Ollama)"
            });
            if (path && path[0]) {
                const terminal = vscode.window.createTerminal("Synapse Config");
                terminal.show();
                // Set the user environment variable OLLAMA_MODELS
                terminal.sendText(`[System.Environment]::SetEnvironmentVariable("OLLAMA_MODELS", "${path[0].fsPath}", "User")`);
                vscode.window.showInformationMessage(`Synapse: Model storage path set to ${path[0].fsPath}. Please restart Ollama for it to take effect.`);
                
                // Show the installation options again!
                return await this.installOllama();
            }
        } else if (choice === "Download Manually") {
            vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
        }
    }

    static async pullModel(url: string, model: string) {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Synapse: Pulling model ${model}...`,
            cancellable: false
        }, async (progress) => {
            try {
                // Use the API to pull the model so we don't care about PATH
                await axios.post(`${url}/api/pull`, { name: model, stream: false });
                
                vscode.window.showInformationMessage(`Synapse: Model ${model} is ready!`);
                return true;
            } catch (err: any) {
                vscode.window.showErrorMessage(`Synapse Pull Error: ${err.message}`);
                return false;
            }
        });
    }

    static async ensureReady(url: string, model: string): Promise<boolean> {
        const isRunning = await this.checkConnection(url);
        if (!isRunning) {
            await this.installOllama();
            return false;
        }

        const hasModel = await this.checkModel(url, model);
        if (!hasModel) {
            const pull = await vscode.window.showWarningMessage(
                `Synapse: Model '${model}' is missing. Pull it now?`,
                "Yes, Pull Model"
            );
            if (pull === "Yes, Pull Model") {
                return await this.pullModel(url, model);
            }
            return false;
        }

        return true;
    }
}

// PORTED FROM CHROME EXTENSION: Regex-based high-density compression
function compressContext(text: string): string {
    let codeBlocks: string[] = [];
    
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

    // Collapse spaces and dedup lines
    text = text.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    
    let result = text.trim();
    // Restore code blocks
    for (let i = 0; i < codeBlocks.length; i++) {
        result = result.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
    }
    
    return result;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Synapse Bridge is active');

    const sessionProvider = new SynapseSessionProvider(context);
    vscode.window.registerTreeDataProvider('synapse-sessions', sessionProvider);

    // Focus Sync: Auto-refresh the sidebar whenever the user switches back to VS Code
    context.subscriptions.push(vscode.window.onDidChangeWindowState(e => {
        if (e.focused) {
            sessionProvider.refresh();
        }
    }));

    // Register URI Handler for OAuth Redirects
    const uriHandler = new SynapseUriHandler(context, sessionProvider);
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    // Command: Login to Cloud
    context.subscriptions.push(vscode.commands.registerCommand('synapse.login', async () => {
        const method = await vscode.window.showQuickPick(['Login with Google', 'Login with GitHub'], {
            placeHolder: 'Select your login method'
        });

        if (!method) return;

        const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
        const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');

        if (!supabaseUrl || !supabaseKey) {
            vscode.window.showErrorMessage('Synapse: Please configure Supabase URL and Key in settings first.');
            return;
        }

        if (method === 'Login with GitHub' || method === 'Login with Google') {
            const provider = method === 'Login with Google' ? 'google' : 'github';
            const http = require('http');
            const url = require('url');

            // Start a temporary local server to catch the redirect
            const server = http.createServer(async (req: any, res: any) => {
                const reqUrl = url.parse(req.url, true);
                
                // Supabase sends token in the hash/fragment, but we can catch it via a small HTML/JS bridge
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                        <head>
                            <style>
                                @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                                body { 
                                    font-family: -apple-system, system-ui, sans-serif; 
                                    background: #050505; 
                                    color: white; 
                                    display: flex; 
                                    align-items: center; 
                                    justify-content: center; 
                                    height: 100vh; 
                                    margin: 0; 
                                    overflow: hidden;
                                }
                                .card {
                                    background: rgba(255, 255, 255, 0.03);
                                    backdrop-filter: blur(20px);
                                    border: 1px solid rgba(255, 255, 255, 0.1);
                                    padding: 40px;
                                    border-radius: 24px;
                                    text-align: center;
                                    width: 320px;
                                    animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                                    box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                                }
                                .icon { 
                                    font-size: 48px; 
                                    margin-bottom: 24px; 
                                    display: inline-block;
                                    filter: drop-shadow(0 0 15px rgba(255,255,255,0.3));
                                }
                                h1 { font-size: 20px; margin: 0 0 8px 0; font-weight: 600; letter-spacing: -0.5px; }
                                p { font-size: 14px; color: rgba(255,255,255,0.5); margin: 0 0 32px 0; line-height: 1.5; }
                                .btn-back {
                                    font-size: 13px;
                                    color: #fff;
                                    text-decoration: none;
                                    background: rgba(255,255,255,0.1);
                                    padding: 10px 20px;
                                    border-radius: 12px;
                                    transition: background 0.2s;
                                }
                                .btn-back:hover { background: rgba(255,255,255,0.2); }
                            </style>
                        </head>
                        <body>
                            <div class="card">
                                <div class="icon">&#8734;</div>
                                <h1>Identity Verified</h1>
                                <p>Synapse is now linked.<br>You can safely return to VS Code.</p>
                                <div style="margin-top: 10px;">
                                    <span style="font-size: 12px; color: rgba(255,255,255,0.3);">&#11013; Return to IDE</span>
                                </div>
                            </div>
                            <script>
                                const hash = window.location.hash;
                                if (hash) {
                                    fetch('/token?' + hash.substring(1)).then(() => {
                                        setTimeout(() => {
                                            document.querySelector('p').innerText = 'Connection closed. Close this tab.';
                                        }, 1000);
                                    });
                                }
                            </script>
                        </body>
                    </html>
                `);

                if (reqUrl.pathname === '/token') {
                    const accessToken = reqUrl.query.access_token;
                    if (accessToken) {
                        await context.secrets.store('synapse_access_token', accessToken as string);
                        vscode.window.showInformationMessage(`Synapse: ${method} Successful!`);
                        vscode.commands.executeCommand('setContext', 'synapse:isLoggedIn', true);
                        sessionProvider.refresh();
                        server.close();
                    }
                }
            });

            server.listen(54321, () => {
                const authUrl = `${supabaseUrl}/auth/v1/authorize?provider=${provider}&redirect_to=http://localhost:54321`;
                vscode.window.showInformationMessage(`Opening browser for ${method}...`);
                vscode.env.openExternal(vscode.Uri.parse(authUrl));
            });

            // Auto-close server after 2 minutes if no login
            setTimeout(() => server.close(), 120000);
            return;
        }

        if (method === 'Manual Access Token') {
            const projectUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl') || "";
            const projectId = projectUrl.split('.')[0].split('//')[1];
            
            // Generate a one-line script they can paste in the browser console
            const script = `copy(JSON.parse(localStorage.getItem('sb-${projectId}-auth-token')).access_token)`;

            const action = await vscode.window.showInformationMessage(
                'To get your token: Open your Supabase/ChatGPT tab, press F12, paste the Retrieval Script into the Console, and then paste the result here.',
                'Copy Retrieval Script'
            );

            if (action === 'Copy Retrieval Script') {
                await vscode.env.clipboard.writeText(script);
                vscode.window.showInformationMessage('Script copied! Paste it into your browser console.');
            }

            const token = await vscode.window.showInputBox({ 
                prompt: 'Paste the Access Token from your browser console',
                placeHolder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
            });
            if (!token) return;

            await context.secrets.store('synapse_access_token', token);
            vscode.window.showInformationMessage('Synapse: Authenticated via Token!');
            vscode.commands.executeCommand('setContext', 'synapse:isLoggedIn', true);
            sessionProvider.refresh();
            return;
        }

        const email = await vscode.window.showInputBox({ prompt: 'Enter your Synapse/Supabase Email' });
        if (!email) return;
        const password = await vscode.window.showInputBox({ prompt: 'Enter your Password', password: true });
        if (!password) return;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Synapse: Logging in...",
            cancellable: false
        }, async (progress) => {
            try {
                const supabase = createClient(supabaseUrl, supabaseKey);
                const { data, error } = await supabase.auth.signInWithPassword({ email, password });
                
                if (error) throw error;
                if (data.session) {
                    // Store the session token securely
                    await context.secrets.store('synapse_access_token', data.session.access_token);
                    vscode.window.showInformationMessage(`Synapse: Logged in as ${data.user?.email}`);
                    vscode.commands.executeCommand('setContext', 'synapse:isLoggedIn', true);
                    sessionProvider.refresh();
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Login failed: ${err.message}`);
            }
        });
    }));

    // Command: Logout
    context.subscriptions.push(vscode.commands.registerCommand('synapse.logout', async () => {
        await context.secrets.delete('synapse_access_token');
        vscode.commands.executeCommand('setContext', 'synapse:isLoggedIn', false);
        vscode.window.showInformationMessage('Synapse: Logged out successfully.');
        sessionProvider.refresh();
    }));

    // Helper to update login state
    async function updateLoginContext() {
        const token = await context.secrets.get('synapse_access_token');
        vscode.commands.executeCommand('setContext', 'synapse:isLoggedIn', !!token);
    }
    updateLoginContext();

    // Command: Sync Encryption Key
    context.subscriptions.push(vscode.commands.registerCommand('synapse.syncKey', async () => {
        const action = await vscode.window.showInformationMessage(
            'Synapse uses End-to-End Encryption. You must copy the Encryption Key from the Chrome Extension to decrypt your cloud memories.',
            'Enter Key Now', 'How to get key?'
        );

        if (action === 'How to get key?') {
            vscode.window.showInformationMessage('Open the Synapse Chrome extension popup. If you are logged in, click the key icon (🔑) next to your email to copy it to your clipboard.');
            return;
        }

        if (action === 'Enter Key Now') {
            const key = await vscode.window.showInputBox({
                prompt: 'Paste your Synapse Encryption Key (copied from the Chrome extension)',
                password: true
            });
            if (key) {
                await context.secrets.store('synapse_aes_key', key);
                vscode.window.showInformationMessage('Synapse: Encryption key synced successfully! Your memories are now decrypted locally.');
                sessionProvider.refresh();
            }
        }
    }));

    // Command: Select Model
    context.subscriptions.push(vscode.commands.registerCommand('synapse.selectModel', async () => {
        const ollamaUrl = vscode.workspace.getConfiguration('synapse').get<string>('ollamaUrl') || 'http://localhost:11434';
        
        let availableModels: string[] = [];
        try {
            const response = await axios.get(`${ollamaUrl}/api/tags`);
            availableModels = (response.data.models || []).map((m: any) => m.name);
        } catch {
            // Ignore if ollama isn't running
        }

        const items = availableModels.map(m => ({ label: m }));
        items.push({ label: '$(add) Enter custom model name (will pull)' });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select an Ollama model to use for Synapse memory refinement'
        });

        if (!selected) return;

        let finalModel = selected.label;
        if (selected.label.includes('Enter custom model')) {
            const typed = await vscode.window.showInputBox({
                prompt: 'Enter the exact Ollama model name (e.g., mistral, llama3, qwen2:0.5b)'
            });
            if (!typed) return;
            finalModel = typed;
        }

        await vscode.workspace.getConfiguration('synapse').update('ollamaModel', finalModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Synapse: Active model updated to '${finalModel}'!`);
    }));

    // Command: Fetch Smart Context
    context.subscriptions.push(vscode.commands.registerCommand('synapse.fetchContext', async (item?: SessionItem) => {
        const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
        const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');
        const aesKey = await context.secrets.get('synapse_aes_key');

        if (!supabaseUrl || !supabaseKey || !aesKey) {
            vscode.window.showErrorMessage('Synapse: Please configure Supabase and Sync your Encryption Key first.');
            return;
        }

        const sessionId = item?.sessionId || await vscode.window.showInputBox({ prompt: 'Enter Session ID' });
        if (!sessionId) return;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Synapse: Refining Context...",
            cancellable: true
        }, async (progress, token) => {
            try {
                const abortController = new AbortController();
                token.onCancellationRequested(() => abortController.abort());

                const supabase = createClient(supabaseUrl, supabaseKey);
                
                // 1. Fetch Hybrid Context (First 25 for Vision, Last 50 for Progress)
                const { data: firstChunks, error: e1 } = await supabase
                    .from('chunks')
                    .select('content')
                    .eq('session_id', sessionId)
                    .order('id', { ascending: true })
                    .limit(25);
                
                const { data: lastChunks, error: e2 } = await supabase
                    .from('chunks')
                    .select('content')
                    .eq('session_id', sessionId)
                    .order('id', { ascending: false })
                    .limit(50);

                const chunks = [...(firstChunks || []), ...(lastChunks || []).reverse()];

                if (e1 || e2) throw (e1 || e2);
                if (!chunks || chunks.length === 0) {
                    vscode.window.showWarningMessage('No memory found for this session.');
                    return;
                }

                // 2. Decrypt locally
                const decryptedChunks = await Promise.all(
                    chunks.map(c => SynapseCrypto.decrypt(c.content, aesKey))
                );
                const rawContext = decryptedChunks.join('\n---\n');

                const ollamaUrl = vscode.workspace.getConfiguration('synapse').get<string>('ollamaUrl') || 'http://localhost:11434';
                const model = vscode.workspace.getConfiguration('synapse').get<string>('ollamaModel') || 'qwen2:0.5b';

                if (!(await OllamaManager.ensureReady(ollamaUrl, model))) return;

                const panel = vscode.window.createWebviewPanel(
                    'synapseContext',
                    `Synapse: ${item?.label || 'Context'}`,
                    vscode.ViewColumn.One,
                    { enableScripts: true }
                );
                panel.webview.html = getWebviewContent("");

                try {
                    const response = await axios.post(`${ollamaUrl}/api/generate`, {
                        model: model,
                        options: { 
                            temperature: 0.1,
                            num_thread: 4,
                            repeat_penalty: 1.2
                        }, 
                        prompt: `Extract the core technical vision, tech stack, constraints, data relationship and user linking strategy, and requirements from the context below.
                    
                    [BEGIN CONTEXT]
                    ${rawContext}
                    [END CONTEXT]

                    TASK: Provide a clean, raw summary of the project goals and technical details discussed. Do not invent features. Just state the facts from the context.`,
                        stream: true
                    }, { responseType: 'stream', signal: abortController.signal });

                    let fullText = "";
                    response.data.on('data', (chunk: Buffer) => {
                        const lines = chunk.toString().split('\n');
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const json = JSON.parse(line);
                                if (json.response) {
                                    fullText += json.response;
                                    panel.webview.postMessage({ command: 'update', text: fullText });
                                }
                            } catch (e) {}
                        }
                    });
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Streaming Error: ${err.message}`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Synapse Context Error: ${err.message}`);
            }
        });
    }));

    // Command: Generate Memory File (.md)
    context.subscriptions.push(vscode.commands.registerCommand('synapse.generateMemoryFile', async (item?: SessionItem) => {
        const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
        const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');
        const aesKey = await context.secrets.get('synapse_aes_key');

        if (!supabaseUrl || !supabaseKey || !aesKey) {
            vscode.window.showErrorMessage('Synapse: Please configure Supabase and Sync your Encryption Key first.');
            return;
        }

        const sessionId = item?.sessionId || await vscode.window.showInputBox({ prompt: 'Enter Session ID' });
        if (!sessionId) return;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Synapse: Generating Memory File...",
            cancellable: true
        }, async (progress, token) => {
            try {
                const abortController = new AbortController();
                token.onCancellationRequested(() => abortController.abort());

                const supabase = createClient(supabaseUrl, supabaseKey);
                
                // 1. Fetch Hybrid Context (First 40 for Vision, Last 40 for Progress)
                const { data: firstChunks, error: e1 } = await supabase
                    .from('chunks')
                    .select('content')
                    .eq('session_id', sessionId)
                    .order('id', { ascending: true })
                    .limit(40);
                
                const { data: lastChunks, error: e2 } = await supabase
                    .from('chunks')
                    .select('content')
                    .eq('session_id', sessionId)
                    .order('id', { ascending: false })
                    .limit(40);

                const chunks = [...(firstChunks || []), ...(lastChunks || []).reverse()];
 
                if (e1 || e2) throw (e1 || e2);
                if (!chunks || chunks.length === 0) {
                    vscode.window.showWarningMessage('No memory found for this session.');
                    return;
                }

                const decryptedChunks = await Promise.all(
                    chunks.map(c => SynapseCrypto.decrypt(c.content, aesKey))
                );
                const rawContext = decryptedChunks.join('\n---\n');

                const ollamaUrl = vscode.workspace.getConfiguration('synapse').get<string>('ollamaUrl') || 'http://localhost:11434';
                const model = vscode.workspace.getConfiguration('synapse').get<string>('ollamaModel') || 'qwen2:0.5b';

                if (!(await OllamaManager.ensureReady(ollamaUrl, model))) return;

                progress.report({ message: `Mining ${chunks.length} chunks of memory...` });
                
                const masterPrompt = `[SYSTEM: YOU ARE ANTIGRAVITY - ACT AS A TECHNICAL ARCHITECT]
                    
                    TASK: Generate a high-density "Grounded Context" digest from the following history.
                    
                    [FORMATTING RULES]:
                    1. Wrap the entire output in [Context from Previous AI: ... ]
                    2. Use status markers: ✅ (Solved/Done), ⚙️ (In Progress/Medium), 🔥 (Critical/Hard).
                    3. Structure by: "Technical Vision", "Current Tech Stack", "Implementation Progress", and "Risks/Blockers".
                    4. Keep it dense. No filler. No "Here is a summary". Just facts.

                    [BEGIN CHAT HISTORY]
                    ${rawContext}
                    [END CHAT HISTORY]

                    Provide the digest now:`;

                const response = await axios.post(`${ollamaUrl}/api/generate`, {
                    model: model,
                    options: { 
                        temperature: 0.1,
                        num_thread: 4,
                        num_predict: 800
                    },
                    prompt: masterPrompt,
                    stream: false
                }, { signal: abortController.signal });

                const mdContent = response.data.response;
                const workspaceFolders = vscode.workspace.workspaceFolders;
                
                if (workspaceFolders) {
                    const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'MEMORY.md');
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(mdContent, 'utf8'));
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                    vscode.window.showInformationMessage('Synapse: AI MEMORY.md generated successfully!');
                } else {
                    vscode.window.showErrorMessage('Synapse: No workspace folder open.');
                }

            } catch (err: any) {
                vscode.window.showErrorMessage(`Synapse Error: ${err.message}`);
            }
        });
    }));

    // Command: Delete Memory
    context.subscriptions.push(vscode.commands.registerCommand('synapse.deleteSession', async (item?: SessionItem) => {
        const rawId = item?.sessionId || await vscode.window.showInputBox({ prompt: 'Enter Session ID to delete' });
        if (!rawId) return;

        const sessionId = rawId.trim();

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to permanently delete memory session "${item?.label || sessionId}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') return;

        // IRONCLAD OPTIMISTIC DELETE: 
        // Hide it from the UI immediately, before we even talk to the database.
        sessionProvider.blacklist(sessionId);
        
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Synapse: Deleting Memory...",
            cancellable: false
        }, async (progress) => {
            try {
                const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
                const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');
                const accessToken = await context.secrets.get('synapse_access_token');
                
                if (!supabaseUrl || !supabaseKey) throw new Error("Supabase not configured.");

                const supabase = createClient(supabaseUrl, supabaseKey, { 
                    global: { headers: { Authorization: `Bearer ${accessToken}` } } 
                });

                const { error } = await supabase
                    .from('chunks')
                    .delete()
                    .eq('session_id', sessionId);

                if (error) throw error;

                vscode.window.showInformationMessage(`Synapse: Memory ${sessionId} deleted successfully.`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
            }
        });
    }));

    // Command: Generate RAW Memory File (.md) - Instant Bypass
    context.subscriptions.push(vscode.commands.registerCommand('synapse.generateRawMemoryFile', async (item?: SessionItem) => {
        const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
        const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');
        const aesKey = await context.secrets.get('synapse_aes_key');

        if (!supabaseUrl || !supabaseKey || !aesKey) {
            vscode.window.showErrorMessage('Synapse: Please configure Supabase and Sync your Encryption Key first.');
            return;
        }

        const sessionId = item?.sessionId || await vscode.window.showInputBox({ prompt: 'Enter Session ID' });
        if (!sessionId) return;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Synapse: Retrieving Grounded Context...",
            cancellable: true
        }, async (progress, token) => {
            try {
                if (token.isCancellationRequested) throw new Error("Cancelled by user.");
                const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
                const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');
                const aesKey = await context.secrets.get('synapse_aes_key');
                const accessToken = await context.secrets.get('synapse_access_token');
                
                if (!supabaseUrl || !supabaseKey || !aesKey) {
                    throw new Error("Synapse not configured. Please check your settings and AES key.");
                }

                // Initialize with token if available, otherwise use Anon Key
                const supabase = accessToken 
                    ? createClient(supabaseUrl, supabaseKey, { global: { headers: { Authorization: `Bearer ${accessToken}` } } })
                    : createClient(supabaseUrl, supabaseKey);
                
                // 1. Get the official User ID
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) throw new Error("Please login to generate memory files.");
                const userId = user.id;

                // Fetch the most relevant technical chunks (Centroid Method)
                progress.report({ message: `Analyzing session ${sessionId}...` });
                
                if (token.isCancellationRequested) throw new Error("Cancelled by user.");

                // 2. Fetch all embeddings for this session (STRICT USER FILTER)
                const { data: allChunks, error: fetchErr } = await supabase
                    .from('chunks')
                    .select('embedding')
                    .eq('session_id', sessionId)
                    .eq('user_id', userId);
                
                if (fetchErr) throw fetchErr;
                if (!allChunks || allChunks.length === 0) throw new Error("No memory chunks found for this session under your account.");

                // 3. Compute Centroid (Average Embedding)
                const parsedEmbeddings = allChunks.map(c => typeof c.embedding === 'string' ? JSON.parse(c.embedding) : c.embedding);
                const dim = parsedEmbeddings[0].length;
                const centroid = new Array(dim).fill(0);
                for (const emb of parsedEmbeddings) {
                    for (let i = 0; i < dim; i++) {
                        centroid[i] += emb[i];
                    }
                }
                for (let i = 0; i < dim; i++) {
                    centroid[i] /= parsedEmbeddings.length;
                }

                // 4. Use Centroid to find the most "Representative" chunks (Semantic Search)
                if (token.isCancellationRequested) throw new Error("Cancelled by user.");
                
                const { data: matchedChunks, error: matchErr } = await supabase.rpc('match_chunks', {
                    query_embedding: centroid,
                    match_threshold: 0.3, 
                    match_count: 20,
                    p_user_id: userId // Pass the SECURE ID
                });

                if (matchErr) throw matchErr;
                
                // Filter to ONLY chunks from this specific session
                const sessionChunks = matchedChunks.filter((c: any) => c.session_id === sessionId);
                const chunks = sessionChunks.length > 0 ? sessionChunks : matchedChunks.slice(0, 10);

                const decryptedChunks = await Promise.all(chunks.map((c: any) => SynapseCrypto.decrypt(c.content, aesKey)));
                
                // Porting the Chrome extension's "Token Budgeting" logic
                let selectedTexts: string[] = [];
                let totalChars = 0;
                const BUDGET = 3000;

                for (const text of decryptedChunks) {
                    if (selectedTexts.length >= 1 && totalChars + text.length > BUDGET) {
                        break;
                    }
                    selectedTexts.push(text);
                    totalChars += text.length;
                }

                const rawContext = selectedTexts.join('\n---\n');
                let refinedContext = compressContext(rawContext);

                // Porting the Chrome extension's "Hard Cap" logic
                if (refinedContext.length > BUDGET) {
                    const cutIndex = refinedContext.lastIndexOf('\n', BUDGET);
                    const safeIndex = cutIndex > 2000 ? cutIndex : BUDGET;
                    refinedContext = refinedContext.substring(0, safeIndex).trim();
                }

                // Format EXACTLY like the Chrome extension's Grounded Context output
                const groundedContext = `[Context from Previous AI:\n${refinedContext}\n]`;

                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'RAW_MEMORY.md');
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(groundedContext, 'utf8'));
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                    vscode.window.showInformationMessage('Synapse: RAW_MEMORY.md (Grounded Context) generated!');
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Synapse Error: ${err.message}`);
            }
        });
    }));
}

class SynapseSessionProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SessionItem | undefined | void> = new vscode.EventEmitter<SessionItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SessionItem | undefined | void> = this._onDidChangeTreeData.event;
    
    // Ironclad Blacklist: IDs we've deleted so they never show up again even if DB is slow
    private deletedSessionIds: Set<string> = new Set();

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    blacklist(sessionId: string) {
        this.deletedSessionIds.add(sessionId);
        this.refresh();
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionItem): Promise<SessionItem[]> {
        if (element) return [];

        const supabaseUrl = vscode.workspace.getConfiguration('synapse').get<string>('supabaseUrl');
        const supabaseKey = vscode.workspace.getConfiguration('synapse').get<string>('supabaseKey');
        const aesKey = await this.context.secrets.get('synapse_aes_key');
        const accessToken = await this.context.secrets.get('synapse_access_token');

        if (!supabaseUrl || !supabaseKey) {
            return [new SessionItem("Setup Supabase URL/Key in Settings", "", vscode.TreeItemCollapsibleState.None)];
        }

        // --- SECURITY GATE ---
        if (!accessToken) {
            return [
                new SessionItem("🔒 Cloud Memory Locked", "", vscode.TreeItemCollapsibleState.None),
                new SessionItem("Please Login to secure your data", "login_prompt", vscode.TreeItemCollapsibleState.None)
            ];
        }

        if (!aesKey) {
            return [new SessionItem("Sync Encryption Key First", "", vscode.TreeItemCollapsibleState.None)];
        }

        try {
            const supabase = createClient(supabaseUrl, supabaseKey, { global: { headers: { Authorization: `Bearer ${accessToken}` } } });

            // 1. Get the current user ID to ensure isolation
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error("User session expired. Please login again.");

            // 2. Fetch sessions ONLY for this user
            const { data, error } = await supabase
                .from('chunks')
                .select('session_id, session_title, created_at')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) {
                console.error("Synapse Fetch Error:", error);
                return [new SessionItem(`Database Error: ${error.message}`, "", vscode.TreeItemCollapsibleState.None)];
            }

            if (!data || data.length === 0) {
                return [new SessionItem("No memories found in cloud", "", vscode.TreeItemCollapsibleState.None)];
            }

            const seen = new Set();
            const items: SessionItem[] = [];
            for (const row of data) {
                // IRONCLAD FILTER: Trim and check the blacklist
                const sid = row.session_id.trim();
                if (this.deletedSessionIds.has(sid)) {
                    console.log(`Synapse: Hiding blacklisted session ${sid}`);
                    continue;
                }

                if (!seen.has(sid)) {
                    seen.add(sid);
                    try {
                        const title = await SynapseCrypto.decrypt(row.session_title, aesKey);
                        items.push(new SessionItem(title, sid, vscode.TreeItemCollapsibleState.None));
                    } catch (e) {
                        items.push(new SessionItem("Decryption Failed (Wrong Key?)", sid, vscode.TreeItemCollapsibleState.None));
                    }
                }
            }

            if (items.length === 0) {
                 return [new SessionItem("No memories found in cloud", "", vscode.TreeItemCollapsibleState.None)];
            }

            return items;
        } catch (e: any) {
            return [new SessionItem(`Error: ${e.message}`, "", vscode.TreeItemCollapsibleState.None)];
        }
    }
}

class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly sessionId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = `Session: ${this.sessionId}`;
        this.contextValue = 'session';
        this.iconPath = new vscode.ThemeIcon('history');
        
        // Default action when clicking: Generate the RAW (.md) file instantly
        this.command = {
            command: 'synapse.generateRawMemoryFile',
            title: 'Generate Raw Memory File',
            arguments: [this]
        };
    }
}

function getWebviewContent(initialText: string): string {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; line-height: 1.6; background: #1e1e1e; color: #d4d4d4; }
                pre { background: #252526; padding: 15px; border-radius: 8px; border: 1px solid #3c3c3c; white-space: pre-wrap; word-wrap: break-word; font-size: 13px; }
                h1 { color: #4F46E5; border-bottom: 1px solid #3c3c3c; padding-bottom: 10px; margin-top: 0; }
                .copy-btn { 
                    background: #4F46E5; color: white; border: none; padding: 10px 20px; 
                    border-radius: 4px; cursor: pointer; margin-bottom: 20px; font-weight: bold;
                }
                .copy-btn:hover { background: #4338ca; }
                .status { font-size: 12px; color: #888; margin-bottom: 10px; }
            </style>
        </head>
        <body>
            <h1>Grounded Prompt Context</h1>
            <button class="copy-btn" onclick="copy()">Copy to Clipboard</button>
            <div id="status" class="status">Streaming from Ollama...</div>
            <pre id="content">${initialText}</pre>
            <script>
                const vscode = acquireVsCodeApi();
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'update') {
                        document.getElementById('content').innerText = message.text;
                        window.scrollTo(0, document.body.scrollHeight);
                        if (message.done) {
                            document.getElementById('status').innerText = 'Sync Complete';
                        }
                    }
                });
                function copy() {
                    const text = document.getElementById('content').innerText;
                    navigator.clipboard.writeText(text);
                    const btn = document.querySelector('.copy-btn');
                    btn.innerText = 'Copied!';
                    setTimeout(() => btn.innerText = 'Copy to Clipboard', 2000);
                }
            </script>
        </body>
        </html>
    `;
}

/**
 * Handles vscode://geervan.synapse-bridge/auth redirects for OAuth
 */
class SynapseUriHandler implements vscode.UriHandler {
    constructor(private context: vscode.ExtensionContext, private provider: SynapseSessionProvider) {}

    async handleUri(uri: vscode.Uri) {
        if (uri.path === '/auth') {
            const fragment = uri.fragment;
            const params = new URLSearchParams(fragment);
            const accessToken = params.get('access_token');
            
            if (accessToken) {
                await this.context.secrets.store('synapse_access_token', accessToken);
                vscode.window.showInformationMessage('Synapse: One-Click Login Successful!');
                this.provider.refresh();
            } else {
                vscode.window.showErrorMessage('Synapse: Login failed. No token received.');
            }
        }
    }
}
